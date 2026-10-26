import type { HtlcTokenLockTerms, SignedTokenHtlc, TokenHtlcBroadcast, UnsignedTokenHtlc } from '../types/htlc';
import { ApiError } from './apiClient';
import type { SignTransaction } from 'turing-wallet-provider';
import { API_URLS } from '../config/constants';

export async function postHtlcData(url: string, payload: unknown, signal: AbortSignal) {
	const response = await fetch(url, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify(payload), signal: AbortSignal.any([signal, AbortSignal.timeout(95000)]), cache: 'no-store',
	});
	if (!(response.headers.get('Content-Type') || '').includes('application/json')) throw new Error('The local HTLC builder is unavailable. Restart npm run dev in wallet/.');
	const body = await response.json();
	if (!response.ok) throw new ApiError(typeof body.message === 'string' ? body.message : 'The local HTLC request failed.', { status: response.status });
	return body.data;
}

export async function buildUnsignedTokenHtlc(terms: HtlcTokenLockTerms, signal: AbortSignal): Promise<UnsignedTokenHtlc> {
	const result = await postHtlcData(API_URLS.unsignedTokenHtlc, terms, signal);
	if (!result || result.network !== 'testnet' || typeof result.rawHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(result.rawHex) || !result.plan || !Array.isArray(result.inputs) || !Array.isArray(result.outputs) || !/^\d+$/.test(result.feeRaw)) throw new Error('Invalid unsigned transaction response.');
	return result as UnsignedTokenHtlc;
}

export async function getTokenHtlcSigningRequest(transaction: UnsignedTokenHtlc, signal: AbortSignal): Promise<SignTransaction> {
	const request = await postHtlcData(API_URLS.tokenHtlcSigningRequest, { buildId: transaction.buildId }, signal);
	if (!request || !Array.isArray(request.txraws) || request.txraws.length !== 1 || request.txraws[0] !== transaction.rawHex || JSON.stringify(request.utxos_satoshis) !== JSON.stringify([transaction.inputs.map((input) => Number(input.nativeAmountRaw))]) || JSON.stringify(request.script_pubkeys) !== JSON.stringify([transaction.inputs.map((input) => input.scriptHex)])) throw new Error('The signing request differs from the transaction you reviewed. Rebuild before signing.');
	return request as SignTransaction;
}

export async function finalizeTokenHtlc(buildId: string, publicKey: string, signatures: string[], signal: AbortSignal, secretHex?: string): Promise<SignedTokenHtlc> {
	const result = await postHtlcData(API_URLS.finalizeTokenHtlc, { buildId, publicKey, signatures, ...(secretHex ? { secretHex } : {}) }, signal);
	if (result?.secretStored !== undefined && typeof result.secretStored !== 'boolean') throw new Error('Invalid secret storage response.');
	if (!result || typeof result.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(result.txid) || typeof result.rawHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(result.rawHex) || result.signaturesVerified !== true || result.termsUnchanged !== true || !/^\d+$/.test(result.feeRaw) || !/^\d+$/.test(result.minimumFeeRaw) || typeof result.feeSufficient !== 'boolean') throw new Error('Invalid signed transaction response.');
	return result as SignedTokenHtlc;
}

export async function broadcastTokenHtlc(buildId: string, txid: string, checkOnly: boolean, signal: AbortSignal): Promise<TokenHtlcBroadcast> {
	try {
		const result = await postHtlcData(API_URLS.broadcastTokenHtlc, { buildId, action: checkOnly ? 'check' : 'submit', confirmed: true }, signal);
		if (!result || result.txid !== txid || !['submitted', 'unknown', 'rejected'].includes(result.status) || typeof result.message !== 'string' || typeof result.updatedAt !== 'string' || typeof result.scriptChecksVerified !== 'boolean') throw new Error('Unexpected submission response.');
		return result as TokenHtlcBroadcast;
	} catch (cause) {
		if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) throw cause;
		return { txid, status: 'unknown', message: 'Could not confirm the server response. Check this TXID before attempting another lock; the transaction may have reached Testnet.', updatedAt: new Date().toISOString(), scriptChecksVerified: false };
	}
}
