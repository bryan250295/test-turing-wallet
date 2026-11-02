import { useEffect, useRef, useState } from 'react';
import type { BridgeOrder, RedemptionEscrowDeployment } from '../../../shared/src/types/learningBridge';
import type { WalletSession } from '../types/wallet';
import type useHyperEvmWallet from './useHyperEvmWallet';
import { beginEscrow, cancelEscrow, checkEscrow, escrowHashes, escrowTransaction, listEscrows, prepareEscrow, rememberEscrowHash, submitEscrow } from '../services/redemptionEscrow';
import { getErrorMessage } from '../utils/errors';

export default function useEscrowDeployments(order: BridgeOrder, session: WalletSession, evm: ReturnType<typeof useHyperEvmWallet>, active: boolean) {
	const enabled = active && session.address === order.sender && session.networkIsDevnet && session.backendAuth.ready;
	const context = JSON.stringify([enabled, session.address, evm.address, evm.chainId, order.id]);
	const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch;
	const [state, setState] = useState<{ context: string; rows: RedemptionEscrowDeployment[]; loading: boolean; error: string }>({ context: '', rows: [], loading: false, error: '' });
	const [action, setAction] = useState(''); const [revision, setRevision] = useState(0);
	const working = useRef(false); const request = useRef<AbortController | null>(null);
	const live = () => enabled && current.current.context === context && current.current.epoch === epoch;
	useEffect(() => {
		const controller = new AbortController();
		setState({ context, rows: [], loading: enabled, error: '' });
		if (enabled) void (async () => {
			try {
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
				let rows = await listEscrows(order, signal); let error = '';
				for (const [id, hash] of Object.entries(escrowHashes(order))) {
					if (controller.signal.aborted) return;
					const row = rows.find((item) => item.id === id); if (!row) continue;
					try { const saved = await submitEscrow(order, row, hash); rememberEscrowHash(order, id, null); rows = rows.map((item) => item.id === id ? saved : item); }
					catch { error = `Escrow hash ${hash} is retained for recovery. Reconnect and refresh saved escrows; do not deploy again.`; }
				}
				if (!controller.signal.aborted) setState({ context, rows, loading: false, error });
			} catch (cause) { if (!controller.signal.aborted) setState({ context, rows: [], loading: false, error: getErrorMessage(cause) }); }
		})();
		return () => controller.abort();
	}, [context, enabled, revision]);
	useEffect(() => () => { request.current?.abort(); }, [context]);
	function apply(row: RedemptionEscrowDeployment) {
		if (live()) setState((old) => ({ ...old, context, rows: [row, ...old.rows.filter((item) => item.id !== row.id)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20) }));
	}
	async function run(label: string, operation: (signal: AbortSignal) => Promise<void>) {
		if (!live() || working.current) return;
		working.current = true; setAction(label); setState((old) => ({ ...old, error: '' }));
		const controller = new AbortController(); request.current = controller;
		try { await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)])); }
		catch (cause) {
			if (live()) {
				try { const rows = await listEscrows(order, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])); if (live()) setState({ context, rows, loading: false, error: getErrorMessage(cause) }); }
				catch { if (live()) setState((old) => ({ ...old, error: `${getErrorMessage(cause)} Refresh saved escrows to recover the latest state.` })); }
			}
		} finally { working.current = false; request.current = null; setAction(''); }
	}
	const visible = state.context === context ? state : { rows: [], loading: enabled, error: '' };
	return { ...visible, context, enabled, action, refresh: () => { if (!working.current) setRevision((value) => value + 1); },
		prepare: () => run('prepare', async (signal) => {
			const wallet = await evm.readCurrent();
			if (!live() || wallet.chainId !== 998 || wallet.address.toLowerCase() !== evm.address?.toLowerCase()) throw new Error('The selected MetaMask account or network changed. Reconnect and prepare again.');
			apply(await prepareEscrow(order, wallet.address, signal));
		}),
		cancel: (row: RedemptionEscrowDeployment, notSent = false) => run(`cancel:${row.id}`, async () => { apply(await cancelEscrow(order, row, notSent)); }),
		check: (row: RedemptionEscrowDeployment) => run(`check:${row.id}`, async (signal) => { apply(await checkEscrow(order, row, signal)); }),
		attach: (row: RedemptionEscrowDeployment, hash: string) => run(`attach:${row.id}`, async () => { apply(await submitEscrow(order, row, hash.trim().toLowerCase())); rememberEscrowHash(order, row.id, null); }),
		deploy: (row: RedemptionEscrowDeployment) => run(`deploy:${row.id}`, async (signal) => {
			const authorized = await beginEscrow(order, row, signal); apply(authorized);
			if (!live() || signal.aborted) throw new Error('The account, network or page changed before opening MetaMask. Check Activity and recover the saved request.');
			let hash: string;
			try { hash = await evm.sendDeployment(escrowTransaction(authorized)); }
			catch (cause) {
				if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001) { apply(await cancelEscrow(order, authorized, true)); throw new Error('Escrow deployment cancelled in MetaMask. No automatic retry will occur.'); }
				throw new Error(`${getErrorMessage(cause)} Check Activity before attempting another escrow deployment.`);
			}
			rememberEscrowHash(order, row.id, hash);
			try { apply(await submitEscrow(order, authorized, hash)); rememberEscrowHash(order, row.id, null); }
			catch { throw new Error(`Escrow deployment submitted: ${hash}. Refresh saved escrows to recover its database receipt; do not deploy again.`); }
		}),
	};
}
