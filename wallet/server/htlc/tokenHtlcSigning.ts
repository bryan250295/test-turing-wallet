import { randomUUID } from 'node:crypto';
import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import type { SignTransaction } from 'turing-wallet-provider';
import type { SignedTokenHtlc, TokenHtlcBroadcast, UnsignedTokenHtlc } from '../../src/types/htlc';
import { API_URLS } from '../../src/config/constants';
import { getApiData } from '../../src/services/apiClient';
import { getNativeUtxos, getTokenUtxos } from '../../src/services/tbcApi';
import { validateTokenLockTerms } from '../../src/utils/htlcTokenLock';
import { assertRefundMature } from './chainTime';
import { saveStoredHtlcRequest } from './requestStorage';
import { requestFromTransaction } from '../../src/utils/htlcRequestHistory';
import { saveClaimSecret } from './secretStorage';

interface SigningContext {
	transaction: UnsignedTokenHtlc;
	parentsRaw: string[];
	proofs: string[];
	expires: number;
	signed?: SignedTokenHtlc;
	broadcast?: TokenHtlcBroadcast;
	broadcasting?: boolean;
	settlement?: SettlementSigningContext;
}

export interface SettlementSigningContext {
	action: 'claim' | 'refund';
	signer: string;
	hashHex: string;
	refundTimestamp: number;
	deployRaw: string;
	proof: string;
	checkUnspent: (signal: AbortSignal) => Promise<void>;
}

// Bounded, temporary public proof data. Server restarts intentionally invalidate it.
const contexts = new Map<string, SigningContext>();

export function rememberTokenHtlc(result: UnsignedTokenHtlc & { signingContext: { parentsRaw: string[]; proofs: string[] } }, settlement?: SettlementSigningContext): UnsignedTokenHtlc {
	for (const [id, context] of contexts) if (context.expires <= Date.now()) contexts.delete(id);
	while (contexts.size >= 10) contexts.delete(contexts.keys().next().value!);
	const { signingContext, ...transaction } = result;
	const expires = settlement ? Date.now() + 15 * 60_000 : Math.min(Date.now() + 15 * 60_000, transaction.plan.refundTimestamp * 1000);
	transaction.buildId = randomUUID();
	transaction.signingExpiresAt = new Date(expires).toISOString();
	contexts.set(transaction.buildId, { transaction, ...signingContext, expires, settlement });
	return transaction;
}

function getContext(buildId: string) {
	const context = contexts.get(buildId);
	if (!context || context.expires <= Date.now()) {
		contexts.delete(buildId);
		throw new Error('The signing session expired or the server restarted. Build a new unsigned transaction.');
	}
	if (!context.settlement) validateTokenLockTerms(context.transaction.plan.terms);
	return context;
}

async function checkInputs(context: SigningContext, signal: AbortSignal) {
	if (context.settlement) {
		if (context.settlement.action === 'refund') await assertRefundMature(context.settlement.refundTimestamp, signal);
		await context.settlement.checkUnspent(signal);
		return;
	}
	const { transaction } = context;
	const { sender, contractId } = transaction.plan.terms;
	const [tokens, native] = await Promise.all([getTokenUtxos(sender, contractId, { signal }), getNativeUtxos(sender, { signal })]);
	signal.throwIfAborted();
	for (const input of transaction.inputs) {
		if (!(input.kind === 'token' ? tokens : native).some((output) => output.txid === input.txid && output.index === input.index)) {
			throw new Error('A selected input is no longer unspent. Review and build a new transaction.');
		}
	}
}

export async function getTokenHtlcSigningRequest(buildId: string, signal: AbortSignal): Promise<SignTransaction> {
	const context = getContext(buildId);
	await checkInputs(context, signal);
	getContext(buildId);
	return {
		txraws: [context.transaction.rawHex],
		utxos_satoshis: [context.transaction.inputs.map((input) => Number(input.nativeAmountRaw))],
		script_pubkeys: [context.transaction.inputs.map((input) => input.scriptHex)],
	};
}

export async function finalizeTokenHtlc(buildId: string, publicKeyHex: string, signatures: string[], signal: AbortSignal, secretHex?: string): Promise<SignedTokenHtlc> {
	const context = getContext(buildId);
	const { transaction, parentsRaw, proofs } = context;
	if (context.broadcast || context.broadcasting) throw new Error('This signing session already has a submission in progress or a record. Check its TXID before creating another transaction.');
	if (!tbc.PublicKey.isValid(publicKeyHex)) throw new Error('Invalid wallet public key.');
	const publicKey = new tbc.PublicKey(publicKeyHex);
	if (!tbc.crypto.Hash.sha256ripemd160(publicKey.toBuffer()).equals(tbc.Address.fromString(context.settlement?.signer ?? transaction.plan.terms.sender).hashBuffer)) throw new Error('The signing key does not belong to the required account.');
	if (signatures.length !== transaction.inputs.length) throw new Error('The wallet did not sign every transaction input.');
	const unsigned = new tbc.Transaction(transaction.rawHex);
	for (let index = 0; index < signatures.length; index++) {
		const hex = signatures[index];
		if (!/^(?:[0-9a-f]{2}){9,80}$/i.test(hex)) throw new Error('Invalid wallet signature encoding.');
		const signature = tbc.crypto.Signature.fromTxFormat(Buffer.from(hex, 'hex'));
		// Require ALL|FORKID: no partial-output or ANYONECANPAY signatures.
		if (signature.nhashtype !== 0x41) throw new Error('The wallet returned an unsupported signature hash type. Expected ALL|FORKID (0x41).');
		const input = transaction.inputs[index];
		if (!unsigned.verifySignature(signature, publicKey, index, new tbc.Script(input.scriptHex), new tbc.crypto.BN(input.nativeAmountRaw), tbc.Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID)) throw new Error(`Wallet signature verification failed for input ${index}. No transaction was broadcast.`);
	}
	let rawHex: string;
	if (context.settlement) {
		const { action, hashHex, deployRaw, proof } = context.settlement;
		const deploy = new tbc.Transaction(deployRaw);
		if (action === 'claim') {
			if (!secretHex || !/^[0-9a-f]{64}$/i.test(secretHex) || tbc.crypto.Hash.sha256(Buffer.from(secretHex, 'hex')).toString('hex') !== hashHex) throw new Error('The secret does not match the on-chain hashlock.');
			rawHex = sdk.TBCHTLC.fillSigWithdrawTbcHtlcToken(transaction.rawHex, signatures, publicKeyHex, secretHex, deploy, proof);
		} else rawHex = sdk.TBCHTLC.fillSigRefundTbcHtlcToken(transaction.rawHex, signatures, publicKeyHex, deploy, proof);
	} else {
		if (!secretHex || !/^[0-9a-f]{64}$/i.test(secretHex) || tbc.crypto.Hash.sha256(Buffer.from(secretHex, 'hex')).toString('hex') !== transaction.plan.terms.hashHex) throw new Error('Provide the claim secret matching the reviewed lock so it can be saved.');
		rawHex = sdk.TBCHTLC.fillSigDeployTbcHtlcToken(transaction.rawHex, signatures, publicKeyHex, parentsRaw.map((raw) => new tbc.Transaction(raw)), proofs);
	}
	const signed = new tbc.Transaction(rawHex);
	if (rawHex.slice(0, 8) !== transaction.rawHex.slice(0, 8) || signed.nLockTime !== unsigned.nLockTime || signed.inputs.length !== unsigned.inputs.length || signed.outputs.length !== unsigned.outputs.length) throw new Error('Signing changed the transaction structure.');
	if (signed.inputs.some((input, index) => input.prevTxId.toString('hex') !== unsigned.inputs[index].prevTxId.toString('hex') || input.outputIndex !== unsigned.inputs[index].outputIndex || input.sequenceNumber !== unsigned.inputs[index].sequenceNumber)) throw new Error('Signing changed a transaction input.');
	if (signed.outputs.some((output, index) => output.satoshis !== unsigned.outputs[index].satoshis || output.script.toHex() !== unsigned.outputs[index].script.toHex())) throw new Error('Signing changed a transaction output.');
	await checkInputs(context, signal);
	getContext(buildId);
	const signedBytes = rawHex.length / 2;
	const minimumFee = Math.max(80, Math.ceil(signedBytes / 1000 * 80));
	const result: SignedTokenHtlc = { txid: signed.hash, rawHex, signedBytes, feeRaw: transaction.feeRaw, minimumFeeRaw: String(minimumFee), feeSufficient: BigInt(transaction.feeRaw) >= BigInt(minimumFee), signaturesVerified: true, termsUnchanged: true, signedAt: new Date().toISOString() };
	if (context.broadcast || context.broadcasting) throw new Error('A submission started while finalizing. Check its TXID.');
	if (!context.settlement && secretHex !== undefined) {
		try { await saveClaimSecret(transaction.plan.terms.sender, result.txid, transaction.plan.terms.hashHex.toLowerCase(), secretHex.toLowerCase()); }
		catch { throw new Error('Signing completed, but the claim secret could not be saved. Nothing was broadcast. Keep your secret and check wallet/storage permissions before retrying.'); }
		result.secretStored = true;
	}
	context.signed = result;
	try { await saveStoredHtlcRequest(requestFromTransaction(transaction, result.txid)); }
	catch { result.storageWarning = 'Signing succeeded, but public request metadata could not be saved in wallet/storage. Keep your export and check folder permissions before broadcasting.'; }
	return result;
}

function submissionContext(buildId: string) {
	// A receipt may be checked after the signing deadline; it must never cause
	// another submission. New submissions still pass getContext below.
	const context = contexts.get(buildId);
	if (!context) throw new Error('The server no longer has this signing session. Check the TXID in your signed export on TBC Testnet.');
	return context;
}

async function reconcileSubmission(context: SigningContext, signal: AbortSignal): Promise<TokenHtlcBroadcast> {
	const receipt = context.broadcast!;
	if (receipt.status === 'submitted' || context.broadcasting) return receipt;
	try {
		const data = await getApiData(API_URLS.rawTransaction(receipt.txid), { signal });
		if (typeof data.txraw === 'string' && data.txraw.toLowerCase() === context.signed!.rawHex.toLowerCase()) {
			context.broadcast = { ...receipt, status: 'submitted', message: 'This exact signed transaction is visible on TBC Testnet. Confirmation is still a separate check.', updatedAt: new Date().toISOString() };
			await saveStoredHtlcRequest(requestFromTransaction(context.transaction, receipt.txid, context.broadcast));
		}
	} catch {
		// Indexer lag, timeout or missing data is not proof of rejection.
	}
	return context.broadcast!;
}

export async function broadcastTokenHtlc(buildId: string, checkOnly: boolean, signal: AbortSignal): Promise<TokenHtlcBroadcast> {
	const context = submissionContext(buildId);
	if (context.broadcast) return reconcileSubmission(context, signal);
	if (checkOnly) throw new Error('There is no submission record for this signing session.');
	getContext(buildId);
	const signed = context.signed;
	if (!signed || !signed.feeSufficient) throw new Error('Sign this transaction with a sufficient fee before broadcasting.');
	if (context.broadcasting) throw new Error('Submission is already in progress.');
	context.broadcasting = true;
	try {
		await checkInputs(context, signal);
		getContext(buildId);
		signal.throwIfAborted();
		const tx = new tbc.Transaction(signed.rawHex);
		for (let index = 0; index < tx.inputs.length; index++) {
			const input = context.transaction.inputs[index];
			tx.inputs[index].output = new tbc.Transaction.Output({ script: new tbc.Script(input.scriptHex), satoshis: Number(input.nativeAmountRaw) });
		}
		for (let index = 0; index < tx.inputs.length; index++) {
			const verification = tx.verifyScript(index);
			if (!verification.success) throw new Error(`Local contract-script verification failed at input ${index}: ${verification.error}. Nothing was submitted.`);
		}
		getContext(buildId);
		signal.throwIfAborted();
		const pendingReceipt: TokenHtlcBroadcast = { txid: signed.txid, status: 'unknown', message: 'Submission started. If no acknowledgement arrives, check this TXID before creating another transaction.', updatedAt: new Date().toISOString(), scriptChecksVerified: true };
		// Persist the public IDs before contacting the node, even if the browser disconnects.
		try { await saveStoredHtlcRequest(requestFromTransaction(context.transaction, signed.txid, pendingReceipt)); }
		catch { throw new Error('Could not save the request in wallet/storage. Nothing was broadcast. Check folder permissions and retry.'); }
		getContext(buildId);
		signal.throwIfAborted();
		context.broadcast = pendingReceipt;
		// Once sent, finish tracking this exact submission even if the browser
		// disconnects. Never retry a POST automatically after an uncertain response.
		try {
			const response = await fetch(API_URLS.testnetBroadcast, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ txraw: signed.rawHex }), signal: AbortSignal.timeout(25000) });
			const body = await response.json();
			if (response.ok && String(body.code) === '200' && body.data?.txid === signed.txid) {
				context.broadcast = { ...context.broadcast, status: 'submitted', message: `TBC Testnet accepted this ${context.settlement?.action ?? 'lock'} transaction for submission. Await block confirmation before treating it as complete.`, updatedAt: new Date().toISOString() };
			} else if (String(body.code) === '400' || body.error || (!response.ok && response.status >= 400 && response.status < 500)) {
				let message = body.data?.error ?? body.message ?? body.msg ?? 'The Testnet node rejected the transaction.';
				if (typeof message === 'string' && message.includes('non-final-pool-full')) {
					message += ' The node considers this transaction non-final and cannot accept it into its non-final pool. For a refund, wait for Testnet median chain time to pass the original refund deadline, then refresh the original lock. Check this TXID before preparing another recovery transaction.';
				}
				context.broadcast = { ...context.broadcast, status: 'rejected', message: typeof message === 'string' ? message.slice(0, 600) : 'The Testnet node rejected the transaction.', updatedAt: new Date().toISOString() };
			}
		} catch {
			// Keep the unknown receipt: a timeout does not undo a submission.
		}
	} finally {
		context.broadcasting = false;
	}
	if (!context.broadcast) throw new Error('Submission stopped before contacting the Testnet node.');
	try { await saveStoredHtlcRequest(requestFromTransaction(context.transaction, signed.txid, context.broadcast)); }
	catch { context.broadcast.message += ' The updated receipt could not be saved to wallet/storage. The earlier pending record remains; check this TXID.'; }
	return context.broadcast;
}
