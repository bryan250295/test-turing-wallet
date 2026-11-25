import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import tbc from 'tbc-lib-js';
import { sizingPublicKey, sizingSignatures } from '../htlc/engine/recoveryFee';
import { RedemptionReleaseEngine } from './redemption-release.engine';

export interface NativeReleaseInput {
	txId: string;
	outputIndex: number;
	script: string;
	satoshis: number;
}

export interface NativeReleasePlan {
	unsignedRaw: string;
	planHash: string;
	feeRaw: number;
	payoutRaw: number;
	estimatedBytes: number;
	input: NativeReleaseInput;
}

function ensure(ok: unknown, message: string): asserts ok {
	if (!ok) throw new UnprocessableEntityException(message);
}

@Injectable()
export class SepoliaNativeReleaseEngine {
	constructor(private readonly source: RedemptionReleaseEngine) {}

	async prepare(reserveTxid: string, reserveVout: number, amountRaw: string, custodyAddress: string, recipient: string, signal: AbortSignal): Promise<NativeReleasePlan> {
		ensure(/^[1-9]\d{0,15}$/.test(amountRaw), 'The native TBC reserve amount is outside the supported range.');
		const amount = Number(amountRaw);
		ensure(Number.isSafeInteger(amount) && amount > 0, 'The native TBC reserve amount is unsafe.');
		try { tbc.Address.fromString(recipient, 'livenet'); } catch { throw new UnprocessableEntityException('Invalid receiving TBC address.'); }
		const reserve = await this.source.raw(reserveTxid, signal);
		const output = reserve.outputs[reserveVout];
		const custodyScript = tbc.Script.buildPublicKeyHashOut(custodyAddress).toHex();
		ensure(reserveVout === 0 && !!output && output.script.toHex() === custodyScript && output.satoshis === amount, 'The saved native TBC reserve differs from the completed deposit.');
		await this.source.nativeUnspent(custodyAddress, reserveTxid, reserveVout, amount, signal);
		const input: NativeReleaseInput = { txId: reserveTxid, outputIndex: reserveVout, script: custodyScript, satoshis: amount };
		const assemble = (fee: number) => {
			const payout = amount - fee;
			ensure(Number.isSafeInteger(payout) && payout >= 500, 'The native TBC amount is too small to pay the return network fee.');
			const tx = new tbc.Transaction().from(input);
			tx.addOutput(new tbc.Transaction.Output({ script: tbc.Script.buildPublicKeyHashOut(recipient), satoshis: payout }));
			return tx;
		};
		const sizing = assemble(80);
		sizing.inputs[0].setScript(tbc.Script.fromASM(`${sizingSignatures[0]} ${sizingPublicKey}`));
		const estimatedBytes = sizing.toBuffer().length + 32;
		ensure(estimatedBytes <= 100_000, 'The native TBC return transaction exceeds the supported size.');
		const minimum = Math.max(80, Math.ceil(estimatedBytes * 80 / 1000));
		const feeRaw = Math.ceil(minimum * 120 / 100);
		const unsigned = assemble(feeRaw);
		const unsignedRaw = unsigned.uncheckedSerialize();
		return { unsignedRaw, planHash: createHash('sha256').update(unsignedRaw).digest('hex'), feeRaw, payoutRaw: amount - feeRaw, estimatedBytes, input };
	}

	assertPlan(unsignedOrSignedRaw: string, expected: { input: NativeReleaseInput; recipient: string; payoutRaw: bigint; feeRaw: bigint; planHash?: string }) {
		const tx = new tbc.Transaction(unsignedOrSignedRaw);
		ensure(tx.inputs.length === 1 && tx.outputs.length === 1 && tx.nLockTime === 0, 'Unexpected native TBC release transaction structure.');
		ensure(tx.inputs[0].prevTxId.toString('hex') === expected.input.txId && tx.inputs[0].outputIndex === expected.input.outputIndex && tx.inputs[0].sequenceNumber === 0xffffffff, 'The native TBC release input differs from the reserved deposit.');
		tx.inputs[0].output = new tbc.Transaction.Output({ script: new tbc.Script(expected.input.script), satoshis: expected.input.satoshis });
		ensure(tx.outputs[0].script.toHex() === tbc.Script.buildPublicKeyHashOut(expected.recipient).toHex() && BigInt(tx.outputs[0].satoshis) === expected.payoutRaw, 'The native TBC payout differs from the reviewed recipient or amount.');
		ensure(BigInt(expected.input.satoshis) - BigInt(tx.outputs[0].satoshis) === expected.feeRaw, 'The native TBC network fee differs from the reviewed plan.');
		if (expected.planHash) ensure(createHash('sha256').update(unsignedOrSignedRaw).digest('hex') === expected.planHash, 'The native TBC release plan hash changed.');
		return tx;
	}

	sign(plan: NativeReleasePlan, recipient: string, custodyAddress: string, publicKey: string, key: tbc.PrivateKey) {
		const tx = this.assertPlan(plan.unsignedRaw, { input: plan.input, recipient, payoutRaw: BigInt(plan.payoutRaw), feeRaw: BigInt(plan.feeRaw), planHash: plan.planHash });
		ensure(key.compressed && key.toAddress('livenet').toString() === custodyAddress && key.toPublicKey().toString() === publicKey, 'The custody signing key does not match the reserved native TBC output.');
		tx.setInputScript({ inputIndex: 0 }, (current) => {
			const hex = current.getSignature(0, key, 0x41);
			ensure(typeof hex === 'string' && /^(?:[0-9a-f]{2})+$/i.test(hex), 'The native TBC release signature could not be constructed.');
			const signature = tbc.crypto.Signature.fromTxFormat(Buffer.from(hex, 'hex'));
			ensure(signature.nhashtype === 0x41, 'The native TBC signature must commit to the complete transaction.');
			return tbc.Script.buildPublicKeyHashIn(key.toPublicKey(), signature.toDER(), 0x41);
		});
		tx.seal();
		const raw = tx.uncheckedSerialize();
		const signed = this.assertPlan(raw, { input: plan.input, recipient, payoutRaw: BigInt(plan.payoutRaw), feeRaw: BigInt(plan.feeRaw) });
		const check = signed.verifyScript(0);
		if (!check.success) throw new ConflictException('The saved native TBC release signature did not verify. Nothing was broadcast.');
		ensure(BigInt(plan.feeRaw) >= BigInt(Math.max(80, Math.ceil(raw.length / 2 * 80 / 1000))), 'The signed native TBC release exceeds its reviewed fee.');
		return { raw, txid: signed.hash };
	}
}
