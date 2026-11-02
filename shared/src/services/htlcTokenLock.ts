import type { HtlcTokenLockPlan, HtlcTokenLockTerms } from '../types/htlc';
import { getTokens, getTokenUtxos } from './tbcApi';
import { tokenAmountToRaw } from '../utils/tokenAmounts';
import { parseTokenRawAmount, validateHtlcAddress, validateTokenLockTerms } from '../utils/htlcTokenLock';

// This prepares terms and checks token funding. It is NOT a serialized transaction.
// Native TBC cannot be selected as the asset in this flow.
export async function prepareTokenLockPlan(terms: HtlcTokenLockTerms, signal: AbortSignal): Promise<HtlcTokenLockPlan> {
	const refundTimestamp = validateTokenLockTerms(terms);
	await Promise.all([validateHtlcAddress(terms.sender), validateHtlcAddress(terms.receiver)]);
	signal.throwIfAborted();
	const tokens = await getTokens(terms.sender, { signal });
	const token = tokens.find((item) => item.contract_id === terms.contractId);
	if (!token) throw new Error('This token is no longer listed for your account. Reload the token list.');
	if (token.decimal === undefined) throw new Error('Token decimal information is missing.');
	const decimals = Number(token.decimal);
	const amountRaw = tokenAmountToRaw(terms.amount, decimals);
	const balance = parseTokenRawAmount(token.balance);
	if (amountRaw > balance) throw new Error('The amount exceeds your current token balance.');
	const outputs = await getTokenUtxos(terms.sender, terms.contractId, { signal });
	signal.throwIfAborted();
	const seen = new Set<string>();
	const candidates = outputs.map((output) => {
		const key = `${output.txid}:${output.index}`;
		if (!/^[0-9a-f]{64}$/i.test(output.txid) || !Number.isSafeInteger(output.index) || output.index < 0 || seen.has(key)) {
			throw new Error('The API returned an invalid or duplicate token output.');
		}
		seen.add(key);
		return { txid: output.txid, index: output.index, amountRaw: parseTokenRawAmount(output.ft_value).toString() };
	}).filter((output) => BigInt(output.amountRaw) > 0n);
	// The reviewed token HTLC builder accepts at most five token inputs.
	candidates.sort((a, b) => BigInt(a.amountRaw) > BigInt(b.amountRaw) ? -1 : BigInt(a.amountRaw) < BigInt(b.amountRaw) ? 1 : 0);
	const inputs: HtlcTokenLockPlan['inputs'] = [];
	let selected = 0n;
	for (const candidate of candidates.slice(0, 5)) {
		inputs.push(candidate);
		selected += BigInt(candidate.amountRaw);
		if (selected >= amountRaw) break;
	}
	if (selected < amountRaw) throw new Error('The amount cannot be covered by five token outputs. Try a smaller amount or consolidate token outputs first.');
	validateTokenLockTerms(terms);
	return {
		terms, tokenName: token.name || 'Unnamed token', symbol: token.symbol || 'tokens',
		decimals, amountRaw: amountRaw.toString(), remainingRaw: (balance - amountRaw).toString(),
		refundTimestamp, inputs, checkedAt: new Date().toISOString(),
	};
}
