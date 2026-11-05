import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
	decodeFunctionResult, encodeAbiParameters, encodeDeployData, encodeFunctionData, formatEther,
	keccak256, toHex, type Abi, type Hex,
} from 'viem';
import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import { blockWork, decodeCompactTarget } from '../src/bridge/phase1/tbc-consensus';
import { serializeBlockHeader } from '../src/bridge/phase1/tbc-proof.crypto';
import {
	REAL_MT_DAA_POINTS, REAL_MT_DEPOSIT_BLOCK, REAL_MT_DEPOSIT_MERKLE_BRANCH,
	REAL_MT_DEPOSIT_TXID,
} from '../src/bridge/phase1/tbc-test-vectors';
import type { TbcBlockRecord } from '../src/bridge/phase1/tbc-proof.types';
import {
	bridgeCovenantFtController, buildBridgeCovenantScript, logicalDepositId, sourceOutpointId,
} from '../src/bridge/phase2/bridge-covenant';
import { PINNED_MT_V3_GENESIS_RAW } from '../src/bridge/phase2/pinned-mt-v3.vector';
import {
	buildTbcdevBootstrapCommitment, decodeTbcdevBootstrapContext, tbcdevBootstrapProof,
} from '../src/bridge/phase3/bootstrap-history';

const nodeRequire = createRequire(__filename);
const partialSha256 = nodeRequire('tbc-lib-js/lib/util/partial-sha256') as {
	calculate_partial_hash(value: Buffer): string;
};

const RPC_URL = 'https://rpc.hyperliquid-testnet.xyz/evm';
const OVERRIDE_ADDRESS = '0x0000000000000000000000000000000000000333';
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
const CHECKPOINT_HASH = '0x000000000000023f252086d278485a61b6c225ad07213fff329ef5e31e1c256b' as Hex;
const CHECKPOINT_MERKLE_ROOT = '0xd51c636b8a6959ecc9754595884cf7ce4cd79ffb7a2bee75f714a293310ccc50' as Hex;
const CHECKPOINT_CHAIN_WORK = BigInt('0x14f15b416fbbd30a34db4b3');

interface Artifact {
	abi: Abi;
	bytecode: Hex;
	deployedBytecode: Hex;
	immutableReferences?: Record<string, Array<{ length: number; start: number }>>;
	immutableNames?: Record<string, string>;
}
interface BootstrapManifest { commitmentRoot: Hex; checkpointProof: Hex[]; binaryFile: string }
interface RpcResponse { result?: Hex; error?: { code: number; message: string; data?: unknown } }
interface SolidityVerifiedDeposit {
	txid: Hex;
	depositId: Hex;
	covenantController: Hex;
	intent: {
		sourceContractId: Hex;
		destinationChainId: bigint;
		destinationGateway: Hex;
		recipient: Hex;
		amountRaw: bigint;
		depositNonce: bigint;
		reserveControllerPubKeyHash: Hex;
	};
}
interface SolidityVerifiedTransition {
	deposit: SolidityVerifiedDeposit;
	ftInputTotal: bigint;
	feeRaw: bigint;
}

export const PHASE3D_GATEWAY = '0x1111111111111111111111111111111111111111' as const;
const PHASE3D_RELAY = '0x0000000000000000000000000000000000000301' as const;
const PHASE3D_AUTHORIZATION = '0x0000000000000000000000000000000000000302' as const;
const PHASE3D_PREFIX = '0x0000000000000000000000000000000000000303' as const;
const PHASE3D_TOKEN = '0x0000000000000000000000000000000000000304' as const;
const PHASE3D_RECIPIENT = '0x8221fae04189f1f2f50268495ed95d1a9b220432' as const;
const PHASE3D_RESERVE_PKH = '2222222222222222222222222222222222222222';
const CompressedPrivateKey = tbc.PrivateKey as unknown as new (key: object) => tbc.PrivateKey;
const PHASE3D_SIGNER_KEY = new CompressedPrivateKey({
	bn: new tbc.crypto.BN('11'.repeat(32), 16), network: tbc.Networks.testnet, compressed: true,
});

function compactSize(value: number) {
	assert.ok(Number.isSafeInteger(value) && value >= 0);
	if (value < 0xfd) return Buffer.from([value]);
	if (value <= 0xffff) {
		const result = Buffer.alloc(3); result[0] = 0xfd; result.writeUInt16LE(value, 1); return result;
	}
	const result = Buffer.alloc(5); result[0] = 0xfe; result.writeUInt32LE(value, 1); return result;
}

function uint64le(value: bigint) { const result = Buffer.alloc(8); result.writeBigUInt64LE(value); return result; }
function uint32le(value: number) { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result; }
function wireHash(displayed: string) { return Buffer.from(displayed, 'hex').reverse(); }

function serializedTransaction(
	inputs: Array<{ txid: string; vout: number }>,
	outputs: Array<{ satoshis: bigint; script: Buffer }>,
) {
	const input = ({ txid, vout }: { txid: string; vout: number }) => Buffer.concat([
		wireHash(txid), uint32le(vout), Buffer.from([0]), Buffer.from('ffffffff', 'hex'),
	]);
	const output = ({ satoshis, script }: { satoshis: bigint; script: Buffer }) => Buffer.concat([
		uint64le(satoshis), compactSize(script.length), script,
	]);
	return Buffer.concat([
		uint32le(10), compactSize(inputs.length), ...inputs.map(input), compactSize(outputs.length),
		...outputs.map(output), uint32le(0),
	]);
}

export function phase3dEnvelopeVector(
	destinationGateway: Hex = PHASE3D_GATEWAY,
) {
	const genesis = new tbc.Transaction(PINNED_MT_V3_GENESIS_RAW);
	const amountRaw = 1_234n;
	const intent = {
		sourceContractId: genesis.hash, destinationChainId: 998n, destinationGateway,
		recipient: PHASE3D_RECIPIENT, amountRaw, depositNonce: 7n,
		reserveControllerPubKeyHash: PHASE3D_RESERVE_PKH,
	};
	const covenant = buildBridgeCovenantScript(intent);
	const covenantController = bridgeCovenantFtController(covenant);
	const code = sdk.FT.buildFTtransferCode(genesis.outputs[0].script.toHex(), covenantController).toBuffer();
	const { amountHex } = sdk.FT.buildTapeAmount(amountRaw, [amountRaw]);
	const tape = sdk.FT.buildFTtransferTape(genesis.outputs[1].script.toHex(), amountHex).toBuffer();
	const signer = PHASE3D_SIGNER_KEY.toAddress().toString();
	const signerPublicKey = PHASE3D_SIGNER_KEY.toPublicKey();
	const compressedPublicKey = signerPublicKey.toBuffer();
	const point = signerPublicKey.toObject() as { x: string; y: string };
	const ownerCode = sdk.FT.buildFTtransferCode(
		genesis.outputs[0].script.toHex(), signer,
	).toBuffer();
	const ancestorScript = Buffer.from(`76a914${'44'.repeat(20)}88ac`, 'hex');
	const ancestorRaw = serializedTransaction(
		[{ txid: 'aa'.repeat(32), vout: 0 }], [{ satoshis: 900n, script: ancestorScript }],
	);
	const ancestor = new tbc.Transaction(ancestorRaw.toString('hex'));
	const secondAncestorRaw = serializedTransaction(
		[{ txid: 'cc'.repeat(32), vout: 1 }], [{ satoshis: 901n, script: ancestorScript }],
	);
	const secondAncestor = new tbc.Transaction(secondAncestorRaw.toString('hex'));
	const parentTapeAmounts = Buffer.alloc(48);
	parentTapeAmounts.writeBigUInt64LE(600n, 0);
	parentTapeAmounts.writeBigUInt64LE(634n, 8);
	const parentTape = sdk.FT.buildFTtransferTape(
		genesis.outputs[1].script.toHex(), parentTapeAmounts.toString('hex'),
	).toBuffer();
	const ftParentRaw = serializedTransaction(
		[{ txid: ancestor.hash, vout: 0 }, { txid: secondAncestor.hash, vout: 0 }],
		[{ satoshis: 500n, script: ownerCode }, { satoshis: 0n, script: parentTape }],
	);
	const ftParent = new tbc.Transaction(ftParentRaw.toString('hex'));
	const nativeScript = tbc.Script.buildPublicKeyHashOut(signer).toBuffer();
	const nativeParentRaw = serializedTransaction(
		[{ txid: 'bb'.repeat(32), vout: 0 }], [{ satoshis: 100_000n, script: nativeScript }],
	);
	const nativeParent = new tbc.Transaction(nativeParentRaw.toString('hex'));
	const ancestorData = sdk.buildFtPrePreTxData(ftParent, 0, [ancestor, secondAncestor]);
	let ftSignature = '';
	const parsed = new tbc.Transaction()
		.from({
			txId: ftParent.hash, outputIndex: 0, script: ownerCode.toString('hex'),
			satoshis: 500, ftBalance: amountRaw,
		})
		.from({
			txId: nativeParent.hash, outputIndex: 0, script: nativeScript.toString('hex'),
			satoshis: 100_000,
		})
		.addOutput(new tbc.Transaction.Output({ script: covenant, satoshis: 100 }))
		.addOutput(new tbc.Transaction.Output({ script: new tbc.Script(code), satoshis: 500 }))
		.addOutput(new tbc.Transaction.Output({ script: new tbc.Script(tape), satoshis: 0 }))
		.fee(1_900)
		.change(signer);
	parsed.setInputScript({ inputIndex: 0 }, (current) => {
		const signature = current.getSignature(0, PHASE3D_SIGNER_KEY);
		if (typeof signature !== 'string') throw new Error('Expected one FT signature.');
		ftSignature = signature;
		return sdk.FT.getFTunlock(
			ftSignature, signerPublicKey.toHex(), current, ftParent, ancestorData, 0, 0, false,
		);
	});
	parsed.sign(PHASE3D_SIGNER_KEY).seal();
	const nativeSignature = parsed.inputs[1].script.chunks[0].buf!;
	const verifySignature = (vin: number, signature: Buffer, script: Buffer, satoshis: number) => {
		const parsedSignature = tbc.crypto.Signature.fromTxFormat(signature);
		assert.equal(parsedSignature.nhashtype, 0x41);
		assert.equal(parsed.verifySignature(
			parsedSignature, signerPublicKey, vin, new tbc.Script(script),
			new tbc.crypto.BN(satoshis), tbc.Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID,
		), true);
	};
	verifySignature(0, Buffer.from(ftSignature, 'hex'), ownerCode, 500);
	verifySignature(1, nativeSignature, nativeScript, 100_000);
	const raw = parsed.toBuffer();
	const signatureWitness = (vin: number, signature: Buffer) => {
		const script = parsed.inputs[vin].script.toBuffer();
		const needle = Buffer.concat([
			Buffer.from([signature.length]), signature,
			Buffer.from([compressedPublicKey.length]), compressedPublicKey,
		]);
		const signaturePushOffset = script.indexOf(needle);
		assert.ok(signaturePushOffset >= 0, `Missing signature/public-key pair at vin ${vin}.`);
		return {
			signaturePushOffset,
			publicKeyX: `0x${point.x.padStart(64, '0')}` as Hex,
			publicKeyY: `0x${point.y.padStart(64, '0')}` as Hex,
		};
	};
	const signatureWitnesses = [
		signatureWitness(0, Buffer.from(ftSignature, 'hex')),
		signatureWitness(1, nativeSignature),
	];
	const ftInputScript = parsed.inputs[0].script.toBuffer();
	const covenantScriptOffset = raw.indexOf(covenant.toBuffer());
	assert.ok(covenantScriptOffset >= 0);
	const replaceFtInputScript = (nextScript: Buffer) => {
		const scriptOffset = raw.indexOf(ftInputScript);
		assert.ok(scriptOffset >= 0, 'Missing serialized FT input script.');
		const lengthPrefix = compactSize(ftInputScript.length);
		const prefixOffset = scriptOffset - lengthPrefix.length;
		assert.deepEqual(raw.subarray(prefixOffset, scriptOffset), lengthPrefix);
		return Buffer.concat([
			raw.subarray(0, prefixOffset), compactSize(nextScript.length), nextScript,
			raw.subarray(scriptOffset + ftInputScript.length),
		]);
	};
	const ftPairEnd = signatureWitnesses[0].signaturePushOffset
		+ 1 + Buffer.from(ftSignature, 'hex').length + 1 + compressedPublicKey.length;
	const withCoinFlag = replaceFtInputScript(Buffer.concat([
		ftInputScript.subarray(0, ftPairEnd), Buffer.from([0]), ftInputScript.subarray(ftPairEnd),
	]));
	const withTrailingStackData = replaceFtInputScript(Buffer.concat([
		ftInputScript, Buffer.from([0]),
	]));
	const wrongParentHeaderScript = Buffer.from(ftInputScript);
	wrongParentHeaderScript[ftPairEnd + 1] ^= 1;
	const withWrongParentHeader = replaceFtInputScript(wrongParentHeaderScript);
	const wrongCurrentAmountScript = Buffer.from(ftInputScript);
	assert.equal(wrongCurrentAmountScript[0], 0x51);
	assert.equal(wrongCurrentAmountScript[1], 0x08);
	wrongCurrentAmountScript[2] ^= 1;
	const covenantPartialState = Buffer.from(partialSha256.calculate_partial_hash(
		covenant.toBuffer().subarray(0, 256),
	), 'hex');
	const currentPartialOffset = ftInputScript.indexOf(covenantPartialState);
	assert.ok(currentPartialOffset > 0 && currentPartialOffset < signatureWitnesses[0].signaturePushOffset);
	const wrongCurrentPartialScript = Buffer.from(ftInputScript);
	wrongCurrentPartialScript[currentPartialOffset] ^= 1;
	const prePreBytes = Buffer.from(ancestorData, 'hex');
	const prePreOffset = ftInputScript.indexOf(prePreBytes);
	assert.ok(prePreOffset > 0 && prePreOffset < signatureWitnesses[0].signaturePushOffset);
	const wrongPrePreHeaderScript = Buffer.from(ftInputScript);
	assert.equal(wrongPrePreHeaderScript[prePreOffset], 0x57);
	assert.equal(wrongPrePreHeaderScript[prePreOffset + 1], 0x10);
	wrongPrePreHeaderScript[prePreOffset + 2] ^= 1;
	return {
		raw: `0x${raw.toString('hex')}` as Hex,
		txid: `0x${parsed.hash}` as Hex,
		depositId: logicalDepositId(intent, { sourceTxid: parsed.hash, sourceVout: 1 }),
		covenantController: `0x${covenantController}` as Hex,
		parents: [
			`0x${ftParentRaw.toString('hex')}` as Hex,
			`0x${nativeParentRaw.toString('hex')}` as Hex,
		],
		ancestors: [[
			`0x${ancestorRaw.toString('hex')}` as Hex,
			`0x${secondAncestorRaw.toString('hex')}` as Hex,
		], []] as Hex[][],
		signatureHexes: [ftSignature, nativeSignature.toString('hex')],
		signatureWitnesses,
		signaturePushOffsets: signatureWitnesses.map(({ signaturePushOffset }) => signaturePushOffset),
		witnessLayoutMutations: {
			withCoinFlag: `0x${withCoinFlag.toString('hex')}` as Hex,
			withTrailingStackData: `0x${withTrailingStackData.toString('hex')}` as Hex,
			withWrongParentHeader: `0x${withWrongParentHeader.toString('hex')}` as Hex,
		},
		prefixMutations: {
			wrongCurrentAmount: `0x${replaceFtInputScript(wrongCurrentAmountScript).toString('hex')}` as Hex,
			wrongCurrentPartial: `0x${replaceFtInputScript(wrongCurrentPartialScript).toString('hex')}` as Hex,
			wrongPrePreHeader: `0x${replaceFtInputScript(wrongPrePreHeaderScript).toString('hex')}` as Hex,
		},
		covenantPartialState: `0x${covenantPartialState.toString('hex')}` as Hex,
		covenantScriptOffset,
		feeRaw: 1_900n,
		nativeScriptHex: nativeScript.toString('hex'),
		intent,
	};
}

export const RELAY_HEADERS = [
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

function calldataGas(data: Hex) {
	let gas = 0n;
	for (let index = 2; index < data.length; index += 2) gas += data.slice(index, index + 2) === '00' ? 4n : 16n;
	return gas;
}

function patchImmutables(artifact: Artifact, values: Record<string, Hex>): Hex {
	const runtime = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
	for (const [id, references] of Object.entries(artifact.immutableReferences ?? {})) {
		const name = artifact.immutableNames?.[id];
		assert.ok(name && values[name], `Missing immutable value for ${name ?? id}.`);
		const encoded = Buffer.from(values[name].slice(2), 'hex');
		assert.equal(encoded.length, 32, `Immutable ${name} is not one EVM word.`);
		for (const reference of references) {
			assert.equal(reference.length, 32);
			encoded.copy(runtime, reference.start);
		}
	}
	return `0x${runtime.toString('hex')}`;
}

function addressWord(value: Hex) {
	return encodeAbiParameters([{ type: 'address' }], [value]);
}

function bytes20Word(value: Hex) {
	return encodeAbiParameters([{ type: 'bytes20' }], [value]);
}

interface StoredHeader {
	blockHash: Hex;
	parentHash: Hex;
	merkleRoot: Hex;
	skipHash: Hex;
	chainWork: bigint;
	height: number;
	time: number;
	bits: number;
}

function invertLowestOne(value: number) { return value === 0 ? 0 : (value & (value - 1)) >>> 0; }
function skipHeight(height: number) {
	if (height < 2) return 0;
	return (height & 1) === 1 ? invertLowestOne(invertLowestOne(height - 1)) + 1 : invertLowestOne(height);
}

function relayStorage(priorHeaderCount: number) {
	const stored: StoredHeader[] = [{
		blockHash: CHECKPOINT_HASH, parentHash: ZERO_HASH, merkleRoot: CHECKPOINT_MERKLE_ROOT,
		skipHash: ZERO_HASH, chainWork: CHECKPOINT_CHAIN_WORK, height: 839_164,
		time: 1_793_335_668, bits: 0x1a041f18,
	}];
	for (const header of RELAY_HEADERS.slice(0, priorHeaderCount)) {
		const parent = stored.at(-1)!;
		const height = parent.height + 1;
		const requestedSkipHeight = skipHeight(height);
		const skip = requestedSkipHeight < 839_164
			? undefined : stored.find((candidate) => candidate.height === requestedSkipHeight);
		assert.ok(requestedSkipHeight < 839_164 || skip, `Missing synthetic skip ancestor ${requestedSkipHeight}.`);
		stored.push({
			blockHash: `0x${header.hash}`, parentHash: `0x${header.previousBlockHash}`,
			merkleRoot: `0x${header.merkleRoot}`, skipHash: skip?.blockHash ?? ZERO_HASH,
			chainWork: parent.chainWork + blockWork(header.bits), height, time: header.time, bits: header.bits,
		});
	}

	const stateDiff: Record<Hex, Hex> = {};
	for (const node of stored) {
		const base = BigInt(keccak256(encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'uint256' }], [node.blockHash, 0n],
		)));
		const slot = (offset: bigint) => toHex(base + offset, { size: 32 });
		stateDiff[slot(0n)] = node.parentHash;
		stateDiff[slot(1n)] = node.merkleRoot;
		stateDiff[slot(2n)] = node.skipHash;
		stateDiff[slot(3n)] = toHex(node.chainWork, { size: 32 });
		const packed = BigInt(node.height) | (BigInt(node.time) << 32n)
			| (BigInt(node.bits) << 64n) | (1n << 96n);
		stateDiff[slot(4n)] = toHex(packed, { size: 32 });
	}
	const tip = stored.at(-1)!;
	stateDiff[toHex(1n, { size: 32 })] = tip.blockHash;
	stateDiff[toHex(2n, { size: 32 })] = toHex(tip.chainWork, { size: 32 });
	stateDiff[toHex(3n, { size: 32 })] = ZERO_HASH;
	return stateDiff;
}

async function main() {
	const artifactPath = resolve(process.cwd(), '../wallet/artifacts/phase3/TbcVerifierHarness.json');
	const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as Artifact;
	const relayHarness = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcHeaderRelayIntegrationHarness.json'), 'utf8',
	)) as Artifact;
	const relayArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcHeaderRelayV2.json'), 'utf8',
	)) as Artifact;
	const depositArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcBridgeDepositVerifierHarness.json'), 'utf8',
	)) as Artifact;
	const authorizationArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcAuthorizedTransitionHarness.json'), 'utf8',
	)) as Artifact;
	const prefixArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcFtUnlockPrefixHarness.json'), 'utf8',
	)) as Artifact;
	const replayArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcDepositReplayHarness.json'), 'utf8',
	)) as Artifact;
	const productionAuthorizationArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcAuthorizedTransitionVerifier.json'), 'utf8',
	)) as Artifact;
	const productionPrefixArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcFtUnlockPrefixVerifierModule.json'), 'utf8',
	)) as Artifact;
	const gatewayArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcProofMintGateway.json'), 'utf8',
	)) as Artifact;
	const wrappedTokenArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/WrappedFTV2.json'), 'utf8',
	)) as Artifact;
	const mintIntegrationArtifact = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/artifacts/phase3/TbcProofMintIntegrationHarness.json'), 'utf8',
	)) as Artifact;
	const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');
	const manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'tbcdev-bootstrap-history-v1.json'), 'utf8')) as BootstrapManifest;
	const bootstrapPoints = decodeTbcdevBootstrapContext(await readFile(resolve(fixtureRoot, manifest.binaryFile)));
	assert.equal((await rpc('eth_chainId', [])).result, '0x3e6', 'RPC is not HyperEVM Testnet chain 998.');
	const depositVector = phase3dEnvelopeVector();
	const expectedReserve = `0x${PHASE3D_RESERVE_PKH}` as Hex;
	const verifiedDeposit = await call(depositArtifact, 'inspectDeposit', [
		depositVector.raw, PHASE3D_GATEWAY, expectedReserve,
	]) as SolidityVerifiedDeposit;
	assert.equal(verifiedDeposit.txid, depositVector.txid);
	assert.equal(verifiedDeposit.depositId, depositVector.depositId);
	assert.equal(verifiedDeposit.covenantController, depositVector.covenantController);
	assert.equal(verifiedDeposit.intent.sourceContractId, `0x${depositVector.intent.sourceContractId}`);
	assert.equal(verifiedDeposit.intent.destinationChainId, 998n);
	assert.equal(verifiedDeposit.intent.destinationGateway.toLowerCase(), PHASE3D_GATEWAY);
	assert.equal(verifiedDeposit.intent.recipient.toLowerCase(), PHASE3D_RECIPIENT);
	assert.equal(verifiedDeposit.intent.amountRaw, depositVector.intent.amountRaw);
	assert.equal(verifiedDeposit.intent.depositNonce, depositVector.intent.depositNonce);
	assert.equal(verifiedDeposit.intent.reserveControllerPubKeyHash, expectedReserve);
	const merkleVerified = await call(depositArtifact, 'verifyMerkleDeposit', [
		depositVector.txid, depositVector.raw, 0, 1, [], PHASE3D_GATEWAY, expectedReserve,
	]) as SolidityVerifiedDeposit;
	assert.equal(merkleVerified.depositId, depositVector.depositId);
	const verifiedTransition = await call(depositArtifact, 'verifyTransition', [
		depositVector.raw, depositVector.parents, PHASE3D_GATEWAY, expectedReserve,
	]) as SolidityVerifiedTransition;
	assert.equal(verifiedTransition.deposit.depositId, depositVector.depositId);
	assert.equal(verifiedTransition.ftInputTotal, depositVector.intent.amountRaw);
	assert.equal(verifiedTransition.feeRaw, depositVector.feeRaw);
	const authenticatedTransition = await call(depositArtifact, 'verifyAuthenticatedTransition', [
		depositVector.raw, depositVector.parents, depositVector.ancestors,
		PHASE3D_GATEWAY, expectedReserve,
	]) as SolidityVerifiedTransition;
	assert.deepEqual(authenticatedTransition, verifiedTransition);
	const authorizedTransition = await call(authorizationArtifact, 'verifyAuthorizedTransition', [
		// The witness offset is relative to the serialized input script and points
		// to the canonical one-byte signature push opcode.
		depositVector.raw, depositVector.parents, depositVector.ancestors,
		depositVector.signatureWitnesses, PHASE3D_GATEWAY, expectedReserve,
	]) as SolidityVerifiedTransition;
	assert.deepEqual(authorizedTransition, authenticatedTransition);
	assert.equal(await call(prefixArtifact, 'partialSha256State', [
		depositVector.raw, depositVector.covenantScriptOffset, 256,
	]), depositVector.covenantPartialState);
	assert.equal(await call(prefixArtifact, 'verifyFtUnlockPrefixes', [
		depositVector.raw, depositVector.parents, depositVector.ancestors,
		depositVector.signaturePushOffsets,
	]), true);
	const expectedSourceOutpoint = sourceOutpointId(depositVector.intent.sourceContractId, {
		sourceTxid: depositVector.txid, sourceVout: 1,
	});
	assert.equal(await call(replayArtifact, 'sourceOutpointId', [
		`0x${depositVector.intent.sourceContractId}`, depositVector.txid, 1,
	]), expectedSourceOutpoint);
	const replayExercise = await call(replayArtifact, 'exerciseReplayProtection', [
		`0x${depositVector.intent.sourceContractId}`, depositVector.txid, depositVector.depositId,
		`0x${'33'.repeat(32)}`, `0x${'44'.repeat(32)}`,
	]) as readonly [Hex, boolean];
	assert.deepEqual(replayExercise, [expectedSourceOutpoint, true]);
	assert.equal(await call(replayArtifact, 'exerciseRollback', [
		`0x${depositVector.intent.sourceContractId}`, depositVector.txid, depositVector.depositId,
	]), true);

	assert.equal(
		keccak256(relayArtifact.deployedBytecode),
		'0x8056986ffcc5d8f1fa018aee82fe5fc36e27bbd10d4f5141871768c43554ef03',
	);
	assert.equal(
		keccak256(productionAuthorizationArtifact.deployedBytecode),
		'0xbd25c07c5a57d79532cd829a650346ddc00863d92ba833cee49099916173d4c5',
	);
	assert.equal(
		keccak256(productionPrefixArtifact.deployedBytecode),
		'0xdca851d9c2013789f5da598adc15136b0ca003de58a652be20e1fc0f6203fa49',
	);

	const gatewayRuntime = patchImmutables(gatewayArtifact, {
		relay: addressWord(PHASE3D_RELAY),
		authorizationVerifier: addressWord(PHASE3D_AUTHORIZATION),
		prefixVerifier: addressWord(PHASE3D_PREFIX),
		reserveController: bytes20Word(expectedReserve),
		wrappedToken: addressWord(PHASE3D_TOKEN),
	});
	const wrappedTokenRuntime = patchImmutables(wrappedTokenArtifact, {
		gateway: addressWord(PHASE3D_GATEWAY),
	});
	const depositBlockHash = `0x${RELAY_HEADERS[0].hash}` as Hex;
	const proofRelayState = relayStorage(6);
	const depositHeaderBase = BigInt(keccak256(encodeAbiParameters(
		[{ type: 'bytes32' }, { type: 'uint256' }], [depositBlockHash, 0n],
	)));
	proofRelayState[toHex(depositHeaderBase + 1n, { size: 32 })] = depositVector.txid;
	const gatewayProof = {
		blockHash: depositBlockHash,
		rawTransaction: depositVector.raw,
		transactionIndex: 0,
		transactionCount: 1,
		displayedSiblings: [],
		parentTransactions: depositVector.parents,
		ancestorTransactions: depositVector.ancestors,
		signatureWitnesses: depositVector.signatureWitnesses,
		signaturePushOffsets: depositVector.signaturePushOffsets,
	};
	const gatewayOverrides = {
		[PHASE3D_GATEWAY]: { code: gatewayRuntime },
		[PHASE3D_RELAY]: { code: relayArtifact.deployedBytecode, stateDiff: proofRelayState },
		[PHASE3D_AUTHORIZATION]: { code: productionAuthorizationArtifact.deployedBytecode },
		[PHASE3D_PREFIX]: { code: productionPrefixArtifact.deployedBytecode },
		[PHASE3D_TOKEN]: { code: wrappedTokenRuntime },
	};
	const integrationData = encodeFunctionData({
		abi: mintIntegrationArtifact.abi,
		functionName: 'executeAndRejectReplay',
		args: [
			PHASE3D_GATEWAY, gatewayProof, depositVector.depositId,
			PHASE3D_RECIPIENT, depositVector.intent.amountRaw,
		],
	});
	const integrationResponse = await rpc('eth_call', [
		{ to: OVERRIDE_ADDRESS, data: integrationData }, 'latest',
		{ ...gatewayOverrides, [OVERRIDE_ADDRESS]: { code: mintIntegrationArtifact.deployedBytecode } },
	]);
	if (integrationResponse.error || !integrationResponse.result) {
		throw new Error(`Proof mint integration failed: ${JSON.stringify(integrationResponse.error)}`);
	}
	const integrationResult = decodeFunctionResult({
		abi: mintIntegrationArtifact.abi,
		functionName: 'executeAndRejectReplay',
		data: integrationResponse.result,
	}) as readonly [Hex, bigint, bigint, boolean];
	assert.deepEqual(integrationResult, [
		PHASE3D_TOKEN, depositVector.intent.amountRaw, depositVector.intent.amountRaw, true,
	]);
	const gatewayMintData = encodeFunctionData({
		abi: gatewayArtifact.abi,
		functionName: 'mintFromProof',
		args: [gatewayProof],
	});
	const gatewayMintEstimateResponse = await rpc('eth_estimateGas', [
		{ to: PHASE3D_GATEWAY, data: gatewayMintData }, 'latest', gatewayOverrides,
	]);
	if (gatewayMintEstimateResponse.error || !gatewayMintEstimateResponse.result) {
		throw new Error(`Proof mint gas estimation failed: ${JSON.stringify(gatewayMintEstimateResponse.error)}`);
	}
	const gatewayMintGasEstimate = BigInt(gatewayMintEstimateResponse.result);
	const mismatchedOffsetProof = {
		...gatewayProof,
		signaturePushOffsets: [
			gatewayProof.signaturePushOffsets[0] + 1,
			...gatewayProof.signaturePushOffsets.slice(1),
		],
	};
	const mismatchedOffsetData = encodeFunctionData({
		abi: gatewayArtifact.abi,
		functionName: 'mintFromProof',
		args: [mismatchedOffsetProof],
	});
	const mismatchedOffsetResponse = await rpc('eth_call', [
		{ to: PHASE3D_GATEWAY, data: mismatchedOffsetData }, 'latest', gatewayOverrides,
	]);
	assert.ok(mismatchedOffsetResponse.error, 'Gateway accepted mismatched module offsets.');
	const unauthorizedTokenMint = encodeFunctionData({
		abi: wrappedTokenArtifact.abi,
		functionName: 'mintFromProof',
		args: [PHASE3D_RECIPIENT, depositVector.intent.amountRaw],
	});
	const unauthorizedTokenResponse = await rpc('eth_call', [
		{ to: PHASE3D_TOKEN, data: unauthorizedTokenMint }, 'latest',
		{ [PHASE3D_TOKEN]: { code: wrappedTokenRuntime } },
	]);
	assert.ok(unauthorizedTokenResponse.error, 'WrappedFTV2 accepted a non-gateway mint.');
	const overMaximumSupplyMint = encodeFunctionData({
		abi: wrappedTokenArtifact.abi,
		functionName: 'mintFromProof',
		args: [PHASE3D_RECIPIENT, 10_000_001n],
	});
	const overMaximumSupplyResponse = await rpc('eth_call', [
		{ from: PHASE3D_GATEWAY, to: PHASE3D_TOKEN, data: overMaximumSupplyMint },
		'latest', { [PHASE3D_TOKEN]: { code: wrappedTokenRuntime } },
	]);
	assert.ok(overMaximumSupplyResponse.error, 'WrappedFTV2 exceeded the pinned source supply.');

	const gatewayDeploymentData = encodeDeployData({
		abi: gatewayArtifact.abi,
		bytecode: gatewayArtifact.bytecode,
		args: [PHASE3D_AUTHORIZATION, PHASE3D_PREFIX, expectedReserve],
	});
	const gatewayDeploymentOverrides = {
		[PHASE3D_AUTHORIZATION]: { code: productionAuthorizationArtifact.deployedBytecode },
		[PHASE3D_PREFIX]: { code: productionPrefixArtifact.deployedBytecode },
	};
	const gatewayDeploymentEstimate = await rpc('eth_estimateGas', [
		{ data: gatewayDeploymentData }, 'latest', gatewayDeploymentOverrides,
	]);
	if (gatewayDeploymentEstimate.error || !gatewayDeploymentEstimate.result) {
		throw new Error(`Gateway deployment estimation failed: ${JSON.stringify(gatewayDeploymentEstimate.error)}`);
	}
	const proofGatewayDeploymentGasEstimate = BigInt(gatewayDeploymentEstimate.result);
	const mutatedPrefixRuntime = `${productionPrefixArtifact.deployedBytecode.slice(0, -2)}00` as Hex;
	const mismatchedModuleEstimate = await rpc('eth_estimateGas', [
		{ data: gatewayDeploymentData }, 'latest',
		{
			...gatewayDeploymentOverrides,
			[PHASE3D_PREFIX]: { code: mutatedPrefixRuntime },
		},
	]);
	assert.ok(mismatchedModuleEstimate.error, 'Gateway accepted a mismatched verifier codehash.');

	const mutatedAmount = Buffer.from(depositVector.raw.slice(2), 'hex');
	const magicOffset = mutatedAmount.indexOf(Buffer.from('LMBV2DEP', 'ascii'));
	assert.ok(magicOffset >= 0);
	mutatedAmount[magicOffset + 209] ^= 1;
	await expectRevert(depositArtifact, 'inspectDeposit', [
		`0x${mutatedAmount.toString('hex')}`, PHASE3D_GATEWAY, expectedReserve,
	]);
	const mutatedCode = Buffer.from(depositVector.raw.slice(2), 'hex');
	const codeOffset = mutatedCode.indexOf(Buffer.from('59796b517982', 'hex'));
	assert.ok(codeOffset >= 0);
	mutatedCode[codeOffset] ^= 1;
	await expectRevert(depositArtifact, 'inspectDeposit', [
		`0x${mutatedCode.toString('hex')}`, PHASE3D_GATEWAY, expectedReserve,
	]);
	const nonCanonicalCount = `0x${depositVector.raw.slice(2, 10)}fd0200${depositVector.raw.slice(12)}` as Hex;
	await expectRevert(depositArtifact, 'inspectDeposit', [
		nonCanonicalCount, PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(depositArtifact, 'inspectDeposit', [
		depositVector.raw, '0x3333333333333333333333333333333333333333', expectedReserve,
	]);
	await expectRevert(depositArtifact, 'verifyMerkleDeposit', [
		ZERO_HASH, depositVector.raw, 0, 1, [], PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(depositArtifact, 'verifyTransition', [
		depositVector.raw, depositVector.parents.slice(0, 1), PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(depositArtifact, 'verifyTransition', [
		depositVector.raw, [...depositVector.parents].reverse(), PHASE3D_GATEWAY, expectedReserve,
	]);
	const invalidAllocation = Buffer.from(depositVector.raw.slice(2), 'hex');
	const tapeOffset = invalidAllocation.lastIndexOf(Buffer.from('006a30d204', 'hex'));
	assert.ok(tapeOffset >= 0);
	invalidAllocation[tapeOffset + 3] = 0xd1;
	invalidAllocation[tapeOffset + 11] = 0x01;
	await expectRevert(depositArtifact, 'verifyTransition', [
		`0x${invalidAllocation.toString('hex')}`, depositVector.parents,
		PHASE3D_GATEWAY, expectedReserve,
	]);
	const invalidNativeChange = Buffer.from(depositVector.raw.slice(2), 'hex');
	const nativeChangeOffset = invalidNativeChange.lastIndexOf(
		Buffer.from(depositVector.nativeScriptHex, 'hex'),
	);
	assert.ok(nativeChangeOffset >= 0);
	invalidNativeChange[nativeChangeOffset + 3] ^= 1;
	await expectRevert(depositArtifact, 'verifyTransition', [
		`0x${invalidNativeChange.toString('hex')}`, depositVector.parents,
		PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(depositArtifact, 'verifyAuthenticatedTransition', [
		depositVector.raw, depositVector.parents, [[], []], PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(depositArtifact, 'verifyAuthenticatedTransition', [
		depositVector.raw, depositVector.parents, [depositVector.ancestors[0]],
		PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(depositArtifact, 'verifyAuthenticatedTransition', [
		depositVector.raw, depositVector.parents,
		[depositVector.ancestors[0], depositVector.ancestors[0]], PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(depositArtifact, 'verifyAuthenticatedTransition', [
		depositVector.raw, depositVector.parents,
		[[...depositVector.ancestors[0]].reverse(), []], PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(prefixArtifact, 'verifyFtUnlockPrefixes', [
		depositVector.raw, depositVector.parents,
		[[...depositVector.ancestors[0]].reverse(), []], depositVector.signaturePushOffsets,
	]);
	const mismatchedAncestor = Buffer.from(depositVector.ancestors[0][0].slice(2), 'hex');
	mismatchedAncestor[mismatchedAncestor.length - 5] ^= 1;
	await expectRevert(depositArtifact, 'verifyAuthenticatedTransition', [
		depositVector.raw, depositVector.parents,
		[[`0x${mismatchedAncestor.toString('hex')}`], []], PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(authorizationArtifact, 'verifyAuthorizedTransition', [
		depositVector.raw, depositVector.parents, depositVector.ancestors,
		depositVector.signatureWitnesses.slice(0, 1), PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(authorizationArtifact, 'verifyAuthorizedTransition', [
		depositVector.raw, depositVector.parents, depositVector.ancestors,
		[
			{ ...depositVector.signatureWitnesses[0], signaturePushOffset:
				depositVector.signatureWitnesses[0].signaturePushOffset + 1 },
			depositVector.signatureWitnesses[1],
		],
		PHASE3D_GATEWAY, expectedReserve,
	]);
	for (const mutatedWitness of Object.values(depositVector.witnessLayoutMutations)) {
		await expectRevert(authorizationArtifact, 'verifyAuthorizedTransition', [
			mutatedWitness, depositVector.parents, depositVector.ancestors,
			depositVector.signatureWitnesses, PHASE3D_GATEWAY, expectedReserve,
		]);
	}
	for (const mutatedPrefix of Object.values(depositVector.prefixMutations)) {
		await call(authorizationArtifact, 'verifyAuthorizedTransition', [
			mutatedPrefix, depositVector.parents, depositVector.ancestors,
			depositVector.signatureWitnesses, PHASE3D_GATEWAY, expectedReserve,
		]);
		await expectRevert(prefixArtifact, 'verifyFtUnlockPrefixes', [
			mutatedPrefix, depositVector.parents, depositVector.ancestors,
			depositVector.signaturePushOffsets,
		]);
	}
	const invalidSignature = Buffer.from(depositVector.raw.slice(2), 'hex');
	const ftSignatureOffset = invalidSignature.indexOf(
		Buffer.from(depositVector.signatureHexes[0], 'hex'),
	);
	assert.ok(ftSignatureOffset >= 0);
	invalidSignature[ftSignatureOffset + 10] ^= 1;
	await expectRevert(authorizationArtifact, 'verifyAuthorizedTransition', [
		`0x${invalidSignature.toString('hex')}`, depositVector.parents,
		depositVector.ancestors, depositVector.signatureWitnesses,
		PHASE3D_GATEWAY, expectedReserve,
	]);
	await expectRevert(authorizationArtifact, 'verifyAuthorizedTransition', [
		depositVector.raw, depositVector.parents, depositVector.ancestors,
		[
			{ ...depositVector.signatureWitnesses[0], publicKeyY:
				`0x${'00'.repeat(31)}01` },
			depositVector.signatureWitnesses[1],
		],
		PHASE3D_GATEWAY, expectedReserve,
	]);
	const depositInspectData = encodeFunctionData({
		abi: depositArtifact.abi, functionName: 'inspectDeposit',
		args: [depositVector.raw, PHASE3D_GATEWAY, expectedReserve],
	});
	const depositMerkleData = encodeFunctionData({
		abi: depositArtifact.abi, functionName: 'verifyMerkleDeposit',
		args: [depositVector.txid, depositVector.raw, 0, 1, [], PHASE3D_GATEWAY, expectedReserve],
	});
	const depositTransitionData = encodeFunctionData({
		abi: depositArtifact.abi, functionName: 'verifyTransition',
		args: [depositVector.raw, depositVector.parents, PHASE3D_GATEWAY, expectedReserve],
	});
	const depositAuthenticatedTransitionData = encodeFunctionData({
		abi: depositArtifact.abi, functionName: 'verifyAuthenticatedTransition',
		args: [
			depositVector.raw, depositVector.parents, depositVector.ancestors,
			PHASE3D_GATEWAY, expectedReserve,
		],
	});
	const depositAuthorizedTransitionData = encodeFunctionData({
		abi: authorizationArtifact.abi, functionName: 'verifyAuthorizedTransition',
		args: [
			depositVector.raw, depositVector.parents, depositVector.ancestors,
			depositVector.signatureWitnesses, PHASE3D_GATEWAY, expectedReserve,
		],
	});
	const depositPrefixData = encodeFunctionData({
		abi: prefixArtifact.abi, functionName: 'verifyFtUnlockPrefixes',
		args: [
			depositVector.raw, depositVector.parents, depositVector.ancestors,
			depositVector.signaturePushOffsets,
		],
	});
	const depositReplayData = encodeFunctionData({
		abi: replayArtifact.abi, functionName: 'consume',
		args: [
			`0x${depositVector.intent.sourceContractId}`, depositVector.txid, depositVector.depositId,
		],
	});
	const estimateDepositGas = async (data: Hex, artifact = depositArtifact) => {
		const response = await rpc('eth_estimateGas', [
			{ to: OVERRIDE_ADDRESS, data }, 'latest',
			{ [OVERRIDE_ADDRESS]: { code: artifact.deployedBytecode } },
		]);
		if (response.error || !response.result) {
			throw new Error(`Phase 3D gas estimation failed: ${JSON.stringify(response.error)}`);
		}
		return BigInt(response.result);
	};
	const [depositInspectGas, depositMerkleGas, depositTransitionGas,
		depositAuthenticatedTransitionGas, depositAuthorizedTransitionGas,
		depositPrefixGas, depositReplayGas] = await Promise.all([
		estimateDepositGas(depositInspectData), estimateDepositGas(depositMerkleData),
		estimateDepositGas(depositTransitionData),
		estimateDepositGas(depositAuthenticatedTransitionData),
		estimateDepositGas(depositAuthorizedTransitionData, authorizationArtifact),
		estimateDepositGas(depositPrefixData, prefixArtifact),
		estimateDepositGas(depositReplayData, replayArtifact),
	]);
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
	const profile = await call(relayHarness, 'profileSixHeaders', [
		RELAY_HEADERS.map((header) => `0x${serializeBlockHeader(header).toString('hex')}`), relayWitnesses,
	]) as readonly [bigint, readonly bigint[]];
	assert.equal(profile[1].length, 6);
	const deploymentEstimateResponse = await rpc('eth_estimateGas', [{ data: relayArtifact.bytecode }]);
	if (deploymentEstimateResponse.error || !deploymentEstimateResponse.result) {
		throw new Error(`Relay deployment gas estimation failed: ${JSON.stringify(deploymentEstimateResponse.error)}`);
	}
	const deploymentGasEstimate = BigInt(deploymentEstimateResponse.result);
	const gasPriceResponse = await rpc('eth_gasPrice', []);
	if (gasPriceResponse.error || !gasPriceResponse.result) {
		throw new Error(`Gas-price lookup failed: ${JSON.stringify(gasPriceResponse.error)}`);
	}
	const suggestedGasPriceWei = BigInt(gasPriceResponse.result);
	const encodedSubmissions = RELAY_HEADERS.map((header, index) => encodeFunctionData({
		abi: relayArtifact.abi, functionName: 'submitHeader',
		args: [`0x${serializeBlockHeader(header).toString('hex')}`, relayWitnesses[index]],
	}));
	const directGasEstimates = await Promise.all(encodedSubmissions.map(async (data, index) => {
		const response = await rpc('eth_estimateGas', [
			{ to: OVERRIDE_ADDRESS, data }, 'latest',
			{ [OVERRIDE_ADDRESS]: { code: relayArtifact.deployedBytecode, stateDiff: relayStorage(index) } },
		]);
		if (response.error || !response.result) {
			throw new Error(`Header ${RELAY_HEADERS[index].height} gas estimation failed: ${JSON.stringify(response.error)}`);
		}
		return BigInt(response.result);
	}));
	const submissionProfile = RELAY_HEADERS.map((header, index) => {
		const data = encodedSubmissions[index];
		const intrinsicGas = 21_000n + calldataGas(data);
		return {
			height: header.height,
			bootstrapWitnesses: relayWitnesses[index].length,
			calldataBytes: (data.length - 2) / 2,
			executionGas: profile[1][index],
			indicativeTransactionGas: intrinsicGas + profile[1][index],
			directTransactionGasEstimate: directGasEstimates[index],
		};
	});
	const directSixHeaderTransactionGasEstimate = directGasEstimates.reduce((total, gas) => total + gas, 0n);
	console.log(JSON.stringify({
		deploymentGasEstimate,
		suggestedGasPriceWei,
		deploymentFeeAtSuggestedGasPriceWei: deploymentGasEstimate * suggestedGasPriceWei,
		deploymentFeeAtSuggestedGasPriceHype: formatEther(deploymentGasEstimate * suggestedGasPriceWei),
		phase3dDepositEnvelope: {
			rawTransactionBytes: (depositVector.raw.length - 2) / 2,
			parentTransactionBytes: depositVector.parents.reduce(
				(total, parent) => total + (parent.length - 2) / 2, 0,
			),
			ancestorTransactionBytes: depositVector.ancestors.flat().reduce(
				(total, ancestor) => total + (ancestor.length - 2) / 2, 0,
			),
			inspectCalldataBytes: (depositInspectData.length - 2) / 2,
			inspectTransactionGasEstimate: depositInspectGas,
			merkleCalldataBytes: (depositMerkleData.length - 2) / 2,
			merkleTransactionGasEstimate: depositMerkleGas,
			transitionCalldataBytes: (depositTransitionData.length - 2) / 2,
			transitionTransactionGasEstimate: depositTransitionGas,
			authenticatedTransitionCalldataBytes:
				(depositAuthenticatedTransitionData.length - 2) / 2,
			authenticatedTransitionTransactionGasEstimate: depositAuthenticatedTransitionGas,
			authorizedTransitionCalldataBytes: (depositAuthorizedTransitionData.length - 2) / 2,
			authorizedTransitionTransactionGasEstimate: depositAuthorizedTransitionGas,
			unlockPrefixCalldataBytes: (depositPrefixData.length - 2) / 2,
			unlockPrefixTransactionGasEstimate: depositPrefixGas,
			replayWriteCalldataBytes: (depositReplayData.length - 2) / 2,
			replayWriteTransactionGasEstimate: depositReplayGas,
		},
		proofMintGateway: {
			deploymentGasEstimate: proofGatewayDeploymentGasEstimate,
			mintCalldataBytes: (gatewayMintData.length - 2) / 2,
			mintTransactionGasEstimate: gatewayMintGasEstimate,
		},
		inHarnessDeploymentExecutionGas: profile[0],
		submissions: submissionProfile,
		indicativeSixHeaderTransactionGas: submissionProfile.reduce(
			(total, entry) => total + entry.indicativeTransactionGas, 0n,
		),
		directSixHeaderTransactionGasEstimate,
		directSixHeaderFeeAtSuggestedGasPriceWei: directSixHeaderTransactionGasEstimate * suggestedGasPriceWei,
		directSixHeaderFeeAtSuggestedGasPriceHype: formatEther(
			directSixHeaderTransactionGasEstimate * suggestedGasPriceWei,
		),
	}, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
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
		`0x${REAL_MT_DEPOSIT_TXID}`,
		REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionIndex,
		REAL_MT_DEPOSIT_MERKLE_BRANCH.transactionCount,
		REAL_MT_DEPOSIT_MERKLE_BRANCH.siblings.map((sibling) => `0x${sibling}`),
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

	console.log('Phase 3 Solidity, Phase 3D envelope/transition/input-authorization/full unlock-prefix/replay/proof-mint gateway and six-header relay vectors passed through read-only HyperEVM Testnet eth_call.');
	console.log('No contract was deployed and no transaction or asset movement was submitted.');
}

if (require.main === module) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
