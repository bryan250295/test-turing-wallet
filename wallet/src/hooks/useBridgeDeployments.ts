import { useEffect, useRef, useState } from 'react';
import type { WalletSession } from '../types/wallet';
import type { BridgeDeploymentInput, BridgeDeploymentRecord } from '../types/learningBridge';
import type useHyperEvmWallet from './useHyperEvmWallet';
import { attachDeploymentHash, beginDeployment, cancelDeployment, checkDeployment, listDeployments, pendingDeploymentHashes, prepareDeployment, rememberDeploymentHash, saveBroadcastHash } from '../services/bridgeDeployments';
import { evmWalletError } from '../services/evmWallet';
import { getErrorMessage } from '../utils/errors';

export default function useBridgeDeployments(session: WalletSession, evm: ReturnType<typeof useHyperEvmWallet>, active: boolean, contractId?: string) {
	const owner = session.address;
	const enabled = active && !!owner && session.backendAuth.ready && session.networkIsDevnet;
	const context = JSON.stringify([enabled, owner, contractId]);
	const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch;
	const [state, setState] = useState<{ context: string; rows: BridgeDeploymentRecord[]; loading: boolean; error: string }>({ context: '', rows: [], loading: false, error: '' });
	const [action, setAction] = useState('');
	const working = useRef(false);
	const [revision, setRevision] = useState(0);
	const [unsaved, setUnsaved] = useState<Record<string, string>>({});
	const rows = state.context === context ? state.rows : [];
	function apply(row: BridgeDeploymentRecord) {
		if (contractId && row.contractId !== contractId) return;
		if (current.current.epoch === epoch && current.current.context === context) setState((value) => ({ context, loading: false, error: '', rows: [row, ...value.rows.filter((item) => item.id !== row.id)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20) }));
	}
	function fail(cause: unknown) { if (current.current.epoch === epoch && current.current.context === context) setState((value) => ({ ...value, context, loading: false, error: getErrorMessage(cause) })); }
	useEffect(() => {
		const controller = new AbortController();
		setState({ context, rows: [], loading: enabled, error: '' });
		setUnsaved(enabled ? pendingDeploymentHashes(owner) : {});
		if (enabled) void (async () => {
			try {
				for (const [id, hash] of Object.entries(pendingDeploymentHashes(owner))) {
					controller.signal.throwIfAborted();
					await saveBroadcastHash(owner, id, hash);
				}
				const records = await listDeployments(controller.signal, contractId);
				if (!controller.signal.aborted) { setUnsaved(pendingDeploymentHashes(owner)); setState({ context, rows: records, loading: false, error: '' }); }
			} catch (cause) {
				if (!controller.signal.aborted) {
					// A failed receipt save must not hide existing database records.
					try { const records = await listDeployments(controller.signal, contractId); if (!controller.signal.aborted) setState({ context, rows: records, loading: false, error: getErrorMessage(cause) }); }
					catch { if (!controller.signal.aborted) setState({ context, rows: [], loading: false, error: getErrorMessage(cause) }); }
				}
			}
		})();
		return () => controller.abort();
	}, [context, enabled, owner, revision]);
	const pending = rows.find((row) => row.txHash && ['submitted', 'confirming'].includes(row.status));
	useEffect(() => {
		if (!enabled || !pending) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		void (async () => {
			for (let attempt = 0; attempt < 18 && !controller.signal.aborted; attempt++) {
				if (attempt) await new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
				if (controller.signal.aborted) break;
				try {
					const row = await checkDeployment(pending.id, AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]));
					if (controller.signal.aborted) break;
					apply(row);
					if (!['submitted', 'confirming'].includes(row.status) || row.lastError?.startsWith('Status unavailable')) break;
				} catch (cause) { if (!controller.signal.aborted) fail(cause); break; }
			}
		})();
		return () => { controller.abort(); clearTimeout(timer); };
		// The id/phase controls a bounded watch; checkedAt changes do not restart it.
	}, [enabled, context, pending?.id, pending?.status, revision]);

	async function run(label: string, operation: () => Promise<void>) {
		if (!enabled || working.current) return;
		working.current = true; setAction(label);
		try { await operation(); } catch (cause) { fail(cause); }
		finally { working.current = false; setAction(''); }
	}
	const live = () => { if (current.current.epoch !== epoch || current.current.context !== context || !enabled) throw new Error('The selected TBC wallet or page changed. Refresh saved deployments.'); };
	return {
		context,
		rows, enabled, loading: state.context === context && state.loading, error: state.context === context ? state.error : '', action,
		unsaved: enabled ? unsaved : {}, refresh: () => setRevision((value) => value + 1),
		prepare: (input: BridgeDeploymentInput) => run('prepare', async () => { const row = await prepareDeployment(input, AbortSignal.timeout(65_000)); apply(row); }),
		cancel: (row: BridgeDeploymentRecord) => run(`cancel:${row.id}`, async () => { apply(await cancelDeployment(row.id)); }),
		check: (row: BridgeDeploymentRecord) => run(`check:${row.id}`, async () => { apply(await checkDeployment(row.id, AbortSignal.timeout(45_000))); }),
		attach: (row: BridgeDeploymentRecord, hash: string) => run(`attach:${row.id}`, async () => { apply(await attachDeploymentHash(row.id, hash.trim())); rememberDeploymentHash(owner, row.id, null); setUnsaved(pendingDeploymentHashes(owner)); }),
		deploy: (row: BridgeDeploymentRecord) => run(`deploy:${row.id}`, async () => {
			live();
			// Acquire a persistent single-use send slot before opening MetaMask.
			const transaction = await beginDeployment(row, AbortSignal.timeout(65_000));
			apply({ ...row, status: 'awaiting_wallet' });
			live();
			let hash: string;
			try { hash = await evm.sendDeployment(transaction); }
			catch (cause) {
				if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001) { apply(await cancelDeployment(row.id)); throw new Error('Deployment rejected in MetaMask. No automatic retry will occur.'); }
				throw new Error(`${evmWalletError(cause)} Check MetaMask activity before discarding this preparation or attempting another deployment.`);
			}
			// Persist even if the user left the tab while the wallet prompt was open.
			// A public recovery pointer is saved before attempting the backend call.
			rememberDeploymentHash(owner, row.id, hash);
			if (current.current.epoch === epoch && current.current.context === context) setUnsaved(pendingDeploymentHashes(owner));
			try { apply(await saveBroadcastHash(owner, row.id, hash)); if (current.current.epoch === epoch && current.current.context === context) setUnsaved(pendingDeploymentHashes(owner)); }
			catch { throw new Error(`Deployment submitted: ${hash}. Its database save failed. Refresh saved deployments after reconnecting the original TBC wallet. Do not deploy again.`); }
		}),
	};
}
