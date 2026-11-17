const maximumRecipients = 100;
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{26,35}$/;
interface RecipientSnapshot { addresses: string[]; error: string }
const empty: RecipientSnapshot = { addresses: [], error: '' };
const snapshots = new Map<string, RecipientSnapshot>();
const listeners = new Set<() => void>();

// Global v1 entries have no sender identity. Recover those recipients from wallet history instead.
function storageKey(owner: string) {
	return addressPattern.test(owner) ? `tbc-testnet-recipients-v3:${owner}` : '';
}
function readAddresses(key: string): string[] {
	const raw = localStorage.getItem(key);
	const value: unknown = raw ? JSON.parse(raw) : [];
	if (!Array.isArray(value) || value.length > maximumRecipients || value.some((address) => typeof address !== 'string' || !addressPattern.test(address))) throw new Error('Invalid recipient cache.');
	return [...new Set(value as string[])];
}
function readCache(key: string) {
	try {
		const owner = key.slice('tbc-testnet-recipients-v3:'.length);
		// Both v2 sources already carry the sender identity; preserve them when unifying the list.
		const addresses = [...new Set([...readAddresses(key), ...readAddresses(`tbc-testnet-recipients-v2:${owner}:lock`), ...readAddresses(`tbc-testnet-recipients-v2:${owner}:transfer`)])].filter((address) => address !== owner).slice(0, maximumRecipients);
		snapshots.set(key, { addresses, error: '' });
	}
	catch { snapshots.set(key, { addresses: snapshots.get(key)?.addresses ?? [], error: 'Recipient suggestions could not be loaded. You can still enter an address.' }); }
}
export function getRecipientCacheSnapshot(owner: string) {
	const key = storageKey(owner);
	if (!key) return empty;
	if (!snapshots.has(key)) readCache(key);
	return snapshots.get(key)!;
}
export function subscribeRecipientCache(listener: () => void) {
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		for (const key of snapshots.keys()) {
			if (event.key === key || event.key === null) readCache(key);
		}
		listeners.forEach((notify) => notify());
	};
	window.addEventListener('storage', onStorage);
	return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
export function rememberRecipients(owner: string, values: string[]): string | null {
	const key = storageKey(owner);
	if (!key) return null;
	const current = getRecipientCacheSnapshot(owner);
	const recipients = values.filter((address) => address !== owner && addressPattern.test(address));
	if (!recipients.length) return current.error || null;
	let previous = current.addresses;
	let error = '';
	try { previous = readAddresses(key); } catch { error = 'Recipients could not be saved in this browser. You can still enter an address.'; }
	const addresses = [...new Set([...recipients, ...previous, ...current.addresses])].slice(0, maximumRecipients);
	try { localStorage.setItem(key, JSON.stringify(addresses)); error = ''; }
	catch { error = 'Recipients are available for this session only. Browser storage is unavailable.'; }
	if (error !== current.error || addresses.join(',') !== current.addresses.join(',')) {
		snapshots.set(key, { addresses, error });
		listeners.forEach((notify) => notify());
	}
	return error || null;
}
// Successful lock submissions and confirmed transfers share the same wallet address book.
export function rememberLockRecipient(owner: string, address: string) {
	return rememberRecipients(owner, [address.trim()]);
}
