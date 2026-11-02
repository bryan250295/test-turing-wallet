import { useEffect, useRef, useState } from 'react';
import type { WalletAddresses, WalletSession } from '../types/wallet';
import type { BridgeOrder, BridgeOrderInput, BridgeOrderSetup } from '../types/learningBridge';
import type useHyperEvmWallet from './useHyperEvmWallet';
import { cancelBridgeOrder, listBridgeOrders, loadBridgeOrderSetup, prepareBridgeOrder } from '../services/bridgeOrders';
import { getErrorMessage } from '../utils/errors';

interface OrdersState { context: string; rows: BridgeOrder[]; setup: BridgeOrderSetup | null; loading: boolean; error: string }
export default function useBridgeOrders(session: WalletSession, evm: ReturnType<typeof useHyperEvmWallet>, active: boolean, assetRevision?: string) {
	const enabled = active && !!session.address && session.networkIsDevnet && session.backendAuth.ready;
	const context = JSON.stringify([enabled, session.address, evm.address, evm.chainId]);
	const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch;
	const [state, setState] = useState<OrdersState>({ context: '', rows: [], setup: null, loading: false, error: '' });
	const [revision, setRevision] = useState(0);
	const [action, setAction] = useState('');
	const working = useRef(false);
	const operation = useRef<AbortController | null>(null);
	const live = () => enabled && current.current.context === context && current.current.epoch === epoch;
	useEffect(() => {
		const controller = new AbortController();
		setState({ context, rows: [], setup: null, loading: enabled, error: '' });
		if (enabled) void (async () => {
			try {
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
				const [rows, setup] = await Promise.all([listBridgeOrders(signal), loadBridgeOrderSetup(signal)]);
				if (!controller.signal.aborted) setState({ context, rows, setup, loading: false, error: '' });
			} catch (cause) {
				if (!controller.signal.aborted) setState({ context, rows: [], setup: null, loading: false, error: getErrorMessage(cause) });
			}
		})();
		return () => { controller.abort(); };
	}, [context, enabled, revision, assetRevision]);
	useEffect(() => () => { operation.current?.abort(); }, [context]);
	async function run(label: string, task: (signal: AbortSignal) => Promise<BridgeOrder>): Promise<boolean> {
		if (!live() || working.current) return false;
		working.current = true; setAction(label);
		setState((previous) => ({ ...previous, error: '' }));
		const controller = new AbortController(); operation.current = controller;
		try {
			const row = await task(AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]));
			if (!live()) return false;
			setState((previous) => ({ ...previous, rows: [row, ...previous.rows.filter((item) => item.id !== row.id)]
				.sort((a, b) => Number(b.status === 'prepared') - Number(a.status === 'prepared') || Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20), error: '' }));
			return true;
		} catch (cause) {
			if (live()) setState((previous) => ({ ...previous, error: `${getErrorMessage(cause)} Refresh saved orders to check the result. A retry of the same review uses the same request ID.` }));
			return false;
		} finally { working.current = false; operation.current = null; setAction(''); }
	}
	async function verifyWallets(signal: AbortSignal) {
		const [network, addresses, destination] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress(), evm.readCurrent()]);
		signal.throwIfAborted();
		const account = addresses as WalletAddresses | undefined;
		if (!live() || network?.network !== 'tbc' || network.type !== 'testnet'
			|| (account?.tbcAddress ?? account?.addresses?.tbcAddress) !== session.address
			|| destination.chainId !== 998 || destination.address.toLowerCase() !== evm.address?.toLowerCase()) {
			throw new Error('The wallet account, network or page changed. Reconnect and review the order again.');
		}
	}
	const visible = state.context === context ? state : { rows: [], setup: null, loading: enabled, error: '' };
	return { ...visible, context, enabled, action,
		refresh: () => { if (!working.current) setRevision((value) => value + 1); },
		prepare: (input: BridgeOrderInput) => run('prepare', async (signal) => {
			await verifyWallets(signal);
			const row = await prepareBridgeOrder(input, signal);
			// The database write may finish even if the user switches accounts or tabs.
			// Never repeat it automatically; saved history is the recovery path.
			return row;
		}),
		cancel: (row: BridgeOrder) => run(`cancel:${row.id}`, (signal) => cancelBridgeOrder(row.id, signal)),
	};
}
