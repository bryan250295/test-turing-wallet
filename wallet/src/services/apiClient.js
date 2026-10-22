export class ApiError extends Error {
	constructor(message, { status = 0, code = 'REQUEST_FAILED', cause } = {}) {
		super(message, { cause });
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

// Read-only API requests. Callers control cancellation; every request has a timeout.
export async function getApiData(url, { signal, timeoutMs = 20000 } = {}) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	let timedOut = false;
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener('abort', cancel, { once: true });
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
		let body;
		try {
			body = await response.json();
		} catch (cause) {
			if (controller.signal.aborted) throw cause;
			throw new ApiError('The server returned an invalid JSON response.', { status: response.status, code: 'INVALID_RESPONSE', cause });
		}
		if (!response.ok || body?.error || (body?.code != null && String(body.code) !== '200')) {
			throw new ApiError(typeof body?.message === 'string' ? body.message : typeof body?.msg === 'string' ? body.msg : `Request failed (HTTP ${response.status}).`, {
				status: response.status, code: body?.error || 'HTTP_ERROR',
			});
		}
		if (!body?.data || typeof body.data !== 'object') {
			throw new ApiError('The server response is missing data.', { status: response.status, code: 'INVALID_RESPONSE' });
		}
		return body.data;
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
