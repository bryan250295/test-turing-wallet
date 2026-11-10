import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, type Address, type Hex } from 'viem';
import candidate from '../../../../shared/src/config/phase3-testnet-v3-candidate.json';
import { LEARNING_BRIDGE_EVM } from '../../../../shared/src/config/learningBridge';
import { PHASE3_TESTNET_V3 } from '../../../../shared/src/config/phase3TestnetV3';
import { OfficialTbcApiProofSource, TbcScanProofSource } from '../phase1/tbc-proof.sources';
import { serializeBlockHeader } from '../phase1/tbc-proof.crypto';
import { buildTbcdevBootstrapCommitmentV3, decodeTbcdevBootstrapContextV3, tbcdevBootstrapProofV3 } from './bootstrap-history-v3';

export const testnetV3RelayAbi = [
	{ type: 'function', name: 'bestTip', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
	{ type: 'function', name: 'bestWorkTie', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
	{ type: 'function', name: 'isFinalized', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
	{ type: 'function', name: 'header', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
		{ name: 'parentHash', type: 'bytes32' }, { name: 'merkleRoot', type: 'bytes32' }, { name: 'skipHash', type: 'bytes32' },
		{ name: 'chainWork', type: 'uint256' }, { name: 'height', type: 'uint32' }, { name: 'time', type: 'uint32' },
		{ name: 'bits', type: 'uint32' }, { name: 'exists', type: 'bool' },
	] }] },
	{ type: 'function', name: 'submitHeader', stateMutability: 'nonpayable', inputs: [
		{ name: 'rawHeader', type: 'bytes' }, { name: 'witnesses', type: 'tuple[]', components: [
			{ name: 'point', type: 'tuple', components: [{ name: 'height', type: 'uint32' }, { name: 'blockHash', type: 'bytes32' }, { name: 'time', type: 'uint32' }, { name: 'bits', type: 'uint32' }, { name: 'chainWork', type: 'uint256' }] },
			{ name: 'siblings', type: 'bytes32[]' },
		] },
	], outputs: [{ type: 'bytes32' }] },
] as const;

let bootstrapPromise: ReturnType<typeof loadBootstrap> | undefined;
async function loadBootstrap() {
	const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');
	const encoded = await readFile(resolve(fixtureRoot, candidate.bootstrap.binaryFile));
	const points = decodeTbcdevBootstrapContextV3(encoded, candidate.bootstrap.startHeight);
	const commitment = buildTbcdevBootstrapCommitmentV3(points, candidate.checkpoint.hash);
	if (commitment.root.toLowerCase() !== candidate.bootstrap.commitmentRoot.toLowerCase()) throw new Error('V3 bootstrap fixture does not reproduce its frozen root.');
	return { commitment, byHeight: new Map(points.map((point) => [point.height, point])) };
}

function requiredHeights(previousHeight: number) {
	return [previousHeight - 8_064, previousHeight - 146, previousHeight - 145, previousHeight - 144, ...Array.from({ length: 23 }, (_, index) => previousHeight - 22 + index)];
}

export async function prepareV3HeaderTransaction(relayValue: string, account: Address) {
	const relay = getAddress(relayValue);
	const client = createPublicClient({ transport: http(LEARNING_BRIDGE_EVM.rpcUrl, { retryCount: 1, timeout: 20_000 }) });
	const [code, bestTip, tie] = await Promise.all([
		client.getCode({ address: relay }), client.readContract({ address: relay, abi: testnetV3RelayAbi, functionName: 'bestTip' }),
		client.readContract({ address: relay, abi: testnetV3RelayAbi, functionName: 'bestWorkTie' }),
	]);
	if (!code || keccak256(code).toLowerCase() !== PHASE3_TESTNET_V3.relayRuntimeCodeHash) throw new Error('Registered V3 Relay runtime mismatch.');
	if (tie) throw new Error('V3 Relay has an equal-work tie and fails closed.');
	const parent = await client.readContract({ address: relay, abi: testnetV3RelayAbi, functionName: 'header', args: [bestTip] });
	if (!parent.exists) throw new Error('V3 Relay best tip does not exist.');
	const targetHeight = Number(parent.height) + 1;
	const [official, scan] = await Promise.all([new OfficialTbcApiProofSource().readBlock(targetHeight), new TbcScanProofSource().readBlock(targetHeight)]);
	if (JSON.stringify(official) !== JSON.stringify(scan) || `0x${official.previousBlockHash}`.toLowerCase() !== bestTip.toLowerCase()) throw new Error(`TBC sources disagree on canonical child ${targetHeight}.`);
	const bootstrap = await (bootstrapPromise ??= loadBootstrap());
	const witnesses = requiredHeights(Number(parent.height)).filter((height) => height < candidate.checkpoint.height).map((height) => {
		const point = bootstrap.byHeight.get(height); if (!point) throw new Error(`Missing V3 bootstrap point ${height}.`);
		return { point: { height, blockHash: `0x${point.blockHash}` as Hex, time: point.time, bits: point.bits, chainWork: point.chainWork }, siblings: tbcdevBootstrapProofV3(bootstrap.commitment, height) };
	});
	const args = [`0x${serializeBlockHeader(official).toString('hex')}` as Hex, witnesses] as const;
	await client.simulateContract({ account, address: relay, abi: testnetV3RelayAbi, functionName: 'submitHeader', args });
	const gas = await client.estimateContractGas({ account, address: relay, abi: testnetV3RelayAbi, functionName: 'submitHeader', args });
	return { relay, parentHeight: Number(parent.height), targetHeight, targetHash: `0x${official.hash}` as Hex, data: encodeFunctionData({ abi: testnetV3RelayAbi, functionName: 'submitHeader', args }), gas };
}
