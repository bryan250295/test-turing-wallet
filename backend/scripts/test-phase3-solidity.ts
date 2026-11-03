import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	decodeFunctionResult, encodeFunctionData, type Abi, type Hex,
} from 'viem';
import { blockWork, decodeCompactTarget } from '../src/bridge/phase1/tbc-consensus';
import { serializeBlockHeader } from '../src/bridge/phase1/tbc-proof.crypto';
import { REAL_MT_DAA_POINTS, REAL_MT_DEPOSIT_BLOCK } from '../src/bridge/phase1/tbc-test-vectors';

const RPC_URL = 'https://rpc.hyperliquid-testnet.xyz/evm';
const OVERRIDE_ADDRESS = '0x0000000000000000000000000000000000000333';

interface Artifact { abi: Abi; deployedBytecode: Hex }
interface RpcResponse { result?: Hex; error?: { code: number; message: string; data?: unknown } }

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
	assert.equal((await rpc('eth_chainId', [])).result, '0x3e6', 'RPC is not HyperEVM Testnet chain 998.');
	const compact = await call(artifact, 'compactRoundTrip', [0x1d00ffff]) as readonly unknown[];
	assert.deepEqual(compact, [decodeCompactTarget(0x1d00ffff).target, 0x1d00ffff, false, false]);

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

	console.log('Phase 3 Solidity vectors passed through read-only HyperEVM Testnet eth_call.');
	console.log('No contract was deployed and no transaction or asset movement was submitted.');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
