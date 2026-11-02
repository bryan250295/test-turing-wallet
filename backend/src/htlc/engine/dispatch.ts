import type { HtlcTokenLockTerms } from '../../../../shared/src/types/htlc';
import { API_URLS } from '../../../../shared/src/config/constants';

function parseTerms(value: unknown): HtlcTokenLockTerms {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid token lock terms.');
	const fields = ['sender', 'receiver', 'contractId', 'amount', 'hashHex', 'refundTime'] as const;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== fields.length || fields.some((key) => typeof record[key] !== 'string' || !record[key] || (record[key] as string).length > 256)) throw new Error('Only the six public lock terms are accepted.');
	return Object.fromEntries(fields.map((key) => [key, record[key]])) as unknown as HtlcTokenLockTerms;
}

export async function executeHtlcRequest(endpoint: string, parsed: unknown, signal: AbortSignal, deadline: number): Promise<unknown> {
	signal.throwIfAborted();
	if (endpoint === API_URLS.htlcWalletStatus) {
		const { inspectWallet } = await import('./inspectBatch');
		signal.throwIfAborted();
		return inspectWallet(parsed, signal, deadline);
	}
	const signing = await import('./tokenHtlcSigning');
	signal.throwIfAborted();
	let result: unknown;
	if (endpoint === API_URLS.unsignedTokenHtlc) {
		const terms = parseTerms(parsed);
		const { buildUnsignedTokenHtlc } = await import('./buildUnsignedTokenHtlc');
		signal.throwIfAborted();
		const transaction = await buildUnsignedTokenHtlc(terms, signal);
		signal.throwIfAborted();
		result = signing.rememberTokenHtlc(transaction);
	} else {
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid signing request.');
		const fields = parsed as Record<string, unknown>;
		if (endpoint === API_URLS.inspectTokenHtlc || endpoint === API_URLS.settleTokenHtlc) {
			if (typeof fields.lockTxid !== 'string' || !/^[0-9a-f]{64}$/i.test(fields.lockTxid) || typeof fields.contractId !== 'string' || !/^[0-9a-f]{64}$/i.test(fields.contractId)) throw new Error('Enter the lock TXID and FT contract ID.');
			const recovery = await import('./tokenHtlcRecovery');
			signal.throwIfAborted();
			if (endpoint === API_URLS.inspectTokenHtlc && Object.keys(fields).every((key) => ['lockTxid', 'contractId', 'recoveryTxids'].includes(key))) {
				const ids = fields.recoveryTxids ?? [];
				if (!Array.isArray(ids) || ids.length > 10 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id))) throw new Error('Provide up to ten recovery TXIDs.');
				result = await recovery.inspectTokenHtlc(fields.lockTxid.toLowerCase(), fields.contractId.toLowerCase(), signal, ids.map((id: string) => id.toLowerCase()));
			}
			else if (endpoint === API_URLS.settleTokenHtlc && Object.keys(fields).length === 3 && (fields.action === 'claim' || fields.action === 'refund')) result = await recovery.buildTokenHtlcRecovery(fields.lockTxid.toLowerCase(), fields.contractId.toLowerCase(), fields.action, signal);
			else throw new Error('Invalid recovery request.');
			return result;
		}
		if (typeof fields.buildId !== 'string' || !/^[0-9a-f-]{36}$/i.test(fields.buildId)) throw new Error('Build a new unsigned transaction before signing.');
		if (endpoint === API_URLS.tokenHtlcSigningRequest) {
			if (Object.keys(fields).length !== 1) throw new Error('Only a build ID is accepted.');
			result = await signing.getTokenHtlcSigningRequest(fields.buildId, signal);
		} else if (endpoint === API_URLS.broadcastTokenHtlc) {
			if (Object.keys(fields).length !== 3 || fields.confirmed !== true || !['submit', 'check'].includes(String(fields.action))) throw new Error('Explicit confirmation is required to submit this token lock.');
			result = await signing.broadcastTokenHtlc(fields.buildId, fields.action === 'check', signal);
		} else {
			const allowed = fields.secretHex === undefined ? ['buildId', 'publicKey', 'signatures'] : ['buildId', 'publicKey', 'signatures', 'secretHex'];
			if (Object.keys(fields).length !== allowed.length || Object.keys(fields).some((key) => !allowed.includes(key)) || (fields.secretHex !== undefined && (typeof fields.secretHex !== 'string' || !/^[0-9a-f]{64}$/i.test(fields.secretHex))) || typeof fields.publicKey !== 'string' || !/^(?:02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/i.test(fields.publicKey) || !Array.isArray(fields.signatures) || fields.signatures.length > 6 || fields.signatures.some((signature) => typeof signature !== 'string' || !/^(?:[0-9a-f]{2}){9,80}$/i.test(signature))) throw new Error('Invalid public key or signatures.');
			result = await signing.finalizeTokenHtlc(fields.buildId, fields.publicKey, fields.signatures as string[], signal, fields.secretHex as string | undefined);
		}
	}
	return result;
}

