import { useEffect, useState } from 'react';
import type { BridgeOrder, BridgeCallAttempt } from '../../types/learningBridge';
import type { WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeSettlement from '../../hooks/useBridgeSettlement';
import { formatRawAmount } from '../../utils/tokenAmounts';
import { formatHypeBalance } from '../../services/evmWallet';
import { formatDateTime } from '../../utils/dateTime';
import BridgeSourcePayment from './BridgeSourcePayment';
import RedemptionEscrowPreview from './RedemptionEscrowPreview';
import { BridgeSteps, AttemptHistory, bridgeStatus } from './BridgeFlow';
import ConfirmationUpdates from './ConfirmationUpdates';
import useConfirmationPolling from '../../hooks/useConfirmationPolling';

interface Props { order: BridgeOrder; session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean; onChanged: () => void; returnOnly: boolean; onReturn: () => void }
const labels = { awaiting_payment: 'Awaiting token payment', confirming: 'Confirming source deposit', ready_to_mint: 'Deposit verified · ready for wallet settlement', mint_pending: 'Mint wallet transaction pending', completed: 'Completed · wrapped tokens received', needs_review: 'Reconciliation required' };
export default function BridgeSettlement({ order, session, evm, active, onChanged, returnOnly, onReturn }: Props) {
	const flow = useBridgeSettlement(order, session, evm, active, onChanged);
	const [acknowledged, setAcknowledged] = useState(false);
	const [txid, setTxid] = useState(''); const [hashes, setHashes] = useState<Record<string, string>>({});
	const [reviewed, setReviewed] = useState<Record<string, boolean>>({}); const [now, setNow] = useState(Date.now());
	const [notSent, setNotSent] = useState<Record<string, boolean>>({});
	useEffect(() => { setAcknowledged(false); setTxid(''); setHashes({}); setReviewed({}); setNotSent({}); }, [flow.context]);
	useEffect(() => {
		if (!active || !flow.value?.attempts.some((row) => row.status === 'quoted')) return;
		const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
	}, [active, flow.value?.attempts]);
	const value = flow.value;
	const busy = flow.loading || !!flow.action || session.busy || !!evm.pending || evm.loading;
	const amount = formatRawAmount(order.amountRaw, order.decimals);
	const walletBlockReason = !flow.enabled ? 'Reconnect your original TBC wallet to continue this transfer.'
        : flow.loading ? 'Loading the saved transfer. Wait for it to finish.'
        : flow.action ? 'The current transfer action is still running. Finish it before starting another.'
        : session.busy ? 'Finish the current Turing Wallet request before continuing.'
        : evm.pending ? 'Finish or cancel the current MetaMask request in the extension.'
        : evm.loading ? 'Reading MetaMask account, network and balance. Wait for the wallet check to finish.'
        : !evm.detected ? 'MetaMask was not detected. Enable the extension and reload this page.'
        : evm.error ? `MetaMask could not be read: ${evm.error}`
        : !evm.address ? 'Connect or unlock MetaMask, then refresh its connection.'
        : !evm.networkIsTestnet ? 'Switch MetaMask to HyperEVM Testnet (998).'
        : '';
    const canWallet = !walletBlockReason;
    const walletReadBusy = evm.loading || !!evm.pending;
    const showWalletRecovery = !flow.loading && !flow.action && !session.busy && !evm.pending && !evm.loading && (!evm.address || !evm.networkIsTestnet || !!evm.error);
	const activeCall = value?.attempts.some((row) => ['quoted', 'awaiting_wallet', 'submitted', 'confirming'].includes(row.status));
	const pending = value?.attempts.find((row) => row.txHash && ['submitted', 'confirming'].includes(row.status));
	const waiting = !!pending || value?.status === 'confirming' && !!value.deposit;
	const updates = useConfirmationPolling({ context: flow.context, enabled: active && flow.enabled, waiting, busy, error: flow.error || value?.lastError || '',
		check: () => pending ? flow.check(pending) : flow.deposit() });
	function callTitle(row: BridgeCallAttempt) { return row.kind === 'unpause' ? 'Activate token' : `Receive ${order.wrappedSymbol}`; }
	if (returnOnly) return <section aria-label="Return wrapped tokens">
		{flow.loading && <p role="status">Loading your return…</p>}
		{flow.error && <p className="result error" role="alert">{flow.error}</p>}
		{value?.status === 'completed' && <RedemptionEscrowPreview order={order} session={session} evm={evm} active={active} />}
	</section>;
	return <section className="htlc-section" aria-label="Order payment and mint" aria-busy={busy}>
		<header className="history-titlebar"><h4>{value ? labels[value.status] : 'Payment and mint'}</h4><button type="button" className="history-secondary" disabled={!flow.enabled || busy} onClick={flow.refresh}>Refresh saved progress</button></header>
		<BridgeSteps steps={[`Pay ${order.symbol}`, 'Wait for deposit', 'Confirm mint', `Receive ${order.wrappedSymbol}`]} current={!value?.deposit ? 0 : value.status === 'confirming' ? 1 : value.status === 'completed' ? 3 : 2} complete={value?.status === 'completed'} />
		{waiting && <ConfirmationUpdates automatic={updates.automatic} onChange={updates.setAutomatic} paused={updates.paused} />}
		{flow.loading && <p role="status">Loading saved progress…</p>}
		{!value && !flow.loading && !flow.error && <>
			<p>Open payment details, then send the exact source token amount to the address shown. Funds are held by the bridge until settlement; there is no automatic refund.</p>
			<label className="bridge-role-choice"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} /> I understand the custody model and will send exactly {amount} {order.symbol} on TBC Testnet to this order only.</label>
			<button type="button" disabled={!flow.enabled || busy || !acknowledged} onClick={() => { void flow.open(); }}>Open payment details</button>
		</>}
		{value && <>
			{value.status !== 'completed' && <p>Follow the highlighted step. Keep MetaMask open when confirming a wallet request.</p>}
			<details className="bridge-flow-history"><summary>Payment amount and addresses</summary>
			<dl className="history-detail-grid">
				<div><dt>Exact payment · TBC Testnet</dt><dd>{amount} {order.symbol}</dd></div>
				<div><dt>Send from this TBC wallet</dt><dd><code>{order.sender}</code></dd></div>
				<div><dt>Send {order.symbol} to this address</dt><dd><code>{value.custodyAddress}</code></dd></div>
				<div><dt>{order.symbol} token contract</dt><dd><code>{order.contractId}</code></dd></div>
				<div><dt>{order.wrappedSymbol} receiving wallet · HyperEVM Testnet (998)</dt><dd><code>{order.recipient}</code></dd></div>
			</dl></details>
			{!value.deposit && <>
				<BridgeSourcePayment key={flow.context} order={order} settlement={value} session={session} enabled={active && flow.enabled} busy={busy} error={flow.error} verify={txid => flow.deposit(txid)} />
				<details className="bridge-flow-history"><summary>Already paid or need recovery?</summary>
				<p>If you already sent this payment, paste its original TXID below. Do not send another payment. If the wallet button is unavailable and you have not paid, use the exact token, amount and address in Payment amount and addresses, then attach the TXID here.</p>
				<p className="history-note">Do not send native TBC as the token payment. Underpayments, overpayments, a different FT, or multiple payment groups require review. Once payment details are opened, this order cannot be closed as an unused preparation.</p>
				<label htmlFor={`deposit-${order.id}`}>TBC transfer TXID</label><input id={`deposit-${order.id}`} type="text" spellCheck={false} autoComplete="off" placeholder="64-character transaction ID from Turing Wallet" value={txid} disabled={busy} onChange={(event) => setTxid(event.target.value)} />
				<button type="button" disabled={busy || !/^[0-9a-f]{64}$/i.test(txid.trim())} onClick={() => { void flow.deposit(txid); }}>Verify source deposit</button>
				</details>
			</>}
			{value.deposit && <>
				<p>Source transaction: <code>{value.deposit.txid}</code></p>
				<p>Source confirmations: <strong>{value.deposit.confirmations} / {order.sourceConfirmationsRequired} required</strong> · Checked {formatDateTime(value.deposit.checkedAt)} MYT</p>
				<p>Actual source network fee: {formatRawAmount(value.deposit.feeRaw, 6)} TBC</p>
				{value.status !== 'completed' && <button type="button" className="history-secondary" disabled={busy} onClick={() => { void flow.deposit(); }}>Check now</button>}
			</>}
			{value.status === 'ready_to_mint' && !activeCall && <div className="htlc-section">
				<p>Click Prepare next wallet step, review the fee and confirm in MetaMask.</p>
				<button type="button" disabled={!canWallet} aria-describedby={walletBlockReason ? `wallet-block-${order.id}` : undefined} onClick={() => { void flow.quote('next'); }}>Prepare next wallet step</button>
                {walletBlockReason && <p id={`wallet-block-${order.id}`} className="history-feedback" role="status">{walletBlockReason}</p>}
                {showWalletRecovery && <div className="htlc-actions">
                    <button type="button" className="history-secondary" disabled={walletReadBusy} onClick={evm.refresh}>Refresh MetaMask connection</button>
                    {(!evm.address || !!evm.error) && <button type="button" className="history-secondary" disabled={walletReadBusy} onClick={() => { void evm.connect(); }}>Reconnect MetaMask</button>}
                    {evm.address && !evm.networkIsTestnet && <button type="button" className="history-secondary" disabled={walletReadBusy} onClick={() => { void evm.switchNetwork(); }}>Switch to HyperEVM Testnet</button>}
                </div>}
			</div>}
			{<AttemptHistory rows={value.attempts} render={(row) => <article className="bridge-deployment-record" key={row.id}>
				<h4>{callTitle(row)} · {bridgeStatus(row.status)}</h4>
				<p>From <code>{row.transaction.from}</code> → Contract <code>{row.transaction.to}</code></p>
				<p>Estimated fee {formatHypeBalance(row.estimatedFeeWei)} HYPE · Budget with gas margin {formatHypeBalance(row.budgetWei)} HYPE</p>
				{row.status === 'quoted' && <>
					<p>Confirm before {formatDateTime(row.expiresAt)} MYT.</p>
					{row.kind === 'mint' && <p>Mint {amount} {order.wrappedSymbol} to <code>{order.recipient}</code> for this order.</p>}
					<label className="bridge-role-choice"><input type="checkbox" checked={!!reviewed[row.id]} disabled={busy} onChange={(event) => setReviewed((old) => ({ ...old, [row.id]: event.target.checked }))} /> I reviewed this action, address, token amount and HYPE budget.</label>
					<div className="htlc-actions"><button type="button" disabled={!canWallet || !reviewed[row.id] || now >= Date.parse(row.expiresAt) || evm.address?.toLowerCase() !== row.transaction.from} onClick={() => { void flow.send(row); }}>Confirm {row.kind} in MetaMask</button><button type="button" className="history-secondary" disabled={busy} onClick={() => { void flow.cancel(row); }}>Discard unused quote</button></div>
				</>}
				{row.status === 'awaiting_wallet' && !row.txHash && <>
					<p>Open MetaMask and finish the pending request. If it was already sent, paste its transaction hash below. Do not send again.</p>
					<label htmlFor={`call-hash-${row.id}`}>Recover HyperEVM transaction hash</label><input id={`call-hash-${row.id}`} type="text" autoComplete="off" spellCheck={false} value={hashes[row.id] ?? ''} disabled={busy} onChange={(event) => setHashes((old) => ({ ...old, [row.id]: event.target.value }))} />
					<button type="button" disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hashes[row.id]?.trim() ?? '')} onClick={() => { void flow.attach(row, hashes[row.id]); }}>Save Activity hash</button>
					<details><summary>No transaction was sent?</summary><p>Check MetaMask Activity first. Discarding this local request cannot cancel a pending wallet or chain transaction. If a transaction exists, recover its hash above.</p><label className="bridge-role-choice"><input type="checkbox" checked={!!notSent[row.id]} disabled={busy} onChange={(event) => setNotSent((old) => ({ ...old, [row.id]: event.target.checked }))} /> I checked Activity and confirmed this request was rejected or never sent.</label><button type="button" className="history-secondary" disabled={busy || !notSent[row.id]} onClick={() => { void flow.discardUnsent(row); }}>Discard unsent wallet request</button></details>
				</>}
				{row.txHash && <>
					<p>HyperEVM transaction: <code>{row.txHash}</code></p><p>Confirmations: {row.confirmations} / {order.destinationConfirmationsRequired} required{row.actualFeeWei !== null ? ` · Actual fee ${formatHypeBalance(row.actualFeeWei)} HYPE` : ''}</p>
					<button type="button" className="history-secondary" disabled={busy || value.status === 'completed'} onClick={() => { void flow.check(row); }}>Check now</button>
				</>}
				{row.lastError && <p className="result error" role="alert">{row.lastError}</p>}
			</article>} />}
			{value.status === 'completed' && <div className="result success">
				<p>{amount} {order.wrappedSymbol} was minted to <code>{order.recipient}</code>. Both chain confirmation thresholds were verified.</p>
				<button type="button" disabled={!canWallet || flow.tokenImport.status === 'added' || evm.address?.toLowerCase() !== order.recipient.toLowerCase()} onClick={() => { void flow.importToken(); }}>{flow.action === 'import' ? 'Confirm import in MetaMask…' : flow.tokenImport.status === 'added' ? `${order.wrappedSymbol} added to MetaMask` : `Add ${order.wrappedSymbol} to MetaMask`}</button>
				<p>Add {order.wrappedSymbol} to view your balance in MetaMask. No fee is charged.</p>
				{evm.address?.toLowerCase() !== order.recipient.toLowerCase() && <p>Select the receiving account on HyperEVM Testnet to add {order.wrappedSymbol}.</p>}
				{flow.tokenImport.message && <p role={flow.tokenImport.status === 'error' ? 'alert' : 'status'}>{flow.tokenImport.message}</p>}
				<p>Select the receiving account on HyperEVM Testnet to view {order.wrappedSymbol}.</p>
			</div>}
			{value.status === 'completed' && <button type="button" className="history-secondary" onClick={onReturn}>Return {order.wrappedSymbol} → Receive {order.symbol}</button>}
			{value.lastError && <p className="result error" role="alert">{value.lastError}</p>}
		</>}
		{flow.action && <p role="status">{flow.action === 'import' ? 'Open MetaMask to approve or cancel token import.' : flow.action.startsWith('send:') ? 'Checking the order / waiting for MetaMask. Finish the current prompt; do not send again.' : 'Updating saved progress…'}</p>}
		{flow.error && <p className="result error" role="alert">{flow.error}</p>}
	</section>;
}
