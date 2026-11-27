import { waitForStableConnection } from './networkRecovery';

export type LiveConnectionState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

interface Options {
	url: string;
	signal: AbortSignal;
	onState: (state: LiveConnectionState) => void;
	onProgress: () => void;
}

// EventSource reconnects forever by default. Close it on the first transport
// error, wait for a stable backend connection, then allow exactly one new
// EventSource for this component lifetime.
export function openBoundedEventSource({ url, signal, onState, onProgress }: Options) {
	let source: EventSource | null = null;
	let recoveryUsed = false;
	let stopped = false;

	const close = () => { source?.close(); source = null; };
	const connected = () => { if (!stopped && !signal.aborted) onState('connected'); };

	const connect = (recovery: boolean) => {
		if (stopped || signal.aborted) return;
		onState(recovery ? 'reconnecting' : 'connecting');
		source = new EventSource(url, { withCredentials: true });
		source.onopen = connected;
		source.addEventListener('ready', connected);
		source.addEventListener('heartbeat', connected);
		source.addEventListener('progress', () => { if (!stopped && !signal.aborted) onProgress(); });
		source.onerror = () => {
			close();
			if (stopped || signal.aborted) return;
			if (recoveryUsed) { onState('stopped'); return; }
			recoveryUsed = true;
			onState('reconnecting');
			void waitForStableConnection('/api/health/ready', signal).then((stable) => {
				if (stopped || signal.aborted) return;
				if (!stable) { onState('stopped'); return; }
				connect(true);
			}).catch(() => { if (!stopped && !signal.aborted) onState('stopped'); });
		};
	};

	const abort = () => { stopped = true; close(); };
	signal.addEventListener('abort', abort, { once: true });
	connect(false);
	return () => { abort(); signal.removeEventListener('abort', abort); };
}

