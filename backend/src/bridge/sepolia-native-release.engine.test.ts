import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import tbc from 'tbc-lib-js';
import { NativeReleasePlan, SepoliaNativeReleaseEngine } from './sepolia-native-release.engine';

function compressedKey(byte: string) {
	const encoded = Buffer.from(`80${byte.repeat(32)}01`, 'hex');
	return tbc.PrivateKey.fromBuffer(encoded, 'livenet');
}

function fixture() {
	const custodyKey = compressedKey('31');
	const recipientKey = compressedKey('32');
	const custodyAddress = custodyKey.toAddress('livenet').toString();
	const recipient = recipientKey.toAddress('livenet').toString();
	const amount = 1_500_000;
	const fee = 100;
	const input = {
		txId: 'ab'.repeat(32),
		outputIndex: 0,
		script: tbc.Script.buildPublicKeyHashOut(custodyAddress).toHex(),
		satoshis: amount,
	};
	const tx = new tbc.Transaction().from(input);
	tx.addOutput(new tbc.Transaction.Output({
		script: tbc.Script.buildPublicKeyHashOut(recipient),
		satoshis: amount - fee,
	}));
	const unsignedRaw = tx.uncheckedSerialize();
	const plan: NativeReleasePlan = {
		unsignedRaw,
		planHash: createHash('sha256').update(unsignedRaw).digest('hex'),
		feeRaw: fee,
		payoutRaw: amount - fee,
		estimatedBytes: unsignedRaw.length / 2,
		input,
	};
	return { custodyKey, custodyAddress, recipient, plan };
}

test('signs one exact native TBC reserve output with ALL|FORKID', () => {
	const { custodyKey, custodyAddress, recipient, plan } = fixture();
	const engine = new SepoliaNativeReleaseEngine(null as never);
	const signed = engine.sign(plan, recipient, custodyAddress, custodyKey.toPublicKey().toString(), custodyKey);
	const tx = new tbc.Transaction(signed.raw);
	const verified = engine.assertPlan(signed.raw, {
		input: plan.input,
		recipient,
		payoutRaw: BigInt(plan.payoutRaw),
		feeRaw: BigInt(plan.feeRaw),
	});

	assert.equal(tx.hash, signed.txid);
	assert.equal(tx.inputs.length, 1);
	assert.equal(tx.outputs.length, 1);
	assert.equal(tx.outputs[0].satoshis, plan.payoutRaw);
	assert.equal(tx.outputs[0].script.toHex(), tbc.Script.buildPublicKeyHashOut(recipient).toHex());
	assert.equal(verified.verifyScript(0).success, true);
});

test('rejects a release whose reviewed payout or recipient changed', () => {
	const { recipient, plan } = fixture();
	const otherRecipient = compressedKey('33').toAddress('livenet').toString();
	const engine = new SepoliaNativeReleaseEngine(null as never);

	assert.throws(() => engine.assertPlan(plan.unsignedRaw, {
		input: plan.input,
		recipient: otherRecipient,
		payoutRaw: BigInt(plan.payoutRaw),
		feeRaw: BigInt(plan.feeRaw),
	}), /payout differs/);
	assert.throws(() => engine.assertPlan(plan.unsignedRaw, {
		input: plan.input,
		recipient,
		payoutRaw: BigInt(plan.payoutRaw - 1),
		feeRaw: BigInt(plan.feeRaw + 1),
	}), /payout differs/);
});
