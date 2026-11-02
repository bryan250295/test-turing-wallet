import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import type { BridgeOrder } from '../../generated/prisma/client';
import { API_URLS, DEVNET_API_BASE } from '../../../shared/src/config/constants';
import { readBridgeSource } from './bridge-source-read';
import { isObject } from '../../../shared/src/services/apiValidation';
import { BridgeAssetVerifier } from './bridge-asset.verifier';
import { isLegacyFtTape } from './legacy-ft-code';
import { BRIDGE_ASSET_POLICY as policy } from './bridge.config';

function match(value: unknown, message: string): asserts value { if (!value) throw new UnprocessableEntityException(message); }
export interface DepositObservation { txid: string; vout: number; amountRaw: string; feeRaw: string; confirmations: number; blockHash: string | null; blockHeight: number | null; checkedAt: Date }

@Injectable()
export class BridgeDepositVerifier {
	constructor(@Inject(BridgeAssetVerifier) private readonly asset: BridgeAssetVerifier) {}
	async assertAvailable(signal: AbortSignal) {
		const block = await readBridgeSource(`${DEVNET_API_BASE}/blockByHeight/height/${policy.genesisBlockHeight}`, signal);
		match(block.hash === policy.genesisBlockHash && block.height === policy.genesisBlockHeight && Number.isSafeInteger(block.confirmations) && Number(block.confirmations) >= policy.minimumConfirmations, 'The source canonical-block endpoint does not match the approved checkpoint. Payment details remain closed.');
	}
	async verify(order: BridgeOrder, address: string, txid: string, signal: AbortSignal): Promise<DepositObservation> {
		// Trust the fixed testnet node/indexer for chain inclusion and FT ancestry.
		// Independently check raw bytes, full published FT binding, exact amounts,
		// conservation, all unlocking scripts and continued custody of the output.
		await this.asset.verify(signal, order.contractId);
		const cache = new Map<string, tbc.Transaction>();
		let bytes = 0;
		async function raw(id: string) {
			if (cache.has(id)) return cache.get(id)!;
			match(cache.size < 48, 'This transfer exceeds the supported proof size. Manual review is required.');
			const data = await readBridgeSource(API_URLS.rawTransaction(id), signal);
			match(typeof data.txraw === 'string' && /^(?:[0-9a-f]{2})+$/i.test(data.txraw) && data.txraw.length <= 2_000_000, 'Invalid source transaction bytes.');
			bytes += data.txraw.length / 2;
			match(bytes <= 8_000_000, 'The transfer proof exceeds the supported size.');
			const tx = new tbc.Transaction(data.txraw);
			match(tx.hash === id && tx.toBuffer().toString('hex') === data.txraw.toLowerCase(), 'Source raw transaction ID or encoding mismatch.');
			cache.set(id, tx); return tx;
		}
		const [genesis, tx, decoded] = await Promise.all([raw(order.contractId), raw(txid), readBridgeSource(API_URLS.transaction(txid), signal)]);
		match(decoded.txid === txid && Number.isSafeInteger(decoded.confirmations) && Number(decoded.confirmations) >= 0, 'Source confirmation data is invalid.');
		match(tx.inputs.length >= 2 && tx.inputs.length <= 7 && tx.outputs.length >= 2 && tx.outputs.length <= 5, 'Only an ordinary FT transfer with up to 6 token inputs and one fee input is supported.');
		const genesisCode = genesis.outputs[0].script.toHex();
		const genesisTape = genesis.outputs[1].script.toHex();
		const custodyCode = sdk.FT.buildFTtransferCode(genesisCode, address).toHex();
		const senderCode = sdk.FT.buildFTtransferCode(genesisCode, order.sender).toHex();
		const senderNative = tbc.Script.buildPublicKeyHashOut(order.sender).toHex();
		function amount(tape: tbc.Transaction.Output | undefined) {
			match(tape && tape.satoshis === 0 && isLegacyFtTape(tape.script.toHex()), 'Invalid FT Tape output.');
			const slots = tape.script.chunks[2]?.buf;
			match(slots?.length === 48 && tape.script.toHex() === sdk.FT.buildFTtransferTape(genesisTape, slots.toString('hex')).toHex(), 'FT Tape metadata differs from the pinned source token genesis.');
			return sdk.getFtBalanceFromTape(tape.script.toHex());
		}
		match(tx.outputs[0].satoshis === 500 && tx.outputs[0].script.toHex() === custodyCode && amount(tx.outputs[1]).toString() === order.amountRaw.toFixed(0), 'The first FT output must pay the exact source token amount to this order custody address.');
		const balances: bigint[] = [];
		let nativeIn = 0n;
		const seen = new Set<string>();
		for (let index = 0; index < tx.inputs.length; index++) {
			const input = tx.inputs[index];
			const id = input.prevTxId.toString('hex');
			const key = `${id}:${input.outputIndex}`;
			match(!seen.has(key), 'Duplicate source input.'); seen.add(key);
			const parent = await raw(id);
			const output = parent.outputs[input.outputIndex];
			match(output && Number.isSafeInteger(output.satoshis) && output.satoshis >= 0, 'A source input is missing.');
			input.output = output;
			nativeIn += BigInt(output.satoshis);
			if (index === tx.inputs.length - 1) match(output.script.toHex() === senderNative, 'The native fee input must belong to the frozen TBC sender.');
			else {
				match(output.satoshis === 500 && output.script.toHex() === senderCode, 'An FT input does not match the selected token and the frozen sender.');
				const tape = parent.outputs[input.outputIndex + 1];
				const balance = amount(tape);
				match(balance > 0n, 'An FT input has no token balance.'); balances.push(balance);
				const ancestors: tbc.Transaction[] = [];
				const slots = tape.script.chunks[2].buf!;
				for (let slot = 0; slot < 6; slot++) {
					if (slots.readBigUInt64LE(slot * 8) === 0n) continue;
					const previous = parent.inputs[slot];
					match(previous, 'A legacy FT proof ancestor is missing.');
					ancestors.push(await raw(previous.prevTxId.toString('hex')));
				}
				// Parsing the SDK proof rejects unsupported parent/ancestor layouts.
				sdk.buildFtPrePreTxData(parent, input.outputIndex, ancestors);
			}
		}
		const total = balances.reduce((sum, value) => sum + value, 0n);
		const paid = BigInt(order.amountRaw.toFixed(0));
		match(total >= paid, 'FT input balance does not cover this deposit.');
		const { amountHex, changeHex } = sdk.FT.buildTapeAmount(paid, balances);
		match(tx.outputs[1].script.toHex() === sdk.FT.buildFTtransferTape(genesisTape, amountHex).toHex(), 'FT input/output slot allocation is invalid.');
		let next = 2;
		if (total > paid) {
			match(tx.outputs[2]?.satoshis === 500 && tx.outputs[2].script.toHex() === senderCode && amount(tx.outputs[3]) === total - paid
				&& tx.outputs[3].script.toHex() === sdk.FT.buildFTtransferTape(genesisTape, changeHex).toHex(), 'FT change must return the exact remaining source tokens to the frozen sender.');
			next = 4;
		}
		match(tx.outputs.length === next || tx.outputs.length === next + 1 && tx.outputs[next].script.toHex() === senderNative, 'Unsupported extra source outputs or multiple payment groups.');
		match(tx.outputs.every((output) => Number.isSafeInteger(output.satoshis) && output.satoshis >= 0), 'Invalid native source output amount.');
		const fee = nativeIn - tx.outputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n);
		match(fee > 0n, 'Invalid source transaction network fee.');
		for (let index = 0; index < tx.inputs.length; index++) { signal.throwIfAborted(); match(tx.verifyScript(index).success, `Source unlocking-script validation failed at input ${index}.`); }
		// A byte-identical copied Code alone is not an FT deposit: the fixed
		// contract-specific indexer must recognize the unspent output and amount.
		let found = false; let cursor = ''; const cursors = new Set<string>();
		for (let page = 0; page < 10; page++) {
			const url = new URL(API_URLS.tokenUtxos(address, order.contractId)); url.searchParams.set('limit', '1000');
			if (cursor) url.searchParams.set('after', cursor);
			const data = await readBridgeSource(url, signal);
			match(Array.isArray(data.utxos), 'The FT custody index is unavailable.');
			found ||= data.utxos.some((item: unknown) => isObject(item) && item.txid === txid && item.index === 0
				&& (typeof item.ft_value === 'string' && /^\d+$/.test(item.ft_value) || typeof item.ft_value === 'number' && Number.isSafeInteger(item.ft_value)) && String(item.ft_value) === paid.toString());
			if (found || !data.next_cursor) break;
			match(typeof data.next_cursor === 'string' && !cursors.has(data.next_cursor), 'Invalid FT pagination cursor.');
			cursor = data.next_cursor; cursors.add(cursor);
		}
		match(found, 'The source token output is not recognized as unspent at this order custody address. Do not pay again; refresh or request review.');
		let blockHash: string | null = null; let blockHeight: number | null = null;
		let confirmations = 0;
		if (Number(decoded.confirmations) > 0) {
			match(typeof decoded.blockhash === 'string' && /^[0-9a-f]{64}$/.test(decoded.blockhash) && Number.isSafeInteger(decoded.blockheight) && Number(decoded.blockheight) >= 0, 'Source block metadata is missing.');
			const block = await readBridgeSource(`${DEVNET_API_BASE}/blockByHeight/height/${decoded.blockheight}`, signal);
			const latest = await readBridgeSource(API_URLS.transaction(txid), signal);
			match(block.hash === decoded.blockhash && block.height === decoded.blockheight && latest.blockhash === block.hash && latest.blockheight === block.height
				&& Number.isSafeInteger(block.confirmations) && Number.isSafeInteger(latest.confirmations), 'Source block changed while validating the deposit.');
			blockHash = decoded.blockhash; blockHeight = Number(decoded.blockheight);
			confirmations = Math.max(0, Math.min(Number(decoded.confirmations), Number(block.confirmations), Number(latest.confirmations)));
		}
		signal.throwIfAborted();
		return { txid, vout: 0, amountRaw: paid.toString(), feeRaw: fee.toString(), confirmations, blockHash, blockHeight, checkedAt: new Date() };
	}
}
