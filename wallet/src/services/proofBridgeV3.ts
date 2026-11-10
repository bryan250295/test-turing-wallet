import { API_URLS } from '../../../shared/src/config/constants';
import type { ProofBridgeV3Route, ProofBridgeV3Snapshot } from '../../../shared/src/types/proofBridgeV3';
import { backendData } from './backendClient';

export interface RegisterV3RouteInput {
	deployer: string; relay: string; gateway: string; wrappedToken: string; relayTxHash: string; gatewayTxHash: string;
}

export async function registerProofBridgeV3Route(input: RegisterV3RouteInput, signal?: AbortSignal) {
	return await backendData(API_URLS.phase3TestnetV3Route, input, true, signal) as ProofBridgeV3Route;
}

export async function getProofBridgeV3Progress(signal?: AbortSignal) {
	return await backendData(API_URLS.phase3TestnetV3Progress, undefined, true, signal) as ProofBridgeV3Snapshot;
}

export function connectProofBridgeV3Progress(onSnapshot: (snapshot: ProofBridgeV3Snapshot) => void, onState: (state: 'connecting' | 'live' | 'reconnecting') => void) {
	let disposed = false; let socket: WebSocket | null = null; let timer: ReturnType<typeof setTimeout> | undefined; let attempts = 0;
	const connect = () => {
		if (disposed) return; onState(attempts ? 'reconnecting' : 'connecting');
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		socket = new WebSocket(`${protocol}//${window.location.host}/api/bridge/phase3/testnet-v3/ws`);
		socket.onopen = () => { attempts = 0; onState('live'); };
		socket.onmessage = (event) => {
			try {
				const value = JSON.parse(String(event.data)) as ProofBridgeV3Snapshot;
				if (value.type !== 'proof-bridge-v3' || !Array.isArray(value.transfers) || typeof value.checkedAt !== 'string') throw new Error('Invalid V3 progress message.');
				onSnapshot(value);
			} catch { socket?.close(1008, 'Invalid V3 progress'); }
		};
		socket.onclose = () => { if (!disposed) { attempts++; onState('reconnecting'); timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5))); } };
	};
	connect();
	return () => { disposed = true; if (timer) clearTimeout(timer); socket?.close(1000, 'V3 page closed'); };
}
