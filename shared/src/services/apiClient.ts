import type { ApiObject } from '../types/api';

export interface RequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface ApiErrorOptions {
	status?: number;
	code?: string;
	cause?: unknown;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(message: string, { status = 0, code = 'REQUEST_FAILED', cause }: ApiErrorOptions = {}) {
		super(message, { cause });
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

// JSON.parse rounds integer literals above Number.MAX_SAFE_INTEGER before a
// caller can convert them to BigInt. TBC amount fields can be uint64 values, so
// preserve every oversized integer literal as its exact decimal string while
// leaving ordinary numbers (heights, confirmations, fees, decimals) numeric.
// This is deliberately a JSON lexer rather than a field-name allowlist: token
// and native endpoints use several amount keys, and future FT types should not
// silently lose precision under a new key.
export function parseApiJson(text: string): unknown {
	let output = '';
	for (let index = 0; index < text.length;) {
		const character = text[index];
		if (character === '"') {
			const start = index++;
			while (index < text.length) {
				if (text[index] === '\\') { index += 2; continue; }
				if (text[index++] === '"') break;
			}
			output += text.slice(start, index);
			continue;
		}
		if (character === '-' || character >= '0' && character <= '9') {
			const start = index++;
			while (index < text.length && text[index] >= '0' && text[index] <= '9') index++;
			if (text[index] === '.') {
				index++;
				while (index < text.length && text[index] >= '0' && text[index] <= '9') index++;
			}
			if (text[index] === 'e' || text[index] === 'E') {
				index++;
				if (text[index] === '+' || text[index] === '-') index++;
				while (index < text.length && text[index] >= '0' && text[index] <= '9') index++;
			}
			const token = text.slice(start, index);
			let replacement = token;
			if (/^-?\d+$/.test(token)) {
				const integer = BigInt(token);
				if (integer > MAX_SAFE_JSON_INTEGER || integer < -MAX_SAFE_JSON_INTEGER) replacement = JSON.stringify(token);
			}
			output += replacement;
			continue;
		}
		output += character;
		index++;
	}
	return JSON.parse(output);
}

// Read-only API requests. Callers control cancellation; every request has a timeout.
export async function getApiData(url: string | URL, { signal, timeoutMs = 20000 }: RequestOptions = {}): Promise<ApiObject> {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	let timedOut = false;
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener('abort', cancel, { once: true });
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
		let body: ApiObject;
		try {
			const parsed: unknown = parseApiJson(await response.text());
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid response envelope.');
			body = parsed as ApiObject;
		} catch (cause) {
			if (controller.signal.aborted) throw cause;
			throw new ApiError('The server returned an invalid JSON response.', { status: response.status, code: 'INVALID_RESPONSE', cause });
		}
		if (!response.ok || body?.error || (body?.code != null && String(body.code) !== '200')) {
			throw new ApiError(typeof body?.message === 'string' ? body.message : typeof body?.msg === 'string' ? body.msg : `Request failed (HTTP ${response.status}).`, {
				status: response.status, code: typeof body.error === 'string' ? body.error : 'HTTP_ERROR',
			});
		}
		if (!body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
			throw new ApiError('The server response is missing data.', { status: response.status, code: 'INVALID_RESPONSE' });
		}
		return body.data as ApiObject;
	} catch (error) {
		if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
		if (timedOut) throw new ApiError('The request timed out. Please try again.', { code: 'TIMEOUT', cause: error });
		if (error instanceof ApiError) throw error;
		throw new ApiError('Could not reach the API. Check your connection and try again.', { code: 'NETWORK_ERROR', cause: error });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', cancel);
	}
}
