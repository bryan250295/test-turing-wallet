import type { Amount } from '../types/api';
import type { HtlcTokenLockTerms } from '../types/htlc';

export function parseTokenRawAmount(value: Amount | undefined): bigint {
	if (value === undefined || !/^\d+$/.test(String(value)) || (typeof value === 'number' && !Number.isSafeInteger(value))) {
		throw new Error('The API returned an invalid or imprecise token amount.');
	}
	return BigInt(value);
}

// TBC uses Base58Check addresses. Validate the checksum without introducing an SDK
// or assuming that the address prefix alone identifies the selected network.
export async function validateHtlcAddress(address: string): Promise<void> {
	const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
	if (address.length < 26 || address.length > 35) throw new Error('Enter a valid TBC recipient address.');
	let value = 0n;
	for (const character of address) {
		const digit = alphabet.indexOf(character);
		if (digit < 0) throw new Error('Enter a valid TBC recipient address.');
		value = value * 58n + BigInt(digit);
	}
	const decoded: number[] = [];
	while (value > 0n) {
		decoded.unshift(Number(value & 255n));
		value >>= 8n;
	}
	for (const character of address) {
		if (character !== '1') break;
		decoded.unshift(0);
	}
	const bytes = new Uint8Array(decoded);
	if (bytes.length !== 25 || ![0, 111].includes(bytes[0])) {
		throw new Error('Use a TBC public-key-hash account address.');
	}
	if (!globalThis.crypto?.subtle) throw new Error('Address verification requires localhost or HTTPS.');
	const first = await crypto.subtle.digest('SHA-256', bytes.slice(0, 21));
	const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', first));
	if (!bytes.slice(21).every((byte, index) => byte === checksum[index])) {
		throw new Error('The recipient address checksum is invalid.');
	}
}

export function validateTokenLockTerms(terms: HtlcTokenLockTerms): number {
	if (!/^[0-9a-f]{64}$/i.test(terms.contractId)) throw new Error('Choose an FT token from your wallet.');
	if (!/^[0-9a-f]{64}$/i.test(terms.hashHex)) throw new Error('Invalid claim hash. Review the token lock again.');
	if (!terms.sender || !terms.receiver) throw new Error('Enter the recipient account B address.');
	if (terms.sender === terms.receiver) throw new Error('The recipient address must differ from the sender address.');
	const timestamp = new Date(terms.refundTime).getTime() / 1000;
	if (!Number.isInteger(timestamp) || timestamp < 500_000_000 || timestamp > 0xffffffff) {
		throw new Error('Choose a valid refund date and time.');
	}
	if (timestamp <= Date.now() / 1000) throw new Error('Choose a refund date and time after the current time.');
	return timestamp;
}
