import { Link } from 'react-router-dom';
import { useEffect, useState, type FormEvent } from 'react';
import type { WalletSession } from '../../types/wallet';
import type { BridgeOrder, BridgeOrderInput, VerifiedBridgeAsset } from '../../types/learningBridge';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeOrders from '../../hooks/useBridgeOrders';
import { formatRawAmount, tokenAmountToRaw } from '../../utils/tokenAmounts';
import { formatDateTime } from '../../utils/dateTime';
import { getErrorMessage } from '../../utils/errors';
import BridgeSettlement from './BridgeSettlement';

interface Props { session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; asset: VerifiedBridgeAsset | null; active: boolean; direction: 'forward' | 'return'; onReturn: () => void }
export default function BridgeOrders({ session, evm, asset, active, direction, onReturn }: Props) {
	const orders = useBridgeOrders(session, evm, active, asset?.verifiedAt);
	const [deploymentId, setDeploymentId] = useState('');
	const [historyOpen, setHistoryOpen] = useState(false);
	const [amount, setAmount] = useState('');
	const [recipient, setRecipient] = useState('');
	const [useConnected, setUseConnected] = useState(true);
	const [review, setReview] = useState<BridgeOrderInput | null>(null);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	useEffect(() => {
		setHistoryOpen(false); setAmount(''); setRecipient(''); setUseConnected(true); setReview(null); setError(''); setNotice(''); setDeploymentId('');
	}, [orders.context, asset?.contractId, asset?.verifiedAt]);
	useEffect(() => {
		const routes = orders.setup?.deployments.filter(row => row.contractId === asset?.contractId) ?? [];
		setDeploymentId(routes.length === 1 ? routes[0].id : '');
	}, [orders.setup, asset?.contractId, asset?.verifiedAt]);
	const routes = orders.setup?.deployments.filter(row => row.contractId === asset?.contractId && row.decimals === asset.decimals) ?? [];
	const destination = routes.find((row) => row.id === (review?.deploymentId ?? deploymentId));
	const sourceSymbol = asset?.symbol ?? 'source token';
	const wrappedSymbol = destination?.wrappedSymbol ?? 'wrapped token';
	const selectedRecipient = useConnected ? evm.address ?? '' : recipient.trim();
	const busy = orders.loading || !!orders.action || session.busy || evm.loading || !!evm.pending;
	const openCount = orders.rows.filter((row) => row.status === 'prepared' && row.settlementStatus !== 'completed').length;
	const canPrepare = orders.enabled && orders.setup?.custodyReady && evm.networkIsTestnet && !!evm.address
		&& !!asset && !!destination && asset.contractId === destination.contractId && openCount < (orders.setup?.maxOpenOrders ?? 0);
	function startReview(event: FormEvent) {
		event.preventDefault(); setError(''); setNotice('');
		try {
			if (!canPrepare || !destination) throw new Error('Verify your token and select its verified wrapped contract before preparing an order.');
			const value = amount.trim();
			if (value.length > 278) throw new Error('The amount is too long.');
			if (tokenAmountToRaw(value, asset!.decimals) > BigInt(asset!.totalSupplyRaw)) throw new Error('Amount exceeds the verified token total supply.');
			if (!/^0x[0-9a-f]{40}$/i.test(selectedRecipient) || /^0x0{40}$/i.test(selectedRecipient) || selectedRecipient.toLowerCase() === destination.contractAddress.toLowerCase()) throw new Error('Use a nonzero receiving wallet address, different from the Wrapped token contract.');
			setReview({ idempotencyKey: crypto.randomUUID(), deploymentId: destination.id, amount: value, recipient: selectedRecipient });
		} catch (cause) { setError(getErrorMessage(cause)); }
	}
	async function saveReview() {
		if (!review || !canPrepare || busy) return;
		if (await orders.prepare(review)) {
			setReview(null); setAmount(''); setRecipient(''); setError('');
			setNotice('Order saved. Your tokens remain in your wallet. Open this order’s payment details when you are ready to transfer your selected token.');
		}
	}
	const archive = direction === 'forward' ? orders.rows.filter(row => row.status === 'cancelled' || row.settlementStatus === 'completed') : [];
	const currentRows = orders.rows.filter(row => direction === 'forward' ? !archive.includes(row) : row.status === 'prepared' && row.settlementStatus === 'completed');
	function renderOrder(row: BridgeOrder) {
		return <article className="htlc-section" key={row.id}>
			<h4>{formatRawAmount(row.amountRaw, row.decimals)} {direction === 'forward' ? `${row.symbol} → ${row.wrappedSymbol}` : `${row.wrappedSymbol} → ${row.symbol} · original transfer`} · {row.status === 'cancelled' ? 'Closed' : row.settlementStatus === 'completed' ? 'Completed' : row.settlementStarted ? 'Order in progress' : 'Prepared'}</h4>
			<p className="history-note">Created {formatDateTime(row.createdAt)} MYT · Order <code>{row.id}</code></p>
			<details className="bridge-flow-history"><summary>Order details</summary><dl className="history-detail-grid">
				<div><dt>Receiving wallet · HyperEVM Testnet (998)</dt><dd><code>{row.recipient}</code></dd></div>
				<div><dt>Wrapped token contract</dt><dd><code>{row.destinationContract}</code></dd></div>
				<div><dt>Progress</dt><dd>{row.status === 'prepared' ? row.settlementStarted ? 'Continue below' : 'Open payment details to continue' : `Unused preparation closed ${formatDateTime(row.cancelledAt!)} MYT`}</dd></div>
			</dl></details>
			{row.status === 'prepared' && !row.settlementStarted && <button type="button" className="history-secondary" disabled={busy} onClick={() => { void orders.cancel(row); }}>{orders.action === `cancel:${row.id}` ? 'Closing…' : 'Close unused preparation'}</button>}
			{row.status === 'prepared' && <BridgeSettlement order={row} session={session} evm={evm} active={active} onChanged={orders.refresh} returnOnly={direction === 'return'} onReturn={onReturn} />}
		</article>;
	}

	return <section className="htlc-section bridge-orders" aria-labelledby="bridge-orders-title" aria-busy={!!orders.action || orders.loading}>
		<header className="history-titlebar"><div><h3 id="bridge-orders-title">{direction === 'forward' ? '4. Review and send' : 'Return tokens to TBC'}</h3><p>{direction === 'forward' ? 'Create an order or continue a saved transfer.' : 'Continue from the forward order that minted your wrapped tokens.'}</p></div><span className="network-pill">Testnet · wallet confirmation</span></header>
		{direction === 'forward' ? <p>Save the amount and receiving wallet, pay your selected token once through Turing Wallet, then confirm minting in MetaMask.</p> : <p>Return the full original amount. Your wrapped tokens will be permanently locked before the source tokens are sent to your TBC wallet.</p>}
		<div className="htlc-actions"><button type="button" className="history-secondary" disabled={!orders.enabled || busy} onClick={orders.refresh}>Refresh saved orders</button></div>
		{!orders.enabled && <p>Connect Turing Wallet on TBC Testnet to load your orders. Use Reconnect if its login needs confirmation.</p>}
		{orders.setup && !orders.setup.custodyReady && <p className="history-feedback">{orders.setup.message}</p>}
		{direction === 'forward' && orders.enabled && !asset && <p>To create a transfer, choose and verify your token above.</p>}
		{orders.enabled && !evm.networkIsTestnet && <p>Connect MetaMask on HyperEVM Testnet (998) to choose your receiving account.</p>}
		{orders.setup && !routes.length && direction === 'forward' && asset && <p>Create your wrapped token above, then refresh your orders.</p>}
		{orders.setup && openCount >= orders.setup.maxOpenOrders && <p>You have {openCount} unfinished orders. Complete one or close an unused preparation before creating another.</p>}
		{direction === 'forward' && orders.enabled && <details className="bridge-flow-history" open={!orders.rows.length || !!review}><summary>Create a new transfer</summary><form className="htlc-form" onSubmit={startReview}>
			<label htmlFor="bridge-order-contract">Wrapped token contract</label>
			<select id="bridge-order-contract" value={deploymentId} disabled={busy || !!review} onChange={(event) => setDeploymentId(event.target.value)}>
				<option value="">Choose a verified deployment</option>
				{routes.map((row) => <option key={row.id} value={row.id}>{row.wrappedName} ({row.wrappedSymbol}) · {row.contractAddress}</option>)}
			</select>
			<label htmlFor="bridge-order-amount">Amount ({sourceSymbol})</label><input id="bridge-order-amount" type="text" inputMode="decimal" autoComplete="off" placeholder="For example 10.5" value={amount} disabled={busy || !!review} onChange={(event) => setAmount(event.target.value)} />
			<label className="bridge-role-choice"><input type="checkbox" checked={useConnected} disabled={busy || !!review} onChange={(event) => setUseConnected(event.target.checked)} /> Receive with connected MetaMask account</label>
			<label htmlFor="bridge-order-recipient">HyperEVM receiving address</label><input id="bridge-order-recipient" type="text" spellCheck={false} autoComplete="off" value={selectedRecipient} readOnly={useConnected} disabled={busy || !!review} onChange={(event) => setRecipient(event.target.value)} placeholder="0x…" />
			<p className="history-note">1 {sourceSymbol} = 1 {wrappedSymbol}. Check the receiving address before saving.</p>
			{!review && <button type="submit" disabled={!canPrepare || busy || !destination}>Review order</button>}
		</form>
		{review && <section className="htlc-section" aria-labelledby="bridge-order-review-title">
			<h4 id="bridge-order-review-title">Review transfer</h4>
			<dl className="history-detail-grid">
				<div><dt>Source → destination amount</dt><dd>{review.amount} {sourceSymbol} → {review.amount} {wrappedSymbol}</dd></div>
				<div><dt>Receiving wallet · HyperEVM Testnet (998)</dt><dd><code>{review.recipient}</code></dd></div>
				<div><dt>Wrapped token contract</dt><dd><code>{destination?.contractAddress}</code></dd></div>
				<div><dt>Source FT · TBC Testnet</dt><dd><code>{asset?.contractId}</code></dd></div>
			</dl>
			<p>Save this order, then open its payment details to get the deposit address.</p>
			<div className="htlc-actions"><button type="button" disabled={!canPrepare || busy} onClick={() => { void saveReview(); }}>{orders.action === 'prepare' ? 'Preparing order…' : 'Save order'}</button><button type="button" className="history-secondary" disabled={busy} onClick={() => { setReview(null); setError(''); }}>Edit terms</button></div>
			<p className="history-note">If a request times out, refresh saved orders before retrying this review or starting another. No payment is sent by a retry.</p>
		</section>}
		</details>}
		{(error || orders.error) && <p className="result error" role="alert">{error || orders.error}</p>}
		{notice && <p className="result success" role="status">{notice}</p>}
		<h4>{direction === 'forward' ? 'Your transfers' : 'Your return orders'}</h4>
		{direction === 'return' && !orders.loading && !orders.rows.some((row) => row.status === 'prepared' && row.settlementStatus === 'completed') && <p>Complete a forward transfer before returning wrapped tokens. Choose TBC → HyperEVM to continue an unfinished transfer.</p>}
		{orders.loading && <p role="status">Loading saved orders…</p>}
		{orders.enabled && !orders.loading && !orders.rows.length && !orders.error && <p>No saved orders for this TBC wallet yet.</p>}
		{direction === 'forward' && orders.enabled && !orders.loading && !orders.error && orders.rows.length > 0 && !currentRows.length && <p>No active transfers. Completed receipts are in the history below.</p>}
		{currentRows.map(row => renderOrder(row))}
		{archive.length > 0 && <details className="bridge-flow-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
			<summary>Completed and closed transfers ({archive.length})</summary>
			<p className="history-note">These are saved receipts. Open a receipt to view its transactions or add the wrapped token to your wallet.</p>
			<Link to="/bridge-lab?tab=reconciliation">Search all transfers, transactions and fees</Link>
			{historyOpen && archive.map(row => renderOrder(row))}
		</details>}
	</section>;
}
