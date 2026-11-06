import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	createPublicClient, encodeFunctionData, getAddress, http, keccak256, toHex,
	type Hex,
} from 'viem';
import publicDeployment from '../../../../shared/src/config/phase3-testnet-v2-public.json';
import type { Phase3TestnetRelayPlan } from '../../../../shared/src/types/learningBridge';
import { OfficialTbcApiProofSource, TbcScanProofSource } from '../phase1/tbc-proof.sources';
import { serializeBlockHeader } from '../phase1/tbc-proof.crypto';
import {
	buildTbcdevBootstrapCommitmentV2,
	decodeTbcdevBootstrapContextV2,
	tbcdevBootstrapProofV2,
} from './bootstrap-history-v2';

const DEFAULT_RPC = 'https://rpc.hyperliquid-testnet.xyz/evm';
const EXPECTED_RELAY_CODEHASH =
	'0xd1f41cc0a3cbe5542525f448c484c456eeaa40089c3d0eb5a919785c22523ece';

const relayAbi = [
	{ type: 'function', name: 'bestTip', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
	{ type: 'function', name: 'bestWorkTie', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
	{
		type: 'function', name: 'header', stateMutability: 'view',
		inputs: [{ name: 'blockHash', type: 'bytes32' }],
		outputs: [{
			type: 'tuple', components: [
				{ name: 'parentHash', type: 'bytes32' },
				{ name: 'merkleRoot', type: 'bytes32' },
				{ name: 'skipHash', type: 'bytes32' },
				{ name: 'chainWork', type: 'uint256' },
				{ name: 'height', type: 'uint32' },
				{ name: 'time', type: 'uint32' },
				{ name: 'bits', type: 'uint32' },
				{ name: 'exists', type: 'bool' },
			],
		}],
	},
	{
		type: 'function', name: 'submitHeader', stateMutability: 'nonpayable',
		inputs: [
			{ name: 'rawHeader', type: 'bytes' },
			{
				name: 'witnesses', type: 'tuple[]', components: [
					{
						name: 'point', type: 'tuple', components: [
							{ name: 'height', type: 'uint32' },
							{ name: 'blockHash', type: 'bytes32' },
							{ name: 'time', type: 'uint32' },
							{ name: 'bits', type: 'uint32' },
							{ name: 'chainWork', type: 'uint256' },
						],
					},
					{ name: 'siblings', type: 'bytes32[]' },
				],
			},
		],
		outputs: [{ name: 'blockHash', type: 'bytes32' }],
	},
] as const;

interface HeaderNode {
	parentHash: Hex;
	merkleRoot: Hex;
	skipHash: Hex;
	chainWork: bigint;
	height: number;
	time: number;
	bits: number;
	exists: boolean;
}

function requiredDifficultyHeights(previousHeight: number) {
	return [
		previousHeight - 8_064,
		previousHeight - 146,
		previousHeight - 145,
		previousHeight - 144,
		...Array.from({ length: 23 }, (_, index) => previousHeight - 22 + index),
	];
}

async function bootstrapWitnesses(previousHeight: number) {
	const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');
	const manifest = JSON.parse(await readFile(
		resolve(fixtureRoot, 'tbcdev-bootstrap-history-v2.json'), 'utf8',
	)) as { binaryFile: string; commitmentRoot: Hex };
	const points = decodeTbcdevBootstrapContextV2(await readFile(resolve(fixtureRoot, manifest.binaryFile)));
	const commitment = buildTbcdevBootstrapCommitmentV2(points);
	if (commitment.root.toLowerCase() !== manifest.commitmentRoot.toLowerCase()) {
		throw new Error('Local bootstrap binary does not reproduce the frozen commitment root.');
	}
	const indexed = new Map(points.map((point) => [point.height, point]));
	return requiredDifficultyHeights(previousHeight)
		.filter((height) => height < publicDeployment.checkpoint.height)
		.map((height) => {
			const point = indexed.get(height);
			if (!point) throw new Error(`Bootstrap point ${height} is unavailable.`);
			return {
				point: {
					height: point.height,
					blockHash: `0x${point.blockHash}` as Hex,
					time: point.time,
					bits: point.bits,
					chainWork: point.chainWork,
				},
				siblings: tbcdevBootstrapProofV2(commitment, height),
			};
		});
}

export async function preparePhase3TestnetRelayPlan(
	fromValue: string,
	rpcUrl = DEFAULT_RPC,
): Promise<Phase3TestnetRelayPlan> {
	const relay = getAddress(publicDeployment.contracts.relay);
	const from = getAddress(fromValue);
	const client = createPublicClient({ transport: http(rpcUrl) });
	const [code, bestTip, bestWorkTie, gasPrice, block, balance, nonce] = await Promise.all([
		client.getCode({ address: relay }),
		client.readContract({ address: relay, abi: relayAbi, functionName: 'bestTip' }),
		client.readContract({ address: relay, abi: relayAbi, functionName: 'bestWorkTie' }),
		client.getGasPrice(),
		client.getBlock({ blockTag: 'latest' }),
		client.getBalance({ address: from, blockTag: 'pending' }),
		client.getTransactionCount({ address: from, blockTag: 'pending' }),
	]);
	if (!code || keccak256(code).toLowerCase() !== EXPECTED_RELAY_CODEHASH) {
		throw new Error('Relay runtime codehash differs from the pinned Testnet-v2 build.');
	}
	if (bestWorkTie) throw new Error('Relay currently has an equal-work tie; refuse to plan from an ambiguous tip.');
	const parentValue = await client.readContract({
		address: relay, abi: relayAbi, functionName: 'header', args: [bestTip],
	}) as HeaderNode;
	const parent = {
		parentHash: parentValue.parentHash,
		merkleRoot: parentValue.merkleRoot,
		skipHash: parentValue.skipHash,
		chainWork: parentValue.chainWork,
		height: Number(parentValue.height),
		time: Number(parentValue.time),
		bits: Number(parentValue.bits),
		exists: parentValue.exists,
	};
	if (!parent.exists || parent.height < publicDeployment.checkpoint.height) {
		throw new Error('Relay best tip is invalid.');
	}

	const targetHeight = parent.height + 1;
	const [officialBlock, scanBlock] = await Promise.all([
		new OfficialTbcApiProofSource().readBlock(targetHeight),
		new TbcScanProofSource().readBlock(targetHeight),
	]);
	if (JSON.stringify(officialBlock) !== JSON.stringify(scanBlock)) {
		throw new Error(`Official API and TBCScan disagree on block ${targetHeight}.`);
	}
	if (`0x${officialBlock.previousBlockHash}`.toLowerCase() !== bestTip.toLowerCase()) {
		throw new Error(`TBC block ${targetHeight} does not extend the relay best tip.`);
	}

	const witnesses = await bootstrapWitnesses(parent.height);
	const rawHeader = `0x${serializeBlockHeader(officialBlock).toString('hex')}` as Hex;
	const args = [rawHeader, witnesses] as const;
	const [simulation, estimatedGas] = await Promise.all([
		client.simulateContract({
			account: from, address: relay, abi: relayAbi, functionName: 'submitHeader', args,
		}),
		client.estimateContractGas({
			account: from, address: relay, abi: relayAbi, functionName: 'submitHeader', args,
		}),
	]);
	const bufferedGas = estimatedGas * 120n / 100n;
	const gas = bufferedGas > block.gasLimit ? block.gasLimit : bufferedGas;
	const maximumFee = gas * gasPrice;
	const data = encodeFunctionData({ abi: relayAbi, functionName: 'submitHeader', args });
	return {
		schema: 'learningmaterials/phase3-testnet-relay-plan/v1',
		createdAt: new Date().toISOString(),
		network: { tbc: 'testnet', hyperEvmChainId: 998 },
		relay,
		from,
		parent: { height: parent.height, hash: bestTip, chainWork: parent.chainWork.toString() },
		target: { height: targetHeight, hash: `0x${officialBlock.hash}` },
		crossCheckedSources: ['official-tbc-api', 'tbcscan-api'],
		witnessCount: witnesses.length,
		simulationResult: simulation.result,
		estimatedGas: estimatedGas.toString(),
		maximumFeeWei: maximumFee.toString(),
		balanceWei: balance.toString(),
		canCoverMaximumFee: balance >= maximumFee,
		transaction: {
			from,
			to: relay,
			chainId: '0x3e6',
			data,
			value: '0x0',
			gas: toHex(gas),
			gasPrice: toHex(gasPrice),
			nonce: toHex(nonce),
		},
		broadcast: false,
	};
}
