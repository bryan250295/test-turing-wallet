import assert from 'node:assert/strict';
import test from 'node:test';
import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import { decodeLegacyFtCode } from '../legacy-ft-code';
import { buildBridgeCovenantScript, bridgeCovenantFtController, type BridgeCovenantIntent } from './bridge-covenant';
import {
	LEGACY_FT_DEPOSIT_PROOF_SCHEMA, verifyLegacyFtDepositProof,
	type LegacyFtDepositProofV1, type LegacyFtProofPolicy,
} from './legacy-ft-proof';
import { PINNED_MT_V3_GENESIS_RAW, PINNED_MT_V3_MINT_SOURCE_RAW } from './pinned-mt-v3.vector';

const senderKey = tbc.PrivateKey.fromHex('11'.repeat(32), tbc.Networks.testnet);
const reserveKey = tbc.PrivateKey.fromHex('22'.repeat(32), tbc.Networks.testnet);
const sender = senderKey.toAddress().toString();
const gateway = '0x1111111111111111111111111111111111111111' as const;

test('freezes the real tbcdev MT legacy-v3 genesis and contract-controller encoding', () => {
	const genesis = new tbc.Transaction(PINNED_MT_V3_GENESIS_RAW);
	const source = new tbc.Transaction(PINNED_MT_V3_MINT_SOURCE_RAW);
	assert.equal(genesis.hash, 'ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c');
	assert.equal(source.hash, '0756eb73f180ce6abfeaf5f343ffcc63909f6fb4028f7a1e209a045890affdb2');
	assert.equal(genesis.inputs[0].prevTxId.toString('hex'), source.hash);
	assert.deepEqual(decodeLegacyFtCode(genesis.outputs[0].script.toHex()), {
		artifactId: 'ft-v3-npm-1.6.1-1.6.5', family: 'FT', version: 3, coin: false, codeBytes: 1884, partialOffset: 1856, tapeSize: 73,
		originalUTXOWire36Hex: 'b2fdaf9058049a201e7a8f02b46f9f9063ccff43f3f5eabf6ace80f173eb560700000000',
	});
	assert.equal(sdk.getFtBalanceFromTape(genesis.outputs[1].script.toHex()), 10_000_000n);
	assert.ok(sdk.buildFtPrePreTxData(genesis, 0, [source]).length > 0);
	const covenant = buildBridgeCovenantScript({
		sourceContractId: genesis.hash, destinationChainId: 998n, destinationGateway: gateway,
		recipient: '0x8221fae04189f1f2f50268495ed95d1a9b220432', amountRaw: 10_000_000n, depositNonce: 1n,
		reserveControllerPubKeyHash: reserveKey.toAddress().hashBuffer.toString('hex'),
	});
	const controlled = sdk.FT.buildFTtransferCode(genesis.outputs[0].script.toHex(), bridgeCovenantFtController(covenant));
	const controller = controlled.chunks[controlled.chunks.length - 2].buf!;
	assert.equal(controller.length, 21);
	assert.equal(controller[20], 1);
	assert.equal(decodeLegacyFtCode(controlled.toHex())?.version, 3);
});

function buildVector() {
	const ft = new sdk.FT({ name: 'Phase 2 Vector', symbol: 'P2V', amount: 1000, decimal: 1 });
	const [sourceRaw, genesisRaw] = ft.MintFT(senderKey, sender, {
		txId: 'aa'.repeat(32), outputIndex: 0, script: tbc.Script.buildPublicKeyHashOut(sender).toHex(), satoshis: 20_000_000,
	});
	const source = new tbc.Transaction(sourceRaw);
	const genesis = new tbc.Transaction(genesisRaw);
	const amount = 4_000n;
	const intent: BridgeCovenantIntent = {
		sourceContractId: genesis.hash,
		destinationChainId: 998n,
		destinationGateway: gateway,
		recipient: '0x8221fae04189f1f2f50268495ed95d1a9b220432',
		amountRaw: amount,
		depositNonce: 7n,
		reserveControllerPubKeyHash: reserveKey.toAddress().hashBuffer.toString('hex'),
	};
	const covenant = buildBridgeCovenantScript(intent);
	const controller = bridgeCovenantFtController(covenant);
	const slots = genesis.outputs[1].script.chunks[2].buf!;
	const inputBalance = sdk.getFtBalanceFromTape(genesis.outputs[1].script.toHex());
	const { amountHex, changeHex } = sdk.FT.buildTapeAmount(amount, [inputBalance]);
	const nativeParent = new tbc.Transaction().from({
		txId: 'bb'.repeat(32), outputIndex: 0, script: tbc.Script.buildPublicKeyHashOut(sender).toHex(), satoshis: 1_000_000,
	}).to(sender, 900_000).fee(100_000);
	const deposit = new tbc.Transaction()
		.from({ txId: genesis.hash, outputIndex: 0, script: genesis.outputs[0].script.toHex(), satoshis: 500, ftBalance: inputBalance })
		.from({ txId: nativeParent.hash, outputIndex: 0, script: nativeParent.outputs[0].script.toHex(), satoshis: nativeParent.outputs[0].satoshis })
		.addOutput(new tbc.Transaction.Output({ script: covenant, satoshis: 100 }))
		.addOutput(new tbc.Transaction.Output({ script: sdk.FT.buildFTtransferCode(genesis.outputs[0].script.toHex(), controller), satoshis: 500 }))
		.addOutput(new tbc.Transaction.Output({ script: sdk.FT.buildFTtransferTape(genesis.outputs[1].script.toHex(), amountHex), satoshis: 0 }))
		.addOutput(new tbc.Transaction.Output({ script: sdk.FT.buildFTtransferCode(genesis.outputs[0].script.toHex(), sender), satoshis: 500 }))
		.addOutput(new tbc.Transaction.Output({ script: sdk.FT.buildFTtransferTape(genesis.outputs[1].script.toHex(), changeHex), satoshis: 0 }))
		.feePerKb(80)
		.change(sender);
	const ancestorData = sdk.buildFtPrePreTxData(genesis, 0, [source]);
	deposit.setInputScript({ inputIndex: 0 }, (current) => {
		const signature = current.getSignature(0, senderKey);
		if (typeof signature !== 'string') throw new Error('Expected one legacy FT signature.');
		return sdk.FT.getFTunlock(signature, senderKey.toPublicKey().toHex(), current, genesis, ancestorData, 0, 0, false);
	});
	deposit.sign(senderKey).seal();
	assert.equal(slots.readBigUInt64LE(0), inputBalance);
	assert.equal(deposit.verifyScript(0).success, true);
	assert.equal(deposit.verifyScript(1).success, true);
	const proof: LegacyFtDepositProofV1 = {
		schemaVersion: LEGACY_FT_DEPOSIT_PROOF_SCHEMA,
		network: 'testnet',
		depositTransaction: deposit.uncheckedSerialize(),
		genesisTransaction: genesisRaw,
		inputProofs: [
			{ vin: 0, parentTransaction: genesisRaw, ancestorTransactions: [sourceRaw] },
			{ vin: 1, parentTransaction: nativeParent.uncheckedSerialize(), ancestorTransactions: [] },
		],
	};
	const policy: LegacyFtProofPolicy = {
		expectedSourceContractId: genesis.hash,
		expectedLegacyVersion: 4,
		expectedDestinationChainId: 998n,
		expectedDestinationGateway: gateway,
		expectedReserveControllerPubKeyHash: reserveKey.toAddress().hashBuffer.toString('hex'),
	};
	return { proof, policy, intent, deposit };
}

test('verifies a bounded legacy FT transition into a contract-controlled Covenant', () => {
	const { proof, policy, intent, deposit } = buildVector();
	const verified = verifyLegacyFtDepositProof(proof, policy);
	assert.equal(verified.txid, deposit.hash);
	assert.equal(verified.sourceVout, 1);
	assert.equal(verified.amountRaw, intent.amountRaw);
	assert.equal(verified.intent.recipient, intent.recipient);
	assert.equal(verified.sourceContractId, policy.expectedSourceContractId);
	assert.match(verified.depositId, /^0x[0-9a-f]{64}$/);
	assert.ok(verified.feeRaw > 0n && verified.proofBytes > 0);
});

test('fails closed on recipient, amount, controller, destination and proof mutations', () => {
	const { proof, policy } = buildVector();
	const transaction = new tbc.Transaction(proof.depositTransaction);
	const parsed = transaction.outputs[0].script.chunks[0].buf!;
	const mutate = (offset: number) => {
		const tx = new tbc.Transaction(proof.depositTransaction);
		const payload = Buffer.from(parsed); payload[offset] ^= 1;
		const chunks = tx.outputs[0].script.chunks;
		tx.outputs[0].setScript(new tbc.Script().add(payload).add(chunks[1].opcodenum).add(chunks[2].opcodenum)
			.add(chunks[3].opcodenum).add(chunks[4].buf!).add(chunks[5].opcodenum).add(chunks[6].opcodenum));
		return { ...proof, depositTransaction: tx.uncheckedSerialize() };
	};
	assert.throws(() => verifyLegacyFtDepositProof(mutate(160), policy)); // recipient
	assert.throws(() => verifyLegacyFtDepositProof(mutate(190), policy)); // amount
	assert.throws(() => verifyLegacyFtDepositProof(mutate(250), policy)); // controller
	assert.throws(() => verifyLegacyFtDepositProof(proof, { ...policy, expectedDestinationChainId: 999n }), /destination/);
	assert.throws(() => verifyLegacyFtDepositProof(proof, { ...policy, expectedReserveControllerPubKeyHash: '00'.repeat(20) }), /reserve controller/);
	assert.throws(() => verifyLegacyFtDepositProof({ ...proof, inputProofs: proof.inputProofs.slice(0, 1) }, policy), /every bounded input|count differs/);
});

test('rejects a non-covenant custody transfer and a wrong route identity', () => {
	const { proof, policy } = buildVector();
	const tx = new tbc.Transaction(proof.depositTransaction);
	tx.outputs[0].setScript(tbc.Script.buildPublicKeyHashOut(sender));
	assert.throws(() => verifyLegacyFtDepositProof({ ...proof, depositTransaction: tx.uncheckedSerialize() }, policy), /Bridge Covenant|unsupported shape/);
	assert.throws(() => verifyLegacyFtDepositProof(proof, { ...policy, expectedSourceContractId: '00'.repeat(32) }), /route policy/);
});
