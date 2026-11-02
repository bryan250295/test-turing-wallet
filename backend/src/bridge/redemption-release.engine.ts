import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import { API_URLS, DEVNET_API_BASE } from '../../../shared/src/config/constants';
import { isObject } from '../../../shared/src/services/apiValidation';
import { readBridgeSource } from './bridge-source-read';
import { sizingPublicKey, sizingSignatures } from '../htlc/engine/recoveryFee';

function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new UnprocessableEntityException(message); }
export type ReleaseInput = { txId: string; outputIndex: number; script: string; satoshis: number };
export interface ReleaseMaterial { reserve: tbc.Transaction; proof: string; token: ReleaseInput; amountRaw: string; custodyAddress: string; recipient: string; publicKey: string }
export function buildRelease(material: ReleaseMaterial, funding: ReleaseInput) {
	const { reserve, token, amountRaw, custodyAddress, recipient, publicKey, proof } = material;
	const balance = sdk.getFtBalanceFromTape(reserve.outputs[token.outputIndex + 1].script.toHex());
	requireValue(balance.toString() === amountRaw, 'This first release supports the full original source token deposit only.');
	const { amountHex } = sdk.FT.buildTapeAmount(BigInt(amountRaw), [balance]);
	const nativeScript = tbc.Script.buildPublicKeyHashOut(custodyAddress);
	const assemble = (fee: number) => {
		const tx = new tbc.Transaction().from([token, funding]);
		tx.addOutput(new tbc.Transaction.Output({ script: sdk.FT.buildFTtransferCode(token.script, recipient), satoshis: 500 }));
		tx.addOutput(new tbc.Transaction.Output({ script: sdk.FT.buildFTtransferTape(reserve.outputs[token.outputIndex + 1].script.toHex(), amountHex), satoshis: 0 }));
		const change = funding.satoshis - fee;
		requireValue(Number.isSafeInteger(change) && change >= 500, 'The fee input needs more native test TBC. No source tokens will be deducted.');
		tx.addOutput(new tbc.Transaction.Output({ script: nativeScript, satoshis: change }));
		return tx;
	};
	// Placeholder signatures are used only to measure serialized size. No key is
	// loaded, no signature is made and no sizing transaction leaves this module.
	const sizing = assemble(80);
	sizing.inputs[0].setScript(sdk.FT.getFTunlock(sizingSignatures[0], publicKey || sizingPublicKey, sizing, reserve, proof, 0, token.outputIndex));
	sizing.inputs[1].setScript(tbc.Script.fromASM(`${sizingSignatures[0]} ${publicKey || sizingPublicKey}`));
	const estimatedBytes = sizing.toBuffer().length + 128;
	requireValue(estimatedBytes <= 1_000_000, 'The FT release proof exceeds the supported size.');
	const minimum = Math.max(80, Math.ceil(estimatedBytes * 80 / 1000));
	const feeRaw = Math.ceil(minimum * 120 / 100);
	const unsigned = assemble(feeRaw);
	const unsignedRaw = unsigned.uncheckedSerialize();
	return { unsignedRaw, feeRaw, estimatedBytes, fundingRequiredRaw: feeRaw + 1000,
		planHash: createHash('sha256').update(unsignedRaw).digest('hex'), inputs: [token, funding] };
}

@Injectable()
export class RedemptionReleaseEngine {
	async raw(txid: string, signal: AbortSignal) {
		requireValue(/^[0-9a-f]{64}$/.test(txid), 'Invalid source TXID.');
		const data = await readBridgeSource(API_URLS.rawTransaction(txid), signal);
		requireValue(typeof data.txraw === 'string' && /^(?:[0-9a-f]{2})+$/i.test(data.txraw) && data.txraw.length <= 2_000_000, 'Source transaction bytes are unavailable or too large.');
		const tx = new tbc.Transaction(data.txraw);
		requireValue(tx.hash === txid && tx.toBuffer().toString('hex') === data.txraw.toLowerCase(), 'Raw source TXID or encoding mismatch.');
		return tx;
	}
	async material(reserveTxid: string, vout: number, amountRaw: string, custodyAddress: string, recipient: string, publicKey: string, signal: AbortSignal): Promise<ReleaseMaterial> {
		const reserve = await this.raw(reserveTxid, signal);
		requireValue(vout === 0 && reserve.outputs[0]?.satoshis === 500 && reserve.outputs[1]?.satoshis === 0, 'Unsupported reserve output layout.');
		const tape = reserve.outputs[1].script.chunks[2]?.buf;
		requireValue(tape?.length === 48 && sdk.getFtBalanceFromTape(reserve.outputs[1].script.toHex()).toString() === amountRaw, 'Reserve FT amount differs from the redemption.');
		const ancestors: tbc.Transaction[] = [];
		for (let slot = 0; slot < 6; slot++) {
			if (tape.readBigUInt64LE(slot * 8) === 0n) continue;
			const input = reserve.inputs[slot]; requireValue(input, 'Missing reserve ancestry.');
			ancestors.push(await this.raw(input.prevTxId.toString('hex'), signal));
		}
		const proof = sdk.buildFtPrePreTxData(reserve, vout, ancestors);
		return { reserve, proof, token: { txId: reserveTxid, outputIndex: vout, script: reserve.outputs[vout].script.toHex(), satoshis: 500 }, amountRaw, custodyAddress, recipient, publicKey };
	}
	quote(material: ReleaseMaterial) {
		const fake: ReleaseInput = { txId: '11'.repeat(32), outputIndex: 0, script: tbc.Script.buildPublicKeyHashOut(material.custodyAddress).toHex(), satoshis: 1_000_000 };
		const plan = buildRelease(material, fake);
		return { feeRaw: String(plan.feeRaw), fundingRequiredRaw: String(plan.fundingRequiredRaw), estimatedBytes: plan.estimatedBytes, feeRateSatPerKb: 80, marginPercent: 20, nativeDecimals: 6 as const };
	}
	async nativeUnspent(address: string, txid: string, vout: number, value: number, signal: AbortSignal) {
		let cursor = ''; const seen = new Set<string>();
		for (let page = 0; page < 10; page++) {
			const url = new URL(API_URLS.nativeUtxos(address)); url.searchParams.set('limit', '1000'); if (cursor) url.searchParams.set('after', cursor);
			const data = await readBridgeSource(url, signal); requireValue(Array.isArray(data.utxos), 'The native fee UTXO index is unavailable.');
			if (data.utxos.some((row: unknown) => isObject(row) && row.txid === txid && row.index === vout && String(row.value ?? row.satoshis) === String(value))) return;
			if (!data.next_cursor) break;
			requireValue(typeof data.next_cursor === 'string' && !seen.has(data.next_cursor), 'Invalid fee UTXO pagination.'); cursor = data.next_cursor; seen.add(cursor);
		}
		throw new ConflictException('The saved native fee input is not unspent at this custody address. Reconcile funding; do not pay again automatically.');
	}
	async confirmed(txid: string, signal: AbortSignal, allowUnconfirmed = false) {
		const first = await readBridgeSource(API_URLS.transaction(txid), signal);
		// Observation of the exact already-broadcast release may legitimately have no block yet.
		// Funding keeps the default strict path; this never authorizes a payout or completion.
		if (allowUnconfirmed && first.txid === txid && first.confirmations === 0
			&& (first.blockhash == null || first.blockhash === '' || typeof first.blockhash === 'string' && /^0{64}$/.test(first.blockhash))) {
			return { blockHash: null, blockHeight: null, confirmations: 0 };
		}
		requireValue(first.txid === txid && typeof first.blockhash === 'string' && /^[0-9a-f]{64}$/.test(first.blockhash) && Number.isSafeInteger(first.blockheight) && Number(first.blockheight) >= 0, 'The source transaction needs a confirmed canonical block.');
		const [block, latest] = await Promise.all([readBridgeSource(`${DEVNET_API_BASE}/blockByHeight/height/${first.blockheight}`, signal), readBridgeSource(API_URLS.transaction(txid), signal)]);
		requireValue(block.hash === first.blockhash && block.height === first.blockheight && latest.txid === txid && latest.blockhash === block.hash && latest.blockheight === block.height
			&& Number.isSafeInteger(first.confirmations) && Number.isSafeInteger(latest.confirmations) && Number.isSafeInteger(block.confirmations), 'The source transaction block changed.');
		return { blockHash: first.blockhash, blockHeight: Number(first.blockheight), confirmations: Math.max(0, Math.min(Number(first.confirmations), Number(latest.confirmations), Number(block.confirmations))) };
	}
	async funding(material: ReleaseMaterial, txid: string, signal: AbortSignal) {
		const tx = await this.raw(txid, signal);
		const script = tbc.Script.buildPublicKeyHashOut(material.custodyAddress).toHex();
		const matches = tx.outputs.map((output, index) => ({ output, index })).filter(({ output }) => output.script.toHex() === script);
		requireValue(matches.length === 1, 'Use a funding transaction with one native TBC output to this custody address.');
		const { output, index } = matches[0];
		requireValue(Number.isSafeInteger(output.satoshis) && output.satoshis > 0 && output.satoshis <= 1_000_000, 'Fee funding must be at most 1 native test TBC; excess funds are not automatically refunded.');
		const confirmation = await this.confirmed(txid, signal);
		requireValue(confirmation.confirmations >= 6, 'Wait for 6 confirmations of the native TBC fee funding, then recheck the same TXID.');
		await this.nativeUnspent(material.custodyAddress, txid, index, output.satoshis, signal);
		const funding: ReleaseInput = { txId: txid, outputIndex: index, script, satoshis: output.satoshis };
		const plan = buildRelease(material, funding);
		requireValue(output.satoshis >= plan.fundingRequiredRaw, 'This funding output is insufficient for the release proof and native change budget. Retain its TXID for review.');
		return { ...plan, funding, fundingRaw: tx.uncheckedSerialize() };
	}
	assertPlan(unsignedRaw: string, expected: { inputs: ReleaseInput[]; recipient: string; amountRaw: string; custodyAddress: string; feeRaw: bigint; reserveRaw: string }) {
		const tx = new tbc.Transaction(unsignedRaw); const reserve = new tbc.Transaction(expected.reserveRaw);
		requireValue(tx.inputs.length === 2 && tx.outputs.length === 3 && tx.nLockTime === 0, 'Unexpected release transaction structure.');
		for (let i = 0; i < 2; i++) {
			const input = expected.inputs[i];
			requireValue(tx.inputs[i].prevTxId.toString('hex') === input.txId && tx.inputs[i].outputIndex === input.outputIndex && tx.inputs[i].sequenceNumber === 0xffffffff, 'Release input differs from its reservation.');
			tx.inputs[i].output = new tbc.Transaction.Output({ script: new tbc.Script(input.script), satoshis: input.satoshis });
		}
		const code = sdk.FT.buildFTtransferCode(reserve.outputs[0].script.toHex(), expected.recipient).toHex();
		const allocation = sdk.FT.buildTapeAmount(BigInt(expected.amountRaw), [BigInt(expected.amountRaw)]);
		requireValue(tx.outputs[0].satoshis === 500 && tx.outputs[0].script.toHex() === code && tx.outputs[1].satoshis === 0
			&& tx.outputs[1].script.toHex() === sdk.FT.buildFTtransferTape(reserve.outputs[1].script.toHex(), allocation.amountHex).toHex()
			&& tx.outputs[2].script.toHex() === tbc.Script.buildPublicKeyHashOut(expected.custodyAddress).toHex() && tx.outputs[2].satoshis >= 500, 'Release source token payout or native change differs from frozen terms.');
		const paidFee = expected.inputs.reduce((sum, input) => sum + BigInt(input.satoshis), 0n) - tx.outputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n);
		requireValue(paidFee === expected.feeRaw, 'Release fee differs from the reviewed plan.');
		return tx;
	}
	sign(unsignedRaw: string, material: ReleaseMaterial, funding: ReleaseInput, feeRaw: bigint, key: tbc.PrivateKey) {
		const tx = this.assertPlan(unsignedRaw, { inputs: [material.token, funding], recipient: material.recipient, amountRaw: material.amountRaw, custodyAddress: material.custodyAddress, feeRaw, reserveRaw: material.reserve.uncheckedSerialize() });
		requireValue(key.compressed && key.toAddress('livenet').toString() === material.custodyAddress && key.toPublicKey().toString() === material.publicKey, 'The signing key does not match the reserved custody address.');
		const ft = new sdk.FT(material.reserve.hash);
		tx.setInputScript({ inputIndex: 0 }, (current) => ft.getFTunlock(key, current, material.reserve, material.proof, 0, material.token.outputIndex));
		// Serialized transactions restore generic Input objects. Their addSignature
		// is a no-op, so Transaction.sign() alone cannot fill the native P2PKH
		// input. Explicitly assemble its ALL|FORKID unlock against the same saved
		// prevout and outputs; never replace the frozen input or recalculate change.
		tx.setInputScript({ inputIndex: 1 }, (current) => {
			const hex = current.getSignature(1, key, 0x41);
			requireValue(typeof hex === 'string' && /^(?:[0-9a-f]{2})+$/i.test(hex), 'The native fee signature could not be constructed.');
			const signature = tbc.crypto.Signature.fromTxFormat(Buffer.from(hex, 'hex'));
			requireValue(signature.nhashtype === 0x41, 'The native fee signature must commit to every input and output.');
			return tbc.Script.buildPublicKeyHashIn(key.toPublicKey(), signature.toDER(), 0x41);
		});
		tx.seal();
		const raw = tx.uncheckedSerialize();
		requireValue(raw.slice(0, 8) === unsignedRaw.slice(0, 8), 'Signing changed the saved transaction version.');
		const signed = this.assertPlan(raw, { inputs: [material.token, funding], recipient: material.recipient, amountRaw: material.amountRaw, custodyAddress: material.custodyAddress, feeRaw, reserveRaw: material.reserve.uncheckedSerialize() });
		for (let i = 0; i < signed.inputs.length; i++) {
			const check = signed.verifyScript(i);
			const code = typeof check.error === 'string' && /^[A-Z0-9_]{1,80}$/.test(check.error) ? check.error : 'SCRIPT_CHECK_FAILED';
			requireValue(check.success, `The custody release ${i === 0 ? 'FT proof/signature' : 'native fee signature'} did not verify at input ${i} (${code}). Nothing was broadcast.`);
		}
		requireValue(feeRaw >= BigInt(Math.max(80, Math.ceil(raw.length / 2 * 80 / 1000))), 'The signed release exceeds the allocated native fee.');
		return { raw, txid: signed.hash };
	}
}
