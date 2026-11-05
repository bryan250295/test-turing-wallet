import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	createPublicClient, encodeFunctionData, getAddress, http, keccak256,
	type Abi, type Hex,
} from 'viem';
import { OfficialTbcApiProofSource, TbcScanProofSource } from '../src/bridge/phase1/tbc-proof.sources';
import { serializeBlockHeader } from '../src/bridge/phase1/tbc-proof.crypto';
import {
	buildTbcdevBootstrapCommitmentV2,
	decodeTbcdevBootstrapContextV2,
	tbcdevBootstrapProofV2,
} from '../src/bridge/phase3/bootstrap-history-v2';

const DEFAULT_RPC = 'https://rpc.hyperliquid-testnet.xyz/evm';
const CHECKPOINT_HEIGHT = 840_039;
const EXPECTED_RELAY_CODEHASH =
	'0xd1f41cc0a3cbe5542525f448c484c456eeaa40089c3d0eb5a919785c22523ece';

interface Artifact { abi: Abi; deployedBytecode: Hex }
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

function argument(name: string) {
	const prefix = `--${name}=`;
	return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
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

async function main() {
	const relayValue = argument('relay');
	const fromValue = argument('from');
	if (!relayValue || !fromValue) {
		throw new Error('Usage: npm run phase3:testnet-relay-plan -- --relay=0x… --from=0x…');
	}
	const relay = getAddress(relayValue);
	const from = getAddress(fromValue);
	const rpcUrl = argument('rpc') ?? DEFAULT_RPC;
	const artifactRoot = resolve(process.cwd(), '../wallet/artifacts/phase3');
	const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');
	const artifact = JSON.parse(await readFile(
		resolve(artifactRoot, 'TbcHeaderRelayTestnetV2.json'), 'utf8',
	)) as Artifact;
	const manifest = JSON.parse(await readFile(
		resolve(fixtureRoot, 'tbcdev-bootstrap-history-v2.json'), 'utf8',
	)) as { binaryFile: string; commitmentRoot: Hex };
	const points = decodeTbcdevBootstrapContextV2(await readFile(
		resolve(fixtureRoot, manifest.binaryFile),
	));
	const commitment = buildTbcdevBootstrapCommitmentV2(points);
	if (commitment.root.toLowerCase() !== manifest.commitmentRoot.toLowerCase()) {
		throw new Error('Local bootstrap binary does not reproduce the frozen commitment root.');
	}

	const client = createPublicClient({ transport: http(rpcUrl) });
	const [code, bestTip, bestWorkTie, gasPrice, block, balance] = await Promise.all([
		client.getCode({ address: relay }),
		client.readContract({ address: relay, abi: artifact.abi, functionName: 'bestTip' }) as Promise<Hex>,
		client.readContract({ address: relay, abi: artifact.abi, functionName: 'bestWorkTie' }) as Promise<boolean>,
		client.getGasPrice(),
		client.getBlock({ blockTag: 'latest' }),
		client.getBalance({ address: from, blockTag: 'pending' }),
	]);
	if (!code || keccak256(code).toLowerCase() !== EXPECTED_RELAY_CODEHASH) {
		throw new Error('Relay runtime codehash differs from the pinned Testnet-v2 build.');
	}
	if (bestWorkTie) throw new Error('Relay currently has an equal-work tie; refuse to plan from an ambiguous tip.');
	const parentValue = await client.readContract({
		address: relay, abi: artifact.abi, functionName: 'header', args: [bestTip],
	}) as HeaderNode;
	const parent: HeaderNode = {
		parentHash: parentValue.parentHash,
		merkleRoot: parentValue.merkleRoot,
		skipHash: parentValue.skipHash,
		chainWork: parentValue.chainWork,
		height: Number(parentValue.height),
		time: Number(parentValue.time),
		bits: Number(parentValue.bits),
		exists: parentValue.exists,
	};
	if (!parent.exists || parent.height < CHECKPOINT_HEIGHT) throw new Error('Relay best tip is invalid.');

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

	const indexed = new Map(points.map((point) => [point.height, point]));
	const witnessHeights = requiredDifficultyHeights(parent.height)
		.filter((height) => height < CHECKPOINT_HEIGHT);
	const witnesses = witnessHeights.map((height) => {
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
	const rawHeader = `0x${serializeBlockHeader(officialBlock).toString('hex')}` as Hex;
	const args = [rawHeader, witnesses] as const;
	const [simulation, estimatedGas] = await Promise.all([
		client.simulateContract({
			account: from, address: relay, abi: artifact.abi,
			functionName: 'submitHeader', args,
		}),
		client.estimateContractGas({
			account: from, address: relay, abi: artifact.abi,
			functionName: 'submitHeader', args,
		}),
	]);
	const bufferedGas = estimatedGas * 120n / 100n;
	const gas = bufferedGas > block.gasLimit ? block.gasLimit : bufferedGas;
	const maximumFee = gas * gasPrice;
	const data = encodeFunctionData({
		abi: artifact.abi, functionName: 'submitHeader', args,
	});
	console.log(JSON.stringify({
		schema: 'learningmaterials/phase3-testnet-relay-plan/v1',
		createdAt: new Date().toISOString(),
		network: { tbc: 'testnet', hyperEvmChainId: 998, rpcUrl },
		relay,
		from,
		parent: { height: parent.height, hash: bestTip, chainWork: parent.chainWork.toString() },
		target: { height: targetHeight, hash: `0x${officialBlock.hash}` },
		crossCheckedSources: ['official-tbc-api', 'tbcscan-api'],
		witnessCount: witnesses.length,
		simulationResult: simulation.result,
		transaction: {
			to: relay,
			data,
			value: '0x0',
			estimatedGas: estimatedGas.toString(),
			gas: gas.toString(),
			gasPrice: gasPrice.toString(),
			maximumFeeWei: maximumFee.toString(),
		},
		account: {
			balanceWei: balance.toString(),
			canCoverMaximumFee: balance >= maximumFee,
		},
		broadcast: false,
	}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
