import { useEffect, useRef, useState } from 'react';
import type { BridgeReconciliation, ReconciliationBalanceCheck, ReconciliationRoute } from '../../../shared/src/types/bridgeReconciliation';
import type { WalletSession } from '../types/wallet';
import { loadBridgeReconciliation, checkReconciliationBalances } from '../services/bridgeReconciliation';
import { getErrorMessage } from '../utils/errors';
import { openBoundedWebSocket, type BoundedSocketState } from '../utils/boundedWebSocket';

interface State {
	context: string;
	report: BridgeReconciliation | null;
	loading: boolean;
	error: string;
	checking: string | null;
	balances: Record<string, ReconciliationBalanceCheck>;
}
export default function useBridgeReconciliation(session: WalletSession, active: boolean) {
	const enabled = active && !!session.address && session.networkIsDevnet && session.backendAuth.ready;
	const context = JSON.stringify([enabled, session.address]);
	const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch;
	const [state, setState] = useState<State>({ context: '', report: null, loading: false, error: '', checking: null, balances: {} });
	const [revision, setRevision] = useState(0);
	const [realtime, setRealtime] = useState<BoundedSocketState>('off');
	const operation = useRef<AbortController | null>(null);
	const refreshTimer = useRef<number | null>(null);
	const pendingLiveRefresh = useRef(false);
	const checking = useRef(false);
	const live = () => enabled && current.current.context === context && current.current.epoch === epoch;
	useEffect(() => {
		const controller = new AbortController();
		setState((previous) => ({ context, report: previous.context === context ? previous.report : null, loading: enabled, error: '', checking: null, balances: {} }));
		if (enabled) void loadBridgeReconciliation(session.address, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
			.then((report) => { if (live() && !controller.signal.aborted) setState((previous) => ({ ...previous, report, loading: false })); })
			.catch((cause: unknown) => { if (live() && !controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, error: getErrorMessage(cause) })); });
		return () => controller.abort();
	}, [context, enabled, revision]);
	useEffect(() => {
		if (!enabled) { setRealtime('off'); return; }
		const controller = new AbortController();
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const invalidate = () => {
			if (!live()) return;
			if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
			refreshTimer.current = window.setTimeout(() => {
				refreshTimer.current = null;
				if (!live()) return;
				if (checking.current) pendingLiveRefresh.current = true;
				else setRevision((value) => value + 1);
			}, 150);
		};
		const disconnect = openBoundedWebSocket({
			url: `${protocol}//${window.location.host}/api/bridge/reconciliation/ws`, signal: controller.signal,
			onState: (next) => { if (live()) setRealtime(next); },
			onOpen: invalidate,
			onMessage: (data) => {
				const value: unknown = JSON.parse(data);
				if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid live reconciliation message.');
				const update = value as Record<string, unknown>;
				if (update.type !== 'bridge-progress' || typeof update.orderId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(update.orderId)
					|| typeof update.reason !== 'string' || !update.reason || update.reason.length > 100
					|| typeof update.at !== 'string' || !Number.isFinite(Date.parse(update.at))) throw new Error('Invalid live reconciliation message.');
				invalidate();
			},
		});
		return () => {
			controller.abort(); disconnect();
			pendingLiveRefresh.current = false;
			if (refreshTimer.current !== null) { window.clearTimeout(refreshTimer.current); refreshTimer.current = null; }
		};
	}, [context, enabled]);
	useEffect(() => () => operation.current?.abort(), [context]);
	async function check(route: ReconciliationRoute) {
		if (!live() || checking.current || state.loading) return;
		checking.current = true;
		const controller = new AbortController(); operation.current = controller;
		setState((previous) => {
			const balances = { ...previous.balances }; delete balances[route.deploymentId];
			return { ...previous, balances, checking: route.deploymentId, error: '' };
		});
		try {
			const result = await checkReconciliationBalances(route.deploymentId, route.wrappedToken, AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]));
			if (live() && !controller.signal.aborted) setState((previous) => ({ ...previous, balances: { ...previous.balances, [route.deploymentId]: result } }));
		} catch (cause) { if (live() && !controller.signal.aborted) setState((previous) => ({ ...previous, error: getErrorMessage(cause) })); }
		finally {
			checking.current = false; operation.current = null;
			if (live() && !controller.signal.aborted) setState((previous) => ({ ...previous, checking: null }));
			if (live() && pendingLiveRefresh.current) { pendingLiveRefresh.current = false; setRevision((value) => value + 1); }
		}
	}
	const visible = state.context === context ? state : { report: null, loading: enabled, error: '', checking: null, balances: {} };
	return { ...visible, enabled, realtime, check, refresh: () => { if (!checking.current) setRevision((value) => value + 1); } };
}
