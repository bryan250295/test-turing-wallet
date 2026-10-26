import type { TokenHtlcLock } from '../types/htlc';

type Observation = { lock?: TokenHtlcLock; error?: string };
let observations: Record<string, Observation> = {};
const listeners = new Set<() => void>();

export const getHtlcInspections = () => observations;
export function subscribeHtlcInspections(listener: () => void) {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

// Public display snapshots only. Signing and submission always validate afresh.
export function rememberHtlcInspection(txid: string, lock?: TokenHtlcLock, error?: string) {
	const next = { ...observations };
	delete next[txid];
	next[txid] = { lock: lock ?? observations[txid]?.lock, error };
	const oldest = Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - 200));
	for (const id of oldest) delete next[id];
	observations = next;
	listeners.forEach((notify) => notify());
}
