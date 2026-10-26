import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import type { TokenHtlcLock, UnsignedTokenHtlc } from '../../src/types/htlc';
import type { Token } from '../../src/types/api';
import { API_URLS } from '../../src/config/constants';
import { ApiError, getApiData } from '../../src/services/apiClient';
import { getAllUtxos, getNativeUtxos, getTokenInfo } from '../../src/services/tbcApi';
import { parseTokenRawAmount } from '../../src/utils/htlcTokenLock';
import { rememberTokenHtlc } from './tokenHtlcSigning';
import { reserveRecoveryFee, sizingPublicKey, sizingSignatures } from './recoveryFee';
import { getTestnetMedianTime } from './chainTime';
import { saveStoredHtlcRequest } from './requestStorage';
import { requestFromLock } from '../../src/utils/htlcRequestHistory';

export interface LockReadContext {
	raw: Map<string, tbc.Transaction>;
	metadata: Map<string, Token>;
	chainMedianTime?: number;
}

function readFeeRaw(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
	return typeof value === 'string' && /^\d{1,100}$/.test(value) ? value : undefined;
}

async function fetchRaw(txid: string, signal: AbortSignal, cache = new Map<string, tbc.Transaction>()) {
	if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Enter a valid transaction ID.');
	const cached = cache.get(txid);
	if (cached) return cached;
	const data = await getApiData(API_URLS.rawTransaction(txid), { signal }).catch((cause: unknown) => {
		if (cause instanceof ApiError && /^transaction not found\b/i.test(cause.message)) {
			throw new Error(`Transaction ${txid} is not currently visible on TBC Testnet. A saved or signed file does not establish submission. Choose the lock with its submission receipt, or recheck later if it was recently submitted. This lookup does not broadcast a transaction.`);
		}
		throw cause;
	});
	if (typeof data.txraw !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(data.txraw)) throw new Error('Invalid raw transaction from Testnet.');
	const tx = new tbc.Transaction(data.txraw);
	if (tx.hash !== txid) throw new Error('The raw transaction does not match the requested TXID.');
	cache.set(txid, tx);
	return tx;
}

async function readAvailability(lockTxid: string, contractId: string, scriptHash: string, controller: string, amountRaw: string, signal: AbortSignal) {
	const [controls, tokens] = await Promise.all([
		getAllUtxos(API_URLS.scriptUtxos(scriptHash), { signal }),
		getAllUtxos(API_URLS.contractTokenUtxos(controller, contractId), { signal }),
	]);
	return {
		controlUnspent: controls.some((output) => output.txid === lockTxid && output.index === 0),
		tokenUnspent: tokens.some((output) => output.txid === lockTxid && output.index === 1 && parseTokenRawAmount(output.ft_value).toString() === amountRaw),
	};
}

async function loadLock(lockTxid: string, contractId: string, signal: AbortSignal, context?: LockReadContext) {
	const cache = context?.raw ?? new Map<string, tbc.Transaction>();
	const deploy = await fetchRaw(lockTxid, signal, cache);
	const control = deploy.outputs[0];
	const code = deploy.outputs[1];
	const tape = deploy.outputs[2];
	if (!control || !code || !tape) throw new Error('The transaction has no supported token HTLC outputs.');
	if (control.satoshis !== 100 || code.satoshis !== 500 || tape.satoshis !== 0) throw new Error('The lock output values differ from the supported token HTLC layout.');
	const chunks = control.script.chunks;
	const hash = chunks[2]?.buf;
	const receiverHash = chunks[6]?.buf;
	const time = chunks[8]?.buf;
	const senderHash = chunks.at(-4)?.buf;
	if (hash?.length !== 32 || receiverHash?.length !== 20 || senderHash?.length !== 20 || time?.length !== 4) throw new Error('Unsupported HTLC control script.');
	const refundTimestamp = time.readUInt32LE();
	if (refundTimestamp < 500_000_000) throw new Error('Only timestamp-based token locks are supported.');
	// Exact round trip of the control template in pinned tbc-contract 1.7.3.
	// Never trust addresses or deadlines supplied by a downloaded JSON file.
	const expectedControl = tbc.Script.fromASM(`OP_IF OP_SHA256 ${hash.toString('hex')} OP_EQUALVERIFY OP_DUP OP_HASH160 ${receiverHash.toString('hex')} OP_ELSE ${time.toString('hex')} OP_BIN2NUM OP_2 OP_PUSH_META OP_BIN2NUM OP_2DUP OP_GREATERTHAN OP_NOTIF OP_2DUP 0065cd1d OP_GREATERTHANOREQUAL OP_IF 0065cd1d OP_GREATERTHANOREQUAL OP_VERIFY OP_LESSTHANOREQUAL OP_ELSE OP_2DROP OP_DROP OP_TRUE OP_ENDIF OP_ELSE OP_FALSE OP_ENDIF OP_VERIFY OP_6 OP_PUSH_META 24 OP_SPLIT OP_NIP OP_BIN2NUM ffffffff OP_NUMNOTEQUAL OP_VERIFY OP_DUP OP_HASH160 ${senderHash.toString('hex')} OP_ENDIF OP_EQUALVERIFY OP_CHECKSIG`);
	if (expectedControl.toHex() !== control.script.toHex()) throw new Error('The HTLC control script differs from the supported template.');
	const genesis = await fetchRaw(contractId, signal, cache);
	const genesisCode = genesis.outputs[0]?.script.toHex();
	if (!genesisCode || sdk.detectFTVersion(genesisCode)?.version !== 'legacy') throw new Error('Only ordinary legacy FT tokens are supported.');
	const controller = tbc.crypto.Hash.sha256ripemd160(tbc.crypto.Hash.sha256(control.script.toBuffer())).toString('hex');
	if (sdk.FT.buildFTtransferCode(genesisCode, controller).toHex() !== code.script.toHex()) throw new Error('The locked token does not match this FT contract and HTLC controller.');
	const metadata = context?.metadata.get(contractId) ?? await getTokenInfo(contractId, { signal });
	signal.throwIfAborted();
	context?.metadata.set(contractId, metadata);
	const decimals = Number(metadata.decimal);
	if (metadata.decimal === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimal metadata.');
	const amount = sdk.getFtBalanceFromTape(tape.script.toHex());
	if (amount <= 0n) throw new Error('The lock has no positive FT balance.');
	const scriptHash = tbc.crypto.Hash.sha256(control.script.toBuffer()).reverse().toString('hex');
	const [availability, decoded, chainMedianTime] = await Promise.all([
		readAvailability(lockTxid, contractId, scriptHash, controller, amount.toString(), signal),
		getApiData(API_URLS.transaction(lockTxid), { signal }),
		context?.chainMedianTime !== undefined ? Promise.resolve(context.chainMedianTime) : getTestnetMedianTime(signal),
	]);
	signal.throwIfAborted();
	if (context) context.chainMedianTime = chainMedianTime;
	const info: TokenHtlcLock = {
		feeRaw: readFeeRaw(decoded.fee),
		chainMedianTime, refundEligible: chainMedianTime > refundTimestamp,
		lockTxid, contractId, sender: tbc.Address.fromPublicKeyHash(senderHash).toString(), receiver: tbc.Address.fromPublicKeyHash(receiverHash).toString(),
		hashHex: hash.toString('hex'), refundTimestamp, amountRaw: amount.toString(), decimals,
		symbol: metadata.symbol || 'FT', name: metadata.name || 'Unnamed token',
		confirmations: typeof decoded.confirmations === 'number' ? decoded.confirmations : 0,
		...availability,
		checkedAt: new Date().toISOString(),
	};
	return { info, deploy, cache, scriptHash, controller };
}

export async function inspectTokenHtlc(lockTxid: string, contractId: string, signal: AbortSignal, recoveryTxids: string[] = [], context?: LockReadContext) {
	const { info, deploy, cache } = await loadLock(lockTxid, contractId, signal, context);
	for (const txid of recoveryTxids) {
		try {
			const tx = await fetchRaw(txid, signal, cache);
			if (tx.inputs[0]?.prevTxId.toString('hex') !== lockTxid || tx.inputs[0].outputIndex !== 0 || tx.inputs[1]?.prevTxId.toString('hex') !== lockTxid || tx.inputs[1].outputIndex !== 1) throw new Error('Recovery does not spend this lock.');
			const chunks = tx.inputs[0].script.chunks;
			const branch = chunks.at(-1)?.opcodenum;
			const action = branch === 81 && chunks.length === 4 ? 'claim' : branch === 0 && chunks.length === 3 ? 'refund' : null;
			if (!action) throw new Error('Unsupported recovery branch.');
			const recipient = action === 'claim' ? info.receiver : info.sender;
			if (!tx.outputs[0] || !tx.outputs[1] || tx.outputs[0].script.toHex() !== sdk.FT.buildFTtransferCode(deploy.outputs[1].script.toHex(), recipient).toHex() || sdk.getFtBalanceFromTape(tx.outputs[1].script.toHex()).toString() !== info.amountRaw) throw new Error('Recovery token outputs do not match the lock.');
			const decoded = await getApiData(API_URLS.transaction(txid), { signal });
			const confirmations = typeof decoded.confirmations === 'number' && Number.isSafeInteger(decoded.confirmations) && decoded.confirmations > 0 ? decoded.confirmations : 0;
			info.recovery = { txid, action, confirmations, feeRaw: readFeeRaw(decoded.fee) };
			if (confirmations > 0) break;
		} catch (cause) {
			signal.throwIfAborted();
			if (cause instanceof ApiError && cause.status === 429) throw cause;
			info.recoveryWarning = 'Some saved recovery transactions could not be verified on Testnet. Missing data does not prove rejection.';
		}
	}
	signal.throwIfAborted();
	await saveStoredHtlcRequest(requestFromLock(info));
	return info;
}

export async function buildTokenHtlcRecovery(lockTxid: string, contractId: string, action: 'claim' | 'refund', signal: AbortSignal): Promise<UnsignedTokenHtlc> {
	const { info, deploy, cache, scriptHash, controller } = await loadLock(lockTxid, contractId, signal);
	if (!info.controlUnspent || !info.tokenUnspent) throw new Error('The lock is spent or no longer available in the Testnet indexer. Refresh its state; do not create another lock.');
	if (info.confirmations < 1) throw new Error('Wait for at least one confirmation of the lock before continuing.');
	if (action === 'refund' && !info.refundEligible) throw new Error('Refund is not yet eligible by Testnet median chain time. Wait for new blocks, then refresh the original lock.');
	const signer = action === 'claim' ? info.receiver : info.sender;
	const native = await getNativeUtxos(signer, { signal });
	const candidates = native.filter((output) => output.txid !== lockTxid || output.index > 2);
	const rawValue = (output: typeof native[number]) => parseTokenRawAmount(output.value ?? output.satoshis);
	candidates.sort((a, b) => rawValue(a) > rawValue(b) ? -1 : rawValue(a) < rawValue(b) ? 1 : 0);
	const funding = candidates[0];
	if (!funding) throw new Error(`The ${action === 'claim' ? 'recipient' : 'refund'} wallet needs native test TBC for transaction fees.`);
	const fundingTx = await fetchRaw(funding.txid, signal, cache);
	const fundingOutput = fundingTx.outputs[funding.index];
	const signerScript = tbc.Script.buildPublicKeyHashOut(signer).toHex();
	if (!fundingOutput || !Number.isSafeInteger(fundingOutput.satoshis) || fundingOutput.script.toHex() !== signerScript || BigInt(fundingOutput.satoshis) !== rawValue(funding)) throw new Error('The native funding input does not match the required signer.');
	const toUtxo = (index: number): tbc.Transaction.IUnspentOutput => ({ txId: lockTxid, outputIndex: index, script: deploy.outputs[index].script.toHex(), satoshis: deploy.outputs[index].satoshis });
	const control = toUtxo(0);
	const token = toUtxo(1);
	const fee: tbc.Transaction.IUnspentOutput = { txId: funding.txid, outputIndex: funding.index, script: signerScript, satoshis: fundingOutput.satoshis };
	const slots = deploy.outputs[2].script.toBuffer().subarray(3, 51);
	if (slots.length !== 48) throw new Error('Invalid token Tape.');
	const ancestors: tbc.Transaction[] = [];
	for (let index = 0; index < 6; index++) {
		if (slots.readBigUInt64LE(index * 8) === 0n) continue;
		const input = deploy.inputs[index];
		if (!input) throw new Error('Missing token ancestor reference.');
		const parent = await fetchRaw(input.prevTxId.toString('hex'), signal, cache);
		if (!parent.outputs[input.outputIndex]) throw new Error('Missing ancestor output.');
		ancestors.push(parent);
	}
	const proof = sdk.buildFtPrePreTxData(deploy, 1, ancestors);
	let rawHex = action === 'claim' ? sdk.TBCHTLC.withdrawTbcHtlcToken(signer, control, token, deploy, fee)
		: sdk.TBCHTLC.refundTbcHtlcToken(signer, control, token, deploy, fee, info.refundTimestamp);
	const inputs = [control, token, fee];
	const nativeInput = inputs.reduce((sum, input) => sum + BigInt(input.satoshis), 0n);
	rawHex = reserveRecoveryFee(rawHex, nativeInput, (raw) => action === 'claim'
		? sdk.TBCHTLC.fillSigWithdrawTbcHtlcToken(raw, sizingSignatures, sizingPublicKey, '00'.repeat(32), deploy, proof)
		: sdk.TBCHTLC.fillSigRefundTbcHtlcToken(raw, sizingSignatures, sizingPublicKey, deploy, proof));
	const tx = new tbc.Transaction(rawHex);
	if (tx.inputs.length !== 3 || tx.outputs.length < 2 || tx.outputs.length > 3 || tx.outputs[0].script.toHex() !== sdk.FT.buildFTtransferCode(token.script, signer).toHex() || sdk.getFtBalanceFromTape(tx.outputs[1].script.toHex()).toString() !== info.amountRaw) throw new Error('Unexpected recovery transaction token outputs.');
	if (tx.outputs[2] && tx.outputs[2].script.toHex() !== signerScript) throw new Error('Native change does not return to the required signer.');
	if (tx.inputs.some((input, index) => input.prevTxId.toString('hex') !== inputs[index].txId || input.outputIndex !== inputs[index].outputIndex)) throw new Error('Unexpected recovery transaction inputs.');
	if (tx.outputs.some((output) => !Number.isSafeInteger(output.satoshis) || output.satoshis < 0)) throw new Error('Insufficient native funding.');
	const feeRaw = nativeInput - tx.outputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n);
	if (feeRaw <= 0n) throw new Error('Insufficient transaction fee.');
	const whole = info.amountRaw.padStart(info.decimals + 1, '0');
	const amount = info.decimals ? `${whole.slice(0, -info.decimals)}.${whole.slice(-info.decimals)}` : whole;
	const transaction: UnsignedTokenHtlc & { signingContext: { parentsRaw: string[]; proofs: string[] } } = {
		action, signerAddress: signer, lockTxid, network: 'testnet', sdkVersion: 'tbc-contract 1.7.3 / tbc-lib-js 1.0.31',
		plan: { terms: { sender: info.sender, receiver: info.receiver, contractId, amount, hashHex: info.hashHex, refundTime: new Date(info.refundTimestamp * 1000).toISOString() }, tokenName: info.name, symbol: info.symbol, decimals: info.decimals, amountRaw: info.amountRaw, remainingRaw: '0', refundTimestamp: info.refundTimestamp, inputs: [{ txid: lockTxid, index: 1, amountRaw: info.amountRaw }], checkedAt: new Date().toISOString() },
		rawHex, unsignedBytes: rawHex.length / 2, feeRaw: feeRaw.toString(), nativeInputRaw: nativeInput.toString(), nativeChangeRaw: String(tx.outputs[2]?.satoshis ?? 0), protocolOutputRaw: String(tx.outputs[0].satoshis), tokenChangeRaw: '0', proofCount: 1, ancestorCount: ancestors.length,
		inputs: inputs.map((input, index) => ({ txid: input.txId, index: input.outputIndex, scriptHex: input.script, nativeAmountRaw: String(input.satoshis), kind: index === 0 ? 'control' : index === 1 ? 'token' : 'fee' })),
		outputs: tx.outputs.map((output, index) => ({ index, purpose: index === 0 ? `Token Code → ${action === 'claim' ? 'B' : 'A'}` : index === 1 ? 'Token Tape' : 'Native change', nativeAmountRaw: String(output.satoshis), scriptHex: output.script.toHex(), ...(index === 1 ? { tokenAmountRaw: info.amountRaw } : {}) })),
		builtAt: new Date().toISOString(), signingContext: { parentsRaw: [deploy.uncheckedSerialize()], proofs: [proof] },
	};
	return rememberTokenHtlc(transaction, { action, signer, hashHex: info.hashHex, refundTimestamp: info.refundTimestamp, deployRaw: deploy.uncheckedSerialize(), proof, checkUnspent: async (checkSignal) => {
		const latest = await readAvailability(lockTxid, contractId, scriptHash, controller, info.amountRaw, checkSignal);
		if (!latest.controlUnspent || !latest.tokenUnspent) throw new Error('The lock was already claimed/refunded, or is not available in the indexer.');
		const latestNative = await getNativeUtxos(signer, { signal: checkSignal });
		if (!latestNative.some((output) => output.txid === fee.txId && output.index === fee.outputIndex)) throw new Error('The fee input has already been spent. Rebuild the recovery transaction.');
	} });
}
