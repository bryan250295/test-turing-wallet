import { useEffect, useRef, useState } from 'react';
import type { BridgeOrder, RedemptionOrder, RedemptionEscrowDeployment, RedemptionWalletCall, RedemptionWalletState } from '../../../../shared/src/types/learningBridge';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import { listRedemptionCalls, quoteRedemptionCall, redemptionCallAction, redemptionCallHashes, redemptionWalletState, rememberRedemptionCallHash } from '../../services/redemptionWallet';
import { formatHypeBalance } from '../../services/evmWallet';
import { formatRawAmount } from '../../utils/tokenAmounts';
import { formatDateTime } from '../../utils/dateTime';
import { getErrorMessage } from '../../utils/errors';
import { AttemptHistory, bridgeStatus } from './BridgeFlow';
import ConfirmationUpdates from './ConfirmationUpdates';
import useConfirmationPolling from '../../hooks/useConfirmationPolling';
interface Props { order: BridgeOrder; row: RedemptionOrder; escrow: RedemptionEscrowDeployment; evm: ReturnType<typeof useHyperEvmWallet>; enabled: boolean; funded: boolean; context: string; onVerified: () => void }
const labels = { unpause: 'Activate returns', reset: 'Reset token approval', approve: 'Approve wrapped token amount', lock: 'Permanently lock wrapped tokens' };
export default function RedemptionWalletCalls({ order, row, escrow, evm, enabled, funded, context: parentContext, onVerified }: Props) {
	const context = JSON.stringify([parentContext, enabled, evm.address, evm.chainId, row.id]); const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch; const live = () => enabled && current.current.context === context && current.current.epoch === epoch;
	const working = useRef(false); const request = useRef<AbortController | null>(null);
	const [state, setState] = useState<{ context: string; epoch: number; rows: RedemptionWalletCall[]; next: RedemptionWalletState | null; busy: boolean; error: string }>({ context, epoch, rows: [], next: null, busy: false, error: '' });
	const [revision, setRevision] = useState(0); const [reviewed, setReviewed] = useState<Record<string, boolean>>({}); const [notSent, setNotSent] = useState<Record<string, boolean>>({}); const [hashes, setHashes] = useState<Record<string, string>>({}); const [now, setNow] = useState(Date.now());
	useEffect(() => { setReviewed({}); setNotSent({}); setHashes({}); return () => request.current?.abort(); }, [context]);
	useEffect(() => {
		const controller = new AbortController(); setState({ context, epoch, rows: [], next: null, busy: enabled, error: '' });
		if (enabled) void (async () => {
			try {
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]); let rows = await listRedemptionCalls(order, row, escrow, signal); let error = '';
				for (const [id, txHash] of Object.entries(redemptionCallHashes(row))) {
					if (controller.signal.aborted) return;
					const call = rows.find((r) => r.id === id); if (!call) continue;
					try { const saved = await redemptionCallAction(order, row, escrow, call, 'submit', { txHash }, signal); rememberRedemptionCallHash(row, id, null); rows = rows.map((r) => r.id === id ? saved : r); }
					catch { error = `Transaction ${txHash} is retained for recovery. Reconnect and refresh; do not send again.`; }
				}
				if (!controller.signal.aborted && live()) setState({ context, epoch, rows, next: null, busy: false, error });
			} catch (cause) { if (!controller.signal.aborted && live()) setState({ context, epoch, rows: [], next: null, busy: false, error: getErrorMessage(cause) }); }
		})();
		return () => controller.abort();
	}, [context, revision]);
	const visible = state.context === context && state.epoch === epoch ? state : { rows: [], next: null, busy: enabled, error: '' };
	useEffect(() => { if (!enabled || !visible.rows.some((r) => r.status === 'quoted')) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [enabled, visible.rows]);
	const busy = visible.busy || evm.loading || !!evm.pending; const occupied = visible.rows.some((r) => ['quoted', 'awaiting_wallet', 'submitted', 'confirming'].includes(r.status));
	const walletReady = enabled && !busy && evm.networkIsTestnet && !!evm.address;
	function apply(call: RedemptionWalletCall) { if (live()) setState((old) => ({ ...old, rows: [call, ...old.rows.filter((r) => r.id !== call.id)].slice(0, 20), next: null })); }
	async function run(operation: (signal: AbortSignal) => Promise<void>) {
		if (!live() || working.current || busy) return;
		working.current = true; const controller = new AbortController(); request.current = controller;
		setState((old) => ({ ...old, busy: true, error: '' }));
		try { await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(150_000)])); }
		catch (cause) {
			if (live()) {
				let rows = visible.rows; try { rows = await listRedemptionCalls(order, row, escrow, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])); } catch { /* Refresh can recover committed state. */ }
				if (live()) setState((old) => ({ ...old, rows, error: `${getErrorMessage(cause)} Check MetaMask Activity before attempting another transaction.` }));
			}
		} finally { working.current = false; if (request.current === controller) request.current = null; if (live()) setState((old) => ({ ...old, busy: false })); }
	}
	async function send(call: RedemptionWalletCall, signal: AbortSignal) {
		const wallet = await evm.readCurrent();
		if (!live() || wallet.chainId !== 998 || wallet.address.toLowerCase() !== call.transaction.from) throw new Error('Select the reviewed account on HyperEVM Testnet 998.');
		const saved = await redemptionCallAction(order, row, escrow, call, 'begin', {}, signal); apply(saved);
		if (!live() || signal.aborted) throw new Error('The page or wallet changed before sending. Check Activity and recover the saved request.');
		let txHash: string;
		try { txHash = (await evm.sendBridgeCall(saved.transaction)).toLowerCase(); }
		catch (cause) {
			if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001) { apply(await redemptionCallAction(order, row, escrow, saved, 'cancel', { notSent: true })); throw new Error('The wallet request was rejected. No automatic retry will occur.'); }
			throw cause;
		}
		rememberRedemptionCallHash(row, saved.id, txHash);
		try { apply(await redemptionCallAction(order, row, escrow, saved, 'submit', { txHash })); rememberRedemptionCallHash(row, saved.id, null); }
		catch { throw new Error(`Transaction submitted: ${txHash}. Its hash is retained; refresh saved wallet steps to recover it.`); }
	}
	async function checkCall(call: RedemptionWalletCall) {
		return run(async (signal) => {
			const saved = await redemptionCallAction(order, row, escrow, call, 'check', {}, signal); apply(saved);
			if (live() && saved.status === 'verified') {
				if (saved.kind === 'lock') onVerified();
				else { const next = await redemptionWalletState(order, row, escrow, signal); if (live()) setState((old) => ({ ...old, next })); }
			}
		});
	}
	async function prepareNext() {
		return run(async (signal) => {
			const next = await redemptionWalletState(order, row, escrow, signal);
			if (!live()) return;
			setState((old) => ({ ...old, next }));
			const account = await evm.readCurrent();
			if (!live() || account.chainId !== 998 || account.address.toLowerCase() !== next.from) throw new Error(`Select ${next.from} in MetaMask, then prepare the next step again.`);
			apply(await quoteRedemptionCall(order, row, escrow, next.nextKind, account.address, signal));
		});
	}
	const pending = visible.rows.find((call) => call.txHash && ['submitted', 'confirming'].includes(call.status));
	const updates = useConfirmationPolling({ context, enabled, waiting: !!pending, busy, error: visible.error,
		check: async () => { if (pending) await checkCall(pending); } });
	return <section className="htlc-section" aria-label="Redemption MetaMask steps" aria-busy={busy}>
		<h4>Confirm the required MetaMask step</h4>
		<p>Keep MetaMask on HyperEVM Testnet. Prepare the next step, check its fee, then confirm the request. Wait for 6 confirmations before continuing.</p>
		{funded && !occupied && <button type="button" disabled={!walletReady} onClick={() => { void prepareNext(); }}>Prepare next wallet step</button>}
		{pending && <ConfirmationUpdates automatic={updates.automatic} onChange={updates.setAutomatic} paused={updates.paused} />}
		<button type="button" className="history-secondary" disabled={!enabled || busy || working.current} onClick={() => setRevision((old) => old + 1)}>Refresh saved wallet steps</button>
		{visible.next && funded && !occupied && <div className="bridge-deployment-record">
			<p>Next: <strong>{labels[visible.next.nextKind]}</strong></p><p>Required MetaMask account: <code>{visible.next.from}</code></p><p>Current escrow allowance: {formatRawAmount(visible.next.allowanceRaw, order.decimals)} {order.wrappedSymbol}.</p>
		</div>}
		{<AttemptHistory rows={visible.rows} render={(call) => <article key={call.id} className="bridge-deployment-record">
			<h4>{labels[call.kind]} · {bridgeStatus(call.status)}</h4>
			<p>From <code>{call.transaction.from}</code> → <code>{call.transaction.to}</code></p>
			<p>Estimated fee {formatHypeBalance(call.estimatedFeeWei)} HYPE · budget with margin {formatHypeBalance(call.budgetWei)} HYPE.</p>
			{call.status === 'quoted' && <>
				<p>Quote expires {formatDateTime(call.expiresAt)} MYT. Prepare again if the quote expires.</p>
				{call.kind === 'lock' && <p className="result error">Permanently lock {formatRawAmount(row.amountRaw, order.decimals)} {order.wrappedSymbol} to receive {order.symbol} at {row.tbcRecipient}. This cannot be undone.</p>}
				{call.kind === 'approve' && <p>Approve exactly {formatRawAmount(row.amountRaw, order.decimals)} {order.wrappedSymbol} for <code>{row.escrowAddress}</code>.</p>}
				<label className="bridge-role-choice"><input type="checkbox" disabled={busy} checked={!!reviewed[call.id]} onChange={(event) => setReviewed((old) => ({ ...old, [call.id]: event.target.checked }))} /> {call.kind === 'lock' ? 'I reviewed the permanent lock, exact amount, TBC recipient and HYPE budget.' : 'I reviewed this action, exact allowance, account, contract and HYPE budget.'}</label>
				<div className="htlc-actions"><button type="button" disabled={!walletReady || !reviewed[call.id] || now >= Date.parse(call.expiresAt) || evm.address?.toLowerCase() !== call.transaction.from} onClick={() => { void run((signal) => send(call, signal)); }}>Confirm {labels[call.kind].toLowerCase()} in MetaMask</button><button type="button" className="history-secondary" disabled={busy} onClick={() => { void run(async (signal) => { apply(await redemptionCallAction(order, row, escrow, call, 'cancel', {}, signal)); }); }}>Discard unused quote</button></div>
			</>}
			{call.status === 'awaiting_wallet' && !call.txHash && <>
				<p>Open MetaMask and finish the pending request. If it was already sent, paste its transaction hash below. Do not submit again.</p>
				<label htmlFor={`redemption-call-${call.id}`}>Recover MetaMask Activity transaction hash</label><input id={`redemption-call-${call.id}`} value={hashes[call.id] ?? ''} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => setHashes((old) => ({ ...old, [call.id]: event.target.value }))} />
				<button type="button" disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hashes[call.id]?.trim() ?? '')} onClick={() => { void run(async (signal) => { apply(await redemptionCallAction(order, row, escrow, call, 'submit', { txHash: hashes[call.id].trim().toLowerCase() }, signal)); }); }}>Save Activity hash</button>
				<details><summary>No transaction was sent?</summary><p>Check Activity and any pending prompt first. Discarding this request cannot cancel a chain transaction.</p><label className="bridge-role-choice"><input type="checkbox" disabled={busy} checked={!!notSent[call.id]} onChange={(event) => setNotSent((old) => ({ ...old, [call.id]: event.target.checked }))} /> I checked Activity and confirmed rejection or no send.</label><button type="button" className="history-secondary" disabled={busy || !notSent[call.id]} onClick={() => { void run(async (signal) => { apply(await redemptionCallAction(order, row, escrow, call, 'cancel', { notSent: true }, signal)); }); }}>Discard unsent request</button></details>
			</>}
			{call.txHash && <><p>Transaction: <code>{call.txHash}</code></p><p>Confirmations: {call.confirmations} / 6 required.</p><button type="button" className="history-secondary" disabled={busy} onClick={() => { void checkCall(call); }}>Check now</button></>}
			{call.lastError && <p className="result error" role="alert">{call.lastError}</p>}
		</article>} />}
		{busy && <p role="status">Checking / saving wallet progress. Keep MetaMask open for its confirmation request.</p>}
		{visible.error && <p className="result error" role="alert">{visible.error}</p>}
	</section>;
}
