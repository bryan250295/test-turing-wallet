import { API_URLS } from '../../../shared/src/config/constants';
import type { ProofBridgeV3GasPreflight, ProofBridgeV3Route, ProofBridgeV3Snapshot } from '../../../shared/src/types/proofBridgeV3';
import { backendData } from './backendClient';
import { openBoundedWebSocket, type BoundedSocketState } from '../utils/boundedWebSocket';

export interface RegisterV3RouteInput {
	deployer: string; relay: string; gateway: string; wrappedToken: string; relayTxHash: string; gatewayTxHash: string;
}

export async function registerProofBridgeV3Route(input: RegisterV3RouteInput, signal?: AbortSignal) {
	return await backendData(API_URLS.phase3TestnetV3Route, input, true, signal) as ProofBridgeV3Route;
}

export async function getProofBridgeV3Progress(signal?: AbortSignal) {
	return await backendData(API_URLS.phase3TestnetV3Progress, undefined, true, signal) as ProofBridgeV3Snapshot;
}

export async function getProofBridgeV3GasPreflight(signal?: AbortSignal) {
	return await backendData(API_URLS.phase3TestnetV3Preflight, undefined, true, signal) as ProofBridgeV3GasPreflight;
}

export type ProofBridgeRealtimeState = Exclude<BoundedSocketState, 'connected'> | 'live';

export function connectProofBridgeV3Progress(onSnapshot: (snapshot: ProofBridgeV3Snapshot) => void, onState: (state: ProofBridgeRealtimeState) => void) {
	const controller = new AbortController();
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const disconnect = openBoundedWebSocket({
		url: `${protocol}//${window.location.host}/api/bridge/phase3/testnet-v3/ws`, signal: controller.signal,
		onState: (state) => onState(state === 'connected' ? 'live' : state),
		onMessage: (data) => {
			const value = JSON.parse(data) as ProofBridgeV3Snapshot;
			if (value.type !== 'proof-bridge-v3' || !Array.isArray(value.transfers) || typeof value.checkedAt !== 'string') throw new Error('Invalid V3 progress message.');
			onSnapshot(value);
		},
	});
	return () => { controller.abort(); disconnect(); };
}
