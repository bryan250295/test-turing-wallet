import { useEffect, useRef, useState } from 'react';
import type { WalletAddresses, WalletSession } from '../types/wallet';
import type { Token } from '../types/api';
import type { BridgeFtAsset, VerifiedBridgeAsset } from '../types/learningBridge';
import { ftContractId, loadBridgeFtAsset, verifyBridgeFtAsset } from '../services/bridgeFtAsset';
import { getTokens } from '../services/tbcApi';
import { getErrorMessage } from '../utils/errors';

interface AssetState {
	owner: string;
	tokens: Token[];
	selected: BridgeFtAsset | null;
	verified: VerifiedBridgeAsset | null;
	loading: boolean;
	error: string;
}

const empty: AssetState = { owner: '', tokens: [], selected: null, verified: null, loading: false, error: '' };

export default function useBridgeFtAsset(session: WalletSession, active: boolean) {
	const [state, setState] = useState<AssetState>(empty);
	const request = useRef<AbortController | null>(null);
	const ready = active && session.wallet.isReady && session.networkIsDevnet && !!session.address;

	useEffect(() => {
		setState(empty);
		return () => { request.current?.abort(); };
	}, [active, session.address, session.networkIsDevnet, session.wallet.isReady, session.backendAuth.ready]);

	async function run<T>(operation: (signal: AbortSignal) => Promise<T>, apply: (value: T) => Partial<AssetState>, keepSelection = false) {
		request.current?.abort();
		if (!ready) return;
		const owner = session.address;
		const controller = new AbortController();
		request.current = controller;
		setState((previous) => ({ ...previous, owner, selected: keepSelection ? previous.selected : null, verified: null, loading: true, error: '' }));
		async function verifyWallet() {
			const [network, addresses] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress()]);
			controller.signal.throwIfAborted();
			const account = addresses as WalletAddresses | undefined;
			if (network?.network !== 'tbc' || network.type !== 'testnet' || (account?.tbcAddress ?? account?.addresses?.tbcAddress) !== owner) {
				throw new Error('The TBC wallet changed. Reconnect on Testnet and load your FT tokens again.');
			}
		}
		try {
			await verifyWallet();
			const value = await operation(controller.signal);
			await verifyWallet();
			if (!controller.signal.aborted) setState((previous) => ({ ...previous, ...apply(value), owner, loading: false, error: '' }));
		} catch (cause) {
			if (!controller.signal.aborted) setState((previous) => ({ ...previous, selected: keepSelection ? previous.selected : null, verified: null, loading: false, error: getErrorMessage(cause) }));
		}
	}

	function loadTokens() {
		return run(async (signal) => {
			const seen = new Set<string>();
			return (await getTokens(session.address, { signal })).map((token) => ({ ...token, contract_id: ftContractId(token.contract_id) }))
				.filter((token) => {
					if (seen.has(token.contract_id)) return false;
					seen.add(token.contract_id);
					return true;
				});
		}, (tokens) => ({ tokens, selected: null }));
	}

	function select(contractId: string) {
		return run((signal) => loadBridgeFtAsset(contractId, signal), (selected) => ({ selected }));
	}

	function verify() {
		const asset = state.selected;
		if (!asset || state.loading || session.busy || !session.backendAuth.ready) return;
		return run((signal) => verifyBridgeFtAsset(asset, signal), (verified) => ({ verified }), true);
	}

	const visible = ready && state.owner === session.address ? state : empty;
	return { ...visible, ready, loadTokens, select, verify };
}
