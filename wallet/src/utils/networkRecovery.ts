export type ConnectionRecoveryPhase = 'waiting' | 'checking';

function abortError() {
	return new DOMException('Connection recovery cancelled.', 'AbortError');
}

function wait(milliseconds: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) { reject(abortError()); return; }
		const timer = window.setTimeout(done, milliseconds);
		function done() { signal.removeEventListener('abort', cancel); resolve(); }
		function cancel() { window.clearTimeout(timer); reject(abortError()); }
		signal.addEventListener('abort', cancel, { once: true });
	});
}

function waitUntilOnline(signal: AbortSignal) {
	if (navigator.onLine) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) { reject(abortError()); return; }
		function cleanup() {
			window.removeEventListener('online', online);
			signal.removeEventListener('abort', cancel);
		}
		function online() { cleanup(); resolve(); }
		function cancel() { cleanup(); reject(abortError()); }
		window.addEventListener('online', online, { once: true });
		signal.addEventListener('abort', cancel, { once: true });
	});
}

function waitForNetworkSignal(milliseconds: number, signal: AbortSignal) {
	if (!navigator.onLine) return waitUntilOnline(signal);
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) { reject(abortError()); return; }
		const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
		const timer = window.setTimeout(done, milliseconds);
		function cleanup() {
			window.clearTimeout(timer);
			window.removeEventListener('online', done);
			connection?.removeEventListener('change', done);
			signal.removeEventListener('abort', cancel);
		}
		function done() { cleanup(); resolve(); }
		function cancel() { cleanup(); reject(abortError()); }
		window.addEventListener('online', done, { once: true });
		connection?.addEventListener('change', done, { once: true });
		signal.addEventListener('abort', cancel, { once: true });
	});
}

async function probe(endpoint: string, signal: AbortSignal) {
	try {
		const response = await fetch(endpoint, {
			method: 'GET', credentials: 'same-origin', cache: 'no-store',
			headers: { Accept: 'application/json' },
			signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
		});
		return response.ok;
	} catch (cause) {
		if (signal.aborted) throw cause;
		return false;
	}
}

// Browser online/offline events only describe the local network interface; they
// do not prove that the backend or its upstream is reachable. Use a bounded
// detector: at most six health requests over roughly one minute, requiring two
// consecutive successes. A browser online/network-change event can wake the
// detector early after a failed probe. This function never retries forever.
export async function waitForStableConnection(
	endpoint: string,
	signal: AbortSignal,
	onPhase?: (phase: ConnectionRecoveryPhase) => void,
) {
	if (!navigator.onLine) {
		onPhase?.('waiting');
		await waitUntilOnline(signal);
	}
	const delays = [2_500, 3_000, 5_000, 8_000, 13_000, 20_000];
	let consecutiveSuccesses = 0;
	for (let attempt = 0; attempt < delays.length; attempt++) {
		if (!navigator.onLine) {
			consecutiveSuccesses = 0;
			onPhase?.('waiting');
			await waitUntilOnline(signal);
		}
		onPhase?.(consecutiveSuccesses ? 'checking' : attempt ? 'waiting' : 'checking');
		if (consecutiveSuccesses) await wait(delays[attempt], signal);
		else await waitForNetworkSignal(delays[attempt], signal);
		onPhase?.('checking');
		if (await probe(endpoint, signal)) {
			consecutiveSuccesses++;
			if (consecutiveSuccesses === 2) return true;
		} else {
			consecutiveSuccesses = 0;
		}
	}
	return false;
}

export function isTransientConnectionMessage(message: string | null | undefined) {
	if (!message) return false;
	return /could not reach the api|request timed out|network (?:read|connection)|connection (?:failed|interrupted)|temporarily unavailable|http (?:408|429|500|502|503|504)/i.test(message);
}

