function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateHtlcSecret(): string {
	if (!globalThis.crypto?.getRandomValues) {
		throw new Error('Secure random generation is unavailable in this browser.');
	}
	return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashHtlcSecret(secretHex: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error('SHA-256 requires a secure browser context. Open localhost or an HTTPS URL.');
	}
	const normalized = secretHex.trim();
	if (!/^[0-9a-f]{64}$/i.test(normalized)) {
		throw new Error('Enter exactly 64 hexadecimal characters (32 bytes), without a 0x prefix.');
	}
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
	}
	// Hash the decoded bytes, not the UTF-8 text of their hexadecimal representation.
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return toHex(new Uint8Array(digest));
}
