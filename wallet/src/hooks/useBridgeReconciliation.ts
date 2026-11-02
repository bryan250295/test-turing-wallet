import { useEffect, useRef, useState } from 'react';
import type { BridgeReconciliation, ReconciliationBalanceCheck, ReconciliationRoute } from '../../../shared/src/types/bridgeReconciliation';
import type { WalletSession } from '../types/wallet';
import { loadBridgeReconciliation, checkReconciliationBalances } from '../services/bridgeReconciliation';
import { getErrorMessage } from '../utils/errors';

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
	const operation = useRef<AbortController | null>(null);
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
		}
	}
	const visible = state.context === context ? state : { report: null, loading: enabled, error: '', checking: null, balances: {} };
	return { ...visible, enabled, check, refresh: () => { if (!checking.current) setRevision((value) => value + 1); } };
}
