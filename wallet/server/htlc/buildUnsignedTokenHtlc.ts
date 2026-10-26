import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import type { HtlcTokenLockTerms, UnsignedTokenHtlc } from '../../src/types/htlc';
import { prepareTokenLockPlan } from '../../src/services/htlcTokenLock';
import { getNativeUtxos } from '../../src/services/tbcApi';
import { getApiData } from '../../src/services/apiClient';
import { API_URLS } from '../../src/config/constants';
import { validateTokenLockTerms } from '../../src/utils/htlcTokenLock';

// Only unsigned FT construction is exposed. This module never signs or broadcasts.
export async function buildUnsignedTokenHtlc(terms: HtlcTokenLockTerms, signal: AbortSignal): Promise<UnsignedTokenHtlc & { signingContext: { parentsRaw: string[]; proofs: string[] } }> {
	const plan = await prepareTokenLockPlan(terms, signal);
	const transactions = new Map<string, tbc.Transaction>();
	async function fetchTransaction(txid: string) {
		signal.throwIfAborted();
		const cached = transactions.get(txid);
		if (cached) return cached;
		const data = await getApiData(API_URLS.rawTransaction(txid), { signal });
		if (typeof data.txraw !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(data.txraw)) throw new Error('The Testnet API returned invalid raw transaction data.');
		const tx = new tbc.Transaction(data.txraw);
		if (tx.hash !== txid) throw new Error('The downloaded transaction does not match its requested ID.');
		transactions.set(txid, tx);
		return tx;
	}

	const genesis = await fetchTransaction(terms.contractId);
	const genesisCode = genesis.outputs[0]?.script.toHex();
	const version = genesisCode ? sdk.detectFTVersion(genesisCode) : null;
	if (!genesisCode || version?.version !== 'legacy') {
		throw new Error('This builder currently supports ordinary legacy FT tokens minted by the wallet. TBC20 and stablecoin proof adapters are not enabled.');
	}
	const expectedCode = sdk.FT.buildFTtransferCode(genesisCode, terms.sender).toHex();
	const parents: tbc.Transaction[] = [];
	const tokenInputs: tbc.Transaction.IUnspentOutput[] = [];
	const proofs: string[] = [];
	const ancestorIds = new Set<string>();
	for (const input of plan.inputs) {
		const parent = await fetchTransaction(input.txid);
		const code = parent.outputs[input.index];
		const tape = parent.outputs[input.index + 1];
		if (!code || !tape || code.script.toHex() !== expectedCode) throw new Error('A token input does not match this contract and sender.');
		const tokenBalance = sdk.getFtBalanceFromTape(tape.script.toHex());
		if (tokenBalance.toString() !== input.amountRaw) throw new Error('The token indexer balance differs from its transaction Tape. Review the plan again.');
		if (!Number.isSafeInteger(code.satoshis) || code.satoshis < 0) throw new Error('Invalid native value on a token input.');
		tokenInputs.push({ txId: input.txid, outputIndex: input.index, script: code.script.toHex(), satoshis: code.satoshis, ftBalance: tokenBalance });
		parents.push(parent);
		// Legacy FT proofs reference parent inputs through six uint64 Tape slots.
		const slots = tape.script.toBuffer().subarray(3, 51);
		if (slots.length !== 48) throw new Error('Invalid FT Tape amount slots.');
		const ancestors: tbc.Transaction[] = [];
		for (let slot = 0; slot < 6; slot++) {
			if (slots.readBigUInt64LE(slot * 8) === 0n) continue;
			const previousInput = parent.inputs[slot];
			if (!previousInput) throw new Error('A token ancestor reference is missing.');
			const ancestorId = previousInput.prevTxId.toString('hex');
			const ancestor = await fetchTransaction(ancestorId);
			if (!ancestor.outputs[previousInput.outputIndex]) throw new Error('A token ancestor output is missing.');
			ancestors.push(ancestor);
			ancestorIds.add(ancestorId);
		}
		proofs.push(sdk.buildFtPrePreTxData(parent, input.index, ancestors));
	}

	const nativeOutputs = await getNativeUtxos(terms.sender, { signal });
	const senderScript = tbc.Script.buildPublicKeyHashOut(terms.sender).toHex();
	const candidates = nativeOutputs.filter((output) => !plan.inputs.some((input) => input.txid === output.txid && input.index === output.index));
	// Choose the largest single funding output: the SDK takes exactly one fee input.
	const amountOf = (output: typeof nativeOutputs[number]) => {
		const amount = output.value ?? output.satoshis;
		if (amount === undefined || !/^\d+$/.test(String(amount)) || !Number.isSafeInteger(Number(amount))) throw new Error('Invalid native funding amount.');
		return BigInt(amount);
	};
	candidates.sort((a, b) => amountOf(a) > amountOf(b) ? -1 : amountOf(a) < amountOf(b) ? 1 : 0);
	const funding = candidates[0];
	if (!funding) throw new Error('No native test TBC output is available for token transaction fees.');
	const fundingTx = await fetchTransaction(funding.txid);
	const fundingOutput = fundingTx.outputs[funding.index];
	if (!fundingOutput || fundingOutput.script.toHex() !== senderScript || BigInt(fundingOutput.satoshis) !== amountOf(funding)) throw new Error('The funding output does not match the sender or indexer amount.');
	const feeInput: tbc.Transaction.IUnspentOutput = { txId: funding.txid, outputIndex: funding.index, script: senderScript, satoshis: fundingOutput.satoshis };
	const rawAmount = BigInt(plan.amountRaw);
	// SDK 1.7.3 scales ftAmount by six decimals regardless of token metadata.
	// Supply a decimal string that scales back to the exact raw token integer.
	const sdkAmount = `${rawAmount / 1_000_000n}.${(rawAmount % 1_000_000n).toString().padStart(6, '0')}`;
	signal.throwIfAborted();
	const rawHex = sdk.TBCHTLC.deployTbcHtlcToken(terms.sender, terms.receiver, terms.hashHex, plan.refundTimestamp, sdkAmount, tokenInputs, feeInput, parents, proofs);
	const tx = new tbc.Transaction(rawHex);
	const totalTokens = tokenInputs.reduce((sum, input) => sum + input.ftBalance!, 0n);
	const tokenChange = totalTokens - rawAmount;
	const protocolCount = tokenChange > 0n ? 5 : 3;
	if (tx.outputs.length < protocolCount || tx.outputs.length > protocolCount + 1) throw new Error('Unexpected token HTLC output structure.');
	if (sdk.getFtBalanceFromTape(tx.outputs[2].script.toHex()) !== rawAmount) throw new Error('The constructed token amount does not match the reviewed amount.');
	if (tokenChange > 0n && (sdk.getFtBalanceFromTape(tx.outputs[4].script.toHex()) !== tokenChange || tx.outputs[3].script.toHex() !== expectedCode)) throw new Error('The constructed token change is incorrect.');
	const allInputs = [...tokenInputs, feeInput];
	if (tx.inputs.length !== allInputs.length || tx.inputs.some((input, index) => input.prevTxId.toString('hex') !== allInputs[index].txId || input.outputIndex !== allInputs[index].outputIndex)) throw new Error('Unexpected transaction inputs.');
	const nativeInput = allInputs.reduce((sum, input) => sum + BigInt(input.satoshis), 0n);
	let nativeOutput = 0n;
	for (const output of tx.outputs) {
		if (!Number.isSafeInteger(output.satoshis) || output.satoshis < 0) throw new Error('Insufficient native funding or invalid output amount.');
		nativeOutput += BigInt(output.satoshis);
	}
	const fee = nativeInput - nativeOutput;
	if (fee <= 0n) throw new Error('The transaction does not have sufficient native funding for its fee.');
	const nativeChange = tx.outputs[protocolCount];
	if (nativeChange && nativeChange.script.toHex() !== senderScript) throw new Error('Native change does not return to account A.');
	validateTokenLockTerms(terms);
	signal.throwIfAborted();
	return {
		signingContext: { parentsRaw: parents.map((parent) => parent.uncheckedSerialize()), proofs },
		network: 'testnet', sdkVersion: 'tbc-contract 1.7.3 / tbc-lib-js 1.0.31', plan, rawHex,
		unsignedBytes: rawHex.length / 2, feeRaw: fee.toString(), nativeInputRaw: nativeInput.toString(),
		nativeChangeRaw: String(nativeChange?.satoshis ?? 0),
		protocolOutputRaw: tx.outputs.slice(0, protocolCount).reduce((sum, output) => sum + BigInt(output.satoshis), 0n).toString(),
		tokenChangeRaw: tokenChange.toString(), proofCount: proofs.length, ancestorCount: ancestorIds.size,
		inputs: allInputs.map((input, index) => ({ txid: input.txId, index: input.outputIndex, scriptHex: input.script, nativeAmountRaw: String(input.satoshis), kind: index < tokenInputs.length ? 'token' : 'fee' })),
		outputs: tx.outputs.map((output, index) => ({ index, purpose: index === 0 ? 'HTLC control' : index === 1 ? 'Locked token Code' : index === 2 ? 'Locked token Tape' : tokenChange > 0n && index === 3 ? 'Token change Code → A' : tokenChange > 0n && index === 4 ? 'Token change Tape → A' : 'Native change → A', nativeAmountRaw: String(output.satoshis), scriptHex: output.script.toHex(), ...(index === 2 ? { tokenAmountRaw: plan.amountRaw } : tokenChange > 0n && index === 4 ? { tokenAmountRaw: tokenChange.toString() } : {}) })),
		builtAt: new Date().toISOString(),
	};
}
