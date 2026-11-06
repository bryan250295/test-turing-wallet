import type { SignTransaction } from 'turing-wallet-provider';
import { API_URLS } from '../../../shared/src/config/constants';
import type {
	Phase3TestnetDepositBroadcast, Phase3TestnetDepositTerms, SignedPhase3TestnetDeposit,
	UnsignedPhase3TestnetDeposit,
} from '../../../shared/src/types/phase3TestnetDeposit';
import { ApiError } from './apiClient';
import { backendFetch } from './backendClient';

async function post(url: string, body: unknown, signal: AbortSignal) {
	const response = await backendFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(95_000)]), cache: 'no-store' });
	const payload = await response.json().catch(() => null);
	if (!response.ok) throw new ApiError(typeof payload?.message === 'string' ? payload.message : 'The v2 deposit service is unavailable.', { status: response.status });
	return payload?.data;
}
export async function buildPhase3TestnetDeposit(terms: Phase3TestnetDepositTerms, signal: AbortSignal) {
	const value = await post(API_URLS.phase3TestnetDepositBuild, terms, signal);
	if (!value || typeof value.buildId !== 'string' || value.network !== 'testnet' || value.terms?.sender !== terms.sender || value.terms?.contractId?.toLowerCase() !== terms.contractId.toLowerCase() || value.terms?.recipient?.toLowerCase() !== terms.recipient.toLowerCase() || typeof value.rawHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value.rawHex) || !Array.isArray(value.inputs) || !Array.isArray(value.outputs) || !/^\d+$/.test(value.feeRaw)) throw new Error('The backend returned an invalid v2 deposit review.');
	return value as UnsignedPhase3TestnetDeposit;
}
export async function phase3TestnetDepositSigningRequest(transaction: UnsignedPhase3TestnetDeposit, signal: AbortSignal) {
	const value = await post(API_URLS.phase3TestnetDepositSigningRequest, { buildId: transaction.buildId }, signal);
	const expected = { txraws: [transaction.rawHex], utxos_satoshis: [transaction.inputs.map((input) => Number(input.nativeAmountRaw))], script_pubkeys: [transaction.inputs.map((input) => input.scriptHex)] };
	if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('The wallet signing request differs from the reviewed v2 deposit.');
	return value as SignTransaction;
}
export async function finalizePhase3TestnetDeposit(buildId: string, publicKey: string, signatures: string[], signal: AbortSignal) {
	const value = await post(API_URLS.phase3TestnetDepositFinalize, { buildId, publicKey, signatures }, signal);
	if (!value || typeof value.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(value.txid) || typeof value.rawHex !== 'string' || value.signaturesVerified !== true || value.proofVerified !== true || typeof value.depositId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.depositId)) throw new Error('The backend did not return a locally verified v2 deposit.');
	return value as SignedPhase3TestnetDeposit;
}
export async function broadcastPhase3TestnetDeposit(buildId: string, txid: string, checkOnly: boolean, signal: AbortSignal) {
	try {
		const value = await post(API_URLS.phase3TestnetDepositBroadcast, { buildId, action: checkOnly ? 'check' : 'submit', confirmed: true }, signal);
		if (!value || value.txid !== txid || !['submitted', 'unknown', 'rejected'].includes(value.status) || typeof value.message !== 'string') throw new Error('Unexpected v2 deposit submission response.');
		return value as Phase3TestnetDepositBroadcast;
	} catch (cause) {
		if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) throw cause;
		return { txid, status: 'unknown', message: 'Submission acknowledgement was interrupted. Check this TXID before creating another deposit.', updatedAt: new Date().toISOString(), scriptChecksVerified: false } as Phase3TestnetDepositBroadcast;
	}
}
