import { useEffect, useState } from 'react';
import { AttemptHistory, bridgeStatus } from './BridgeFlow';
import ConfirmationUpdates from './ConfirmationUpdates';
import useConfirmationPolling from '../../hooks/useConfirmationPolling';
import type { BridgeOrder } from '../../../../shared/src/types/learningBridge';
import type { WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import RedemptionOrders from './RedemptionOrders';
import useEscrowDeployments from '../../hooks/useEscrowDeployments';
import { formatDateTime } from '../../utils/dateTime';
import { formatHypeBalance } from '../../services/evmWallet';

interface Props { order: BridgeOrder; session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean }
export default function EscrowDeployments({ order, session, evm, active }: Props) {
	const flow = useEscrowDeployments(order, session, evm, active);
	const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
	const [notSent, setNotSent] = useState<Record<string, boolean>>({});
	const [hashes, setHashes] = useState<Record<string, string>>({});
	const [now, setNow] = useState(Date.now());
	useEffect(() => { setReviewed({}); setNotSent({}); setHashes({}); }, [flow.context]);
	useEffect(() => {
		if (!active || !flow.rows.some((row) => row.status === 'prepared')) return;
		setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
	}, [active, flow.rows]);
	const busy = flow.loading || !!flow.action || session.busy || evm.loading || !!evm.pending;
	const canWallet = flow.enabled && evm.networkIsTestnet && !!evm.address && !busy;
	const occupied = flow.rows.some((row) => ['prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified'].includes(row.status));
	const pending = flow.rows.find((row) => row.txHash && ['submitted', 'confirming'].includes(row.status));
	const updates = useConfirmationPolling({ context: flow.context, enabled: active && flow.enabled, waiting: !!pending, busy, error: flow.error,
		check: async () => { if (pending) await flow.check(pending); } });
	return <section className="htlc-section" aria-label="Saved escrow deployments" aria-busy={busy}>
		<h4>{flow.rows.some((row) => row.status === 'verified') ? 'Return setup complete' : 'Set up returns'}</h4>
		{pending && <ConfirmationUpdates automatic={updates.automatic} onChange={updates.setAutomatic} paused={updates.paused} />}
		{!flow.rows.some((row) => row.status === 'verified') && <p>Prepare return setup, review its fee, then confirm in MetaMask. You only need to do this once for this order.</p>}
		<div className="htlc-actions">
			{!flow.rows.some((row) => row.status === 'verified') && <button type="button" disabled={!canWallet || occupied} onClick={() => { void flow.prepare(); }}>{flow.action === 'prepare' ? 'Preparing escrow…' : 'Prepare return setup'}</button>}
			<button type="button" className="history-secondary" disabled={!flow.enabled || busy} onClick={flow.refresh}>Refresh setup status</button>
		</div>
		{!flow.enabled && <p>Reconnect the original TBC wallet to load saved escrow deployments.</p>}
		{flow.loading && <p role="status">Loading saved escrows…</p>}
		{<AttemptHistory rows={flow.rows} title="Escrow setup history" render={(row) => <article key={row.id} className="bridge-deployment-record">
			<h4>Return setup · {bridgeStatus(row.status)}</h4>
			<p className="history-note">Created {formatDateTime(row.createdAt)} MYT · {row.id}</p>
			<dl className="history-detail-grid">
				<div><dt>{order.wrappedSymbol} token</dt><dd><code>{row.quote.wrappedToken}</code></dd></div>
				<div><dt>Setup wallet</dt><dd><code>{row.quote.admin}</code></dd></div>
				<div><dt>Reviewed fee budget</dt><dd>{formatHypeBalance(row.quote.budgetWei)} HYPE</dd></div>
				<div><dt>Contract address</dt><dd><code>{row.contractAddress ?? 'Awaiting verified creation'}</code></dd></div>
				{row.actualFeeWei !== null && <div><dt>Actual deployment fee</dt><dd>{formatHypeBalance(row.actualFeeWei)} HYPE</dd></div>}
			</dl>
			{row.status === 'prepared' && <>
				<p>Quote expires {formatDateTime(row.quote.expiresAt)} MYT. Prepare again if the quote expires.</p>
				<label className="bridge-role-choice"><input type="checkbox" checked={!!reviewed[row.id]} disabled={busy} onChange={(event) => setReviewed((old) => ({ ...old, [row.id]: event.target.checked }))} /> I checked the token, wallet address and HYPE fee.</label>
				<div className="htlc-actions"><button type="button" disabled={!canWallet || !reviewed[row.id] || now >= Date.parse(row.quote.expiresAt) || evm.address?.toLowerCase() !== row.quote.admin} onClick={() => { void flow.deploy(row); }}>Confirm setup in MetaMask</button><button type="button" className="history-secondary" disabled={busy} onClick={() => { void flow.cancel(row); }}>Discard unused preparation</button></div>
			</>}
			{row.status === 'awaiting_wallet' && !row.txHash && <>
				<p>Open MetaMask and finish the pending request. If it was already sent, paste its transaction hash below. Do not submit again.</p>
				<label htmlFor={`escrow-hash-${row.id}`}>Setup transaction hash</label><input id={`escrow-hash-${row.id}`} type="text" autoComplete="off" spellCheck={false} value={hashes[row.id] ?? ''} disabled={busy} onChange={(event) => setHashes((old) => ({ ...old, [row.id]: event.target.value }))} />
				<button type="button" disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hashes[row.id]?.trim() ?? '')} onClick={() => { void flow.attach(row, hashes[row.id]); }}>Save transaction hash</button>
				<details><summary>No setup transaction was sent?</summary><p>Check Activity and any pending confirmation first. Discarding a local request cannot cancel a wallet or chain transaction.</p><label className="bridge-role-choice"><input type="checkbox" disabled={busy} checked={!!notSent[row.id]} onChange={(event) => setNotSent((old) => ({ ...old, [row.id]: event.target.checked }))} /> I checked Activity and confirmed the request was rejected or never sent.</label><button type="button" className="history-secondary" disabled={busy || !notSent[row.id]} onClick={() => { void flow.cancel(row, true); }}>Discard unsent setup</button></details>
			</>}
			{row.txHash && <><p>Creation transaction: <code>{row.txHash}</code></p><p>Confirmations: {row.confirmations} / {row.requiredConfirmations} required</p><button type="button" className="history-secondary" disabled={busy} onClick={() => { void flow.check(row); }}>Check now</button></>}
			{row.status === 'verified' && <p className="result success">Return setup complete. Continue with your return below.</p>}
			{row.checkedAt && <p className="history-note">Last status check {formatDateTime(row.checkedAt)} MYT</p>}
			{row.lastError && <p className="result error" role="alert">{row.lastError}</p>}
		</article>} />}
		{flow.rows.filter((row) => row.status === 'verified' && row.contractAddress).map((row) => <RedemptionOrders key={row.id} order={order} escrow={row} session={session} evm={evm} active={active} />)}
		{flow.action && <p role="status">{flow.action.startsWith('deploy:') ? 'Checking the saved preparation / waiting for MetaMask. Finish the existing prompt; do not deploy again.' : 'Updating saved escrow records…'}</p>}
		{flow.error && <p className="result error" role="alert">{flow.error}</p>}
	</section>;
}
