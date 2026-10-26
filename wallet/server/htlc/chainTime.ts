import { API_URLS } from '../../src/config/constants';
import { getApiData } from '../../src/services/apiClient';

export async function getTestnetMedianTime(signal: AbortSignal): Promise<number> {
	const data = await getApiData(API_URLS.nodeInfo, { signal });
	if (typeof data.mediantime !== 'number' || !Number.isSafeInteger(data.mediantime) || data.mediantime < 500_000_000) {
		throw new Error('Testnet returned an invalid median chain time. Refund eligibility could not be verified.');
	}
	return data.mediantime;
}

export async function assertRefundMature(refundTimestamp: number, signal: AbortSignal): Promise<void> {
	const medianTime = await getTestnetMedianTime(signal);
	// Timestamp nLockTime must be strictly less than the chain time cutoff.
	if (medianTime <= refundTimestamp) {
		throw new Error(`Refund is not yet eligible by Testnet median chain time (${new Date(medianTime * 1000).toISOString()}). It must pass ${new Date(refundTimestamp * 1000).toISOString()}. Wait for new blocks, then refresh the original lock.`);
	}
}
