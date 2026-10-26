const storageKey = 'tbc-testnet-recipients-v1';
const maximumRecipients = 100;
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{26,35}$/;
const listeners = new Set<() => void>();
let initialized = false;
let snapshot: { addresses: string[]; error: string } = { addresses: [], error: '' };

function readAddresses(): string[] {
	const raw = localStorage.getItem(storageKey);
	const value: unknown = raw ? JSON.parse(raw) : [];
	if (!Array.isArray(value) || value.length > maximumRecipients || value.some((address) => typeof address !== 'string' || !addressPattern.test(address))) throw new Error('Invalid recipient cache.');
	return [...new Set(value as string[])];
}

function readCache() {
	try { snapshot = { addresses: readAddresses(), error: '' }; }
	catch { snapshot = { ...snapshot, error: 'Recipient suggestions could not be loaded from browser storage. You can still enter an address.' }; }
}

export function getRecipientCacheSnapshot() {
	if (!initialized) { initialized = true; readCache(); }
	return snapshot;
}

export function subscribeRecipientCache(listener: () => void) {
	getRecipientCacheSnapshot();
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key !== storageKey && event.key !== null) return;
		readCache();
		listeners.forEach((notify) => notify());
	};
	window.addEventListener('storage', onStorage);
	return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

// Call only after a lock submission is acknowledged or its status check finds it.
// A cache failure never changes the transaction's successful submission status.
export function rememberLockRecipient(value: string): string | null {
	const address = value.trim();
	if (!addressPattern.test(address)) return null;
	getRecipientCacheSnapshot();
	const addresses = [address, ...snapshot.addresses.filter((item) => item !== address)].slice(0, maximumRecipients);
	try {
		const previous = readAddresses();
		const next = [address, ...previous.filter((item) => item !== address)].slice(0, maximumRecipients);
		localStorage.setItem(storageKey, JSON.stringify(next));
		snapshot = { addresses: next, error: '' };
	} catch {
		snapshot = { addresses, error: 'The lock was submitted, but its recipient could not be saved in browser storage. Suggestions are available for this session only.' };
	}
	listeners.forEach((notify) => notify());
	return snapshot.error || null;
}
