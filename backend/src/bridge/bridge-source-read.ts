import { Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, getApiData } from '../../../shared/src/services/apiClient';
import { DEVNET_API_BASE } from '../../../shared/src/config/constants';

const logger = new Logger('BridgeSourceRead');
const temporaryStatuses = new Set([408, 429, 500, 502, 503, 504]);

// Retry public GET reads only. Never reuse a failed verification or retry a send.
export async function readBridgeSource(url: string | URL, signal: AbortSignal) {
	const endpoint = new URL(url);
	if (!endpoint.href.startsWith(`${DEVNET_API_BASE}/`)) throw new Error('Unsupported bridge source endpoint.');
	for (let attempt = 1; attempt <= 2; attempt++) {
		signal.throwIfAborted();
		try {
			return await getApiData(url, { signal });
		} catch (cause) {
			signal.throwIfAborted();
			if (!(cause instanceof ApiError)) throw cause;
			const transient = cause.code === 'NETWORK_ERROR' || cause.code === 'TIMEOUT' || temporaryStatuses.has(cause.status);
			const retry = attempt === 1 && transient;
			const transport = cause.cause instanceof Error ? cause.cause.cause : undefined;
			const networkCode = transport && typeof transport === 'object' && 'code' in transport
				&& typeof transport.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(transport.code) ? transport.code : undefined;
			logger.warn({ endpoint: endpoint.pathname, status: cause.status, code: /^[A-Z0-9_]{1,64}$/.test(cause.code) ? cause.code : 'UPSTREAM_ERROR', networkCode, attempt, retry });
			if (!retry) throw cause;
			await delay(400, undefined, { signal });
		}
	}
	throw new Error('Bridge source read exhausted.');
}
