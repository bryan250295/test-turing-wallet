import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	decodeFunctionResult, encodeFunctionData, type Abi, type Hex,
} from 'viem';
import { blockWork, decodeCompactTarget } from '../src/bridge/phase1/tbc-consensus';
import { serializeBlockHeader } from '../src/bridge/phase1/tbc-proof.crypto';
import { REAL_MT_DAA_POINTS, REAL_MT_DEPOSIT_BLOCK } from '../src/bridge/phase1/tbc-test-vectors';
import type { TbcBlockRecord } from '../src/bridge/phase1/tbc-proof.types';
import {
	buildTbcdevBootstrapCommitment, decodeTbcdevBootstrapContext, tbcdevBootstrapProof,
} from '../src/bridge/phase3/bootstrap-history';

const RPC_URL = 'https://rpc.hyperliquid-testnet.xyz/evm';
const OVERRIDE_ADDRESS = '0x0000000000000000000000000000000000000333';

interface Artifact { abi: Abi; deployedBytecode: Hex }
interface BootstrapManifest { commitmentRoot: Hex; checkpointProof: Hex[]; binaryFile: string }
interface RpcResponse { result?: Hex; error?: { code: number; message: string; data?: unknown } }

const RELAY_HEADERS = [
	REAL_MT_DEPOSIT_BLOCK,
	{
		height: 839_166, hash: '0000000000000045f9d7756705e5099803897b6ae8ce99901a896ee98efec743',
		version: 536_969_216, previousBlockHash: REAL_MT_DEPOSIT_BLOCK.hash,
		merkleRoot: 'ffe05b155fcb2beafa32d8a6b6372b896787c6627dc4c1cbf88382854798f4c9',
		time: 1_793_341_941, bits: 0x1a041797, nonce: 150_516_801, transactionCount: 1,
	},
	{
		height: 839_167, hash: '0000000000000292b481584e7b48c3563e01d3290c662f1015e7e3d95e7fe7e2',
		version: 561_209_344, previousBlockHash: '0000000000000045f9d7756705e5099803897b6ae8ce99901a896ee98efec743',
		merkleRoot: '9a8f44f0aab66939b82dbdc59a4cbf4935bb804f6f5f725a76335c6bdbe0dab4',
		time: 1_793_342_454, bits: 0x1a04547e, nonce: 2_620_585_543, transactionCount: 1,
	},
	{
		height: 839_168, hash: '00000000000002a70e9760b18d569553bacd3562222dea8f8a23ebe2c1b1fef2',
		version: 556_187_648, previousBlockHash: '0000000000000292b481584e7b48c3563e01d3290c662f1015e7e3d95e7fe7e2',
		merkleRoot: 'a610ac97209e1db08aecf2dcffa08714ef729445d7ea75172a4afbe3fa1581b4',
		time: 1_793_344_027, bits: 0x1a044876, nonce: 2_344_092_997, transactionCount: 1,
	},
	{
		height: 839_169, hash: '00000000000000d19c642b2b1d8bdac8460416536250379e12641711d4fd2e07',
		version: 548_577_280, previousBlockHash: '00000000000002a70e9760b18d569553bacd3562222dea8f8a23ebe2c1b1fef2',
		merkleRoot: '40f3bc510b1edd8d4de47a155e0b5be8c442b099bae4727e486a1dde66902691',
		time: 1_793_344_324, bits: 0x1a043a50, nonce: 3_839_023_393, transactionCount: 2,
	},
	{
		height: 839_170, hash: '000000000000021ab587f5b6e54a172771a16c2cac4f753c9a0d57adb415f7b9',
		version: 562_413_568, previousBlockHash: '00000000000000d19c642b2b1d8bdac8460416536250379e12641711d4fd2e07',
		merkleRoot: 'e3c7e24d561f01a73c86df5c29fc2354642b35416e03a2beebe30341d424f42c',
		time: 1_793_347_382, bits: 0x1a045361, nonce: 2_551_534_348, transactionCount: 1,
	},
] as const satisfies readonly TbcBlockRecord[];

async function rpc(method: string, params: unknown[]) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await fetch(RPC_URL, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HyperEVM RPC returned HTTP ${response.status}.`);
		return await response.json() as RpcResponse;
	} finally { clearTimeout(timer); }
}

async function call(artifact: Artifact, functionName: string, args: readonly unknown[]) {
	const data = encodeFunctionData({ abi: artifact.abi, functionName, args });
	const response = await rpc('eth_call', [
		{ to: OVERRIDE_ADDRESS, data }, 'latest',
		{ [OVERRIDE_ADDRESS]: { code: artifact.deployedBytecode } },
	]);
	if (response.error || !response.result) throw new Error(`eth_call ${functionName} failed: ${JSON.stringify(response.error)}`);
	return decodeFunctionResult({ abi: artifact.abi, functionName, data: response.result });
}

async function expectRevert(artifact: Artifact, functionName: string, args: readonly unknown[]) {
	const data = encodeFunctionData({ abi: artifact.abi, functionName, args });
	const response = await rpc('eth_call', [
		{ to: OVERRIDE_ADDRESS, data }, 'latest',
		{ [OVERRIDE_ADDRESS]: { code: artifact.deployedBytecode } },
	]);
	assert.ok(response.error, `${functionName} mutation unexpectedly succeeded.`);
}

async function main() {
	const artifactPath = resolve(process.cwd(), '../wallet/artifacts/phase3/TbcVerifierHarness.json');
	const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as Artifact;
	const relayHarness = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcHeaderRelayIntegrationHarness.json'), 'utf8',
	)) as Artifact;
	const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');
	const manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'tbcdev-bootstrap-history-v1.json'), 'utf8')) as BootstrapManifest;
	const bootstrapPoints = decodeTbcdevBootstrapContext(await readFile(resolve(fixtureRoot, manifest.binaryFile)));
	assert.equal((await rpc('eth_chainId', [])).result, '0x3e6', 'RPC is not HyperEVM Testnet chain 998.');
	const compact = await call(artifact, 'compactRoundTrip', [0x1d00ffff]) as readonly unknown[];
	assert.deepEqual(compact, [decodeCompactTarget(0x1d00ffff).target, 0x1d00ffff, false, false]);
	const bootstrapCommitment = buildTbcdevBootstrapCommitment(bootstrapPoints);
	assert.equal(bootstrapCommitment.root, manifest.commitmentRoot);
	const solidityPoint = (index: number) => ({
		height: bootstrapPoints[index].height,
		blockHash: `0x${bootstrapPoints[index].blockHash}`,
		time: bootstrapPoints[index].time,
		bits: bootstrapPoints[index].bits,
		chainWork: bootstrapPoints[index].chainWork,
	});
	for (const index of [0, Math.floor(bootstrapPoints.length / 2), bootstrapPoints.length - 1]) {
		assert.equal(await call(artifact, 'verifyBootstrapPoint', [
			solidityPoint(index), tbcdevBootstrapProof(bootstrapCommitment, bootstrapPoints[index].height),
		]), true);
	}
	const checkpointPoint = bootstrapPoints.at(-1)!;
	const bootstrapByHeight = new Map(bootstrapPoints.map((point, index) => [point.height, index]));
	const relayWitnesses = RELAY_HEADERS.map((header) => {
		const previousHeight = header.height - 1;
		const heights = [
			previousHeight - 8_064,
			previousHeight - 146, previousHeight - 145, previousHeight - 144,
			...Array.from({ length: 23 }, (_, index) => previousHeight - 22 + index),
		].filter((height) => height < 839_164);
		return heights.map((height) => {
			const pointIndex = bootstrapByHeight.get(height);
			assert.notEqual(pointIndex, undefined, `Missing bootstrap point ${height}.`);
			return {
				point: solidityPoint(pointIndex!),
				siblings: tbcdevBootstrapProof(bootstrapCommitment, height),
			};
		});
	});
	const relayResult = await call(relayHarness, 'validateSixHeaders', [
		RELAY_HEADERS.map((header) => `0x${serializeBlockHeader(header).toString('hex')}`),
		relayWitnesses,
		`0x${RELAY_HEADERS.at(-1)!.hash}`,
		`0x${RELAY_HEADERS[0].hash}`,
	]) as readonly unknown[];
	const expectedRelayWork = RELAY_HEADERS.reduce(
		(chainWork, header) => chainWork + blockWork(header.bits), checkpointPoint.chainWork,
	);
	assert.deepEqual(relayResult, [839_170, expectedRelayWork]);
	assert.equal(await call(relayHarness, 'validateEqualWorkFailClosed', []), true);
	const solidityCheckpoint = solidityPoint(bootstrapPoints.length - 1);
	assert.deepEqual(tbcdevBootstrapProof(bootstrapCommitment, checkpointPoint.height), manifest.checkpointProof);
	assert.equal(await call(artifact, 'verifyBootstrapPoint', [
		{ ...solidityCheckpoint, time: solidityCheckpoint.time + 1 }, manifest.checkpointProof,
	]), false);

	const rawHeader = serializeBlockHeader(REAL_MT_DEPOSIT_BLOCK);
	const inspected = await call(artifact, 'inspectHeader', [`0x${rawHeader.toString('hex')}`]) as readonly unknown[];
	const target = decodeCompactTarget(REAL_MT_DEPOSIT_BLOCK.bits).target;
	assert.deepEqual(inspected, [
		REAL_MT_DEPOSIT_BLOCK.version,
		`0x${REAL_MT_DEPOSIT_BLOCK.previousBlockHash}`,
		`0x${REAL_MT_DEPOSIT_BLOCK.merkleRoot}`,
		REAL_MT_DEPOSIT_BLOCK.time,
		REAL_MT_DEPOSIT_BLOCK.bits,
		REAL_MT_DEPOSIT_BLOCK.nonce,
		`0x${REAL_MT_DEPOSIT_BLOCK.hash}`,
		target,
		blockWork(REAL_MT_DEPOSIT_BLOCK.bits),
	]);

	const realDepositRoot = await call(artifact, 'reconstructMerkleRoot', [
		'0xd87d9f42f427a7ac1ade5d2896a88a3e99deeec7257ae5df3ae2c013a3823519', 1, 3,
		[
			'0x0f1f7aad5b51a8de9d37586de34d5271aa6d005dfb966b99602d0b6643ab2aec',
			'0x4b76fd1b66b74bf268bffb5f7225a2d9e00720dabbd08a7a6449ddca4a8d7d61',
		],
	]);
	assert.equal(realDepositRoot, `0x${REAL_MT_DEPOSIT_BLOCK.merkleRoot}`);

	const oddTxid = '0x11df2827c98dd5370277b9c2df7e50023ee0f408552770d3217e3fecaf15f6ed';
	const oddRoot = await call(artifact, 'reconstructMerkleRoot', [oddTxid, 4, 5, [
		oddTxid,
		'0xc596026e784f908e442b3883ed41e23937921deace27f75ebab9b4e6f7d1f5b4',
		'0x1a3f798f541c6dca88f46d1ee59041cf2a1336c4bde89b598248ca12dc49c372',
	]]);
	assert.equal(oddRoot, '0x0089244e1171ecca4c8e780e994cfc06b7a78e33237ab17eb45ee5be20d18118');

	const solidityPoints = REAL_MT_DAA_POINTS.map((point) => ({
		height: point.height, time: point.time, bits: point.bits, chainWork: point.chainWork,
	}));
	assert.equal(await call(artifact, 'expectedPostForkBits', [solidityPoints, 839_164]), 0x1a0420a6);
	await expectRevert(artifact, 'expectedPostForkBits', [[...solidityPoints, solidityPoints[0]], 839_164]);

	const invalidTargetHeader = Buffer.from(rawHeader);
	invalidTargetHeader.writeUInt32LE(0x1e00ffff, 72);
	await expectRevert(artifact, 'inspectHeader', [`0x${invalidTargetHeader.toString('hex')}`]);
	await expectRevert(artifact, 'reconstructMerkleRoot', [oddTxid, 4, 5, [
		'0x00df2827c98dd5370277b9c2df7e50023ee0f408552770d3217e3fecaf15f6ed',
		'0xc596026e784f908e442b3883ed41e23937921deace27f75ebab9b4e6f7d1f5b4',
		'0x1a3f798f541c6dca88f46d1ee59041cf2a1336c4bde89b598248ca12dc49c372',
	]]);

	console.log('Phase 3 Solidity and six-header relay vectors passed through read-only HyperEVM Testnet eth_call.');
	console.log('No contract was deployed and no transaction or asset movement was submitted.');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
