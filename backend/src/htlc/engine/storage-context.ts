import { AsyncLocalStorage } from 'node:async_hooks';
import type { HtlcRepository } from '../htlc.repository';
import type { SecretsRepository } from '../secrets.repository';

export const engineStorage = new AsyncLocalStorage<{ owner: string; requests: HtlcRepository; secrets: SecretsRepository }>();
export function storageContext() {
	const context = engineStorage.getStore();
	if (!context) throw new Error('HTLC storage context is unavailable.');
	return context;
}
