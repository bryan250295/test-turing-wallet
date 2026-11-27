import { waitForStableConnection } from './networkRecovery';

export type BoundedSocketState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

interface Options {
	url: string;
	signal: AbortSignal;
	onState: (state: BoundedSocketState) => void;
	onMessage: (data: string) => void;
	onOpen?: () => void;
	healthEndpoint?: string;
}

// A browser WebSocket has no useful retry limit of its own. Permit one
// reconnect only after two successful health probes, then stop until the
// component is reloaded or remounted.
export function openBoundedWebSocket({
	url, signal, onState, onMessage, onOpen, healthEndpoint = '/api/health/ready',
}: Options) {
	let socket: WebSocket | null = null;
	let recoveryUsed = false;
	let stopped = false;

	const close = (code = 1000, reason = 'Page closed') => {
		const current = socket;
		socket = null;
		if (current && current.readyState < WebSocket.CLOSING) current.close(code, reason);
	};

	const connect = (recovery: boolean) => {
		if (stopped || signal.aborted) return;
		onState(recovery ? 'reconnecting' : 'connecting');
		socket = new WebSocket(url);
		socket.onopen = () => {
			if (stopped || signal.aborted) return;
			onState('connected');
			onOpen?.();
		};
		socket.onmessage = (event) => {
			if (stopped || signal.aborted || typeof event.data !== 'string') return;
			try { onMessage(event.data); }
			catch {
				stopped = true;
				onState('stopped');
				close(1008, 'Invalid live message');
			}
		};
		socket.onclose = () => {
			socket = null;
			if (stopped || signal.aborted) return;
			if (recoveryUsed) { onState('stopped'); return; }
			recoveryUsed = true;
			onState('reconnecting');
			void waitForStableConnection(healthEndpoint, signal).then((stable) => {
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
