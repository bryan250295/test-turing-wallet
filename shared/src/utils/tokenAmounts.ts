import type { Amount, Token } from '../types/api';
import { getErrorMessage } from './errors';

export function formatRawAmount(rawAmount: Amount | bigint, decimal: number) {
	const raw = BigInt(rawAmount).toString().padStart(decimal + 1, '0');
	const whole = decimal === 0 ? raw : raw.slice(0, -decimal);
	const fraction = decimal === 0 ? '' : raw.slice(-decimal).replace(/0+$/, '');
	const formatter = new Intl.NumberFormat(undefined, { useGrouping: true, maximumFractionDigits: 0 });
	const groupedWhole = formatter.format(BigInt(whole));
	if (!fraction) return groupedWhole;
	const decimalSeparator = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1 })
		.formatToParts(1.1)
		.find((part) => part.type === 'decimal')?.value ?? '.';
	return `${groupedWhole}${decimalSeparator}${fraction}`;
}

export function formatTokenBalance(token: Token) {
	const decimals = Number(token.decimal);
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return '—';
	if (typeof token.balance === 'number' && !Number.isSafeInteger(token.balance)) return '—';
	if (!/^\d+$/.test(String(token.balance))) return '—';
	return formatRawAmount(token.balance ?? '', decimals);
}

export function tokenAmountToRaw(amount: string, decimals: number) {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
		throw new Error('The selected token has invalid decimals.');
	}
	if (!/^\d+(\.\d+)?$/.test(amount)) {
		throw new Error('Enter a positive token amount using a decimal point, for example 1.5.');
	}
	const [whole, fraction = ''] = amount.split('.');
	if (fraction.length > decimals) {
		throw new Error(`This token supports up to ${decimals} decimal places.`);
	}
	const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
	if (raw <= 0n) throw new Error('Token amount must be greater than zero.');
	return raw;
}

export function getTransferPreview(token: Token | null | undefined, amount: string) {
	if (!token) return { valid: false, remaining: '—', error: '' };
	try {
		const decimals = Number(token.decimal);
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 ||
			(typeof token.balance === 'number' && !Number.isSafeInteger(token.balance)) ||
			!/^\d+$/.test(String(token.balance))) {
			throw new Error('Token balance or decimals are unavailable. Reopen the token list to retry.');
		}
		const balance = BigInt(token.balance ?? '');
		if (!amount.trim()) return { valid: false, remaining: formatRawAmount(balance, decimals), error: '' };
		const rawAmount = tokenAmountToRaw(amount.trim(), decimals);
		if (rawAmount > balance) {
			return { valid: false, remaining: '—', error: 'Amount exceeds your available token balance.' };
		}
		return { valid: true, remaining: formatRawAmount(balance - rawAmount, decimals), error: '' };
	} catch (error) {
		return { valid: false, remaining: '—', error: getErrorMessage(error) };
	}
}
