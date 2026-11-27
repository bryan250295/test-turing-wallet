import { Link } from 'react-router-dom';
import { useEffect, useState, type FormEvent } from 'react';
import type { WalletSession } from '../../types/wallet';
import type { BridgeOrder, BridgeOrderInput } from '../../types/learningBridge';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeOrders from '../../hooks/useBridgeOrders';
import { formatRawAmount, tokenAmountToRaw } from '../../utils/tokenAmounts';
import { formatDateTime } from '../../utils/dateTime';
import { getErrorMessage } from '../../utils/errors';
import BridgeSettlement from './BridgeSettlement';

export interface BridgeTransferAsset { contractId: string; name: string; symbol: string; decimals: number; totalSupplyRaw: string; verifiedAt: string }
type BridgeOrderStage = 'all' | 'order' | 'transfer';
interface Props {
	session: WalletSession;
	evm: ReturnType<typeof useHyperEvmWallet>;
	asset: BridgeTransferAsset | null;
	active: boolean;
	direction: 'forward' | 'return';
	onReturn: () => void;
	destinationChainId?: number;
	governanceMode?: 'multisig-relayer-v1.5' | 'ethereum-burn-multisig-v1';
	orderId?: string;
	stage?: BridgeOrderStage;
	onOrderSaved?: () => void;
	onOrderAvailable?: () => void;
	onContinueTransfer?: () => void;
	onBackToOrder?: () => void;
	compactReturn?: boolean;
}
export default function BridgeOrders({ session, evm, asset, active, direction, onReturn, destinationChainId = 998, governanceMode = 'multisig-relayer-v1.5', orderId, stage = 'all', onOrderSaved, onOrderAvailable, onContinueTransfer, onBackToOrder, compactReturn = false }: Props) {
	const orders = useBridgeOrders(session, evm, active, asset?.verifiedAt, destinationChainId);
	const destinationName = destinationChainId === 11_155_111 ? 'Ethereum Sepolia' : 'HyperEVM Testnet';
	const returnEnabled = true;
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
		const routes = orders.setup?.deployments.filter(row => row.contractId === asset?.contractId && row.chainId === destinationChainId && row.governanceMode === governanceMode) ?? [];
		setDeploymentId(routes.length === 1 ? routes[0].id : '');
	}, [orders.setup, asset?.contractId, asset?.verifiedAt]);
	const routes = orders.setup?.deployments.filter(row => row.contractId === asset?.contractId && row.decimals === asset.decimals && row.chainId === destinationChainId && row.governanceMode === governanceMode) ?? [];
	const destination = routes.find((row) => row.id === (review?.deploymentId ?? deploymentId));
	const sourceSymbol = asset?.symbol ?? 'source token';
	const wrappedSymbol = destination?.wrappedSymbol ?? 'wrapped token';
	const selectedRecipient = useConnected ? evm.address ?? '' : recipient.trim();
	const busy = orders.loading || !!orders.action || session.busy || evm.loading || !!evm.pending;
	const routeRows = orders.rows.filter((row) => row.destinationChainId === destinationChainId && row.contractId === asset?.contractId && (!orderId || row.id === orderId));
	const hasSavedOrder = routeRows.some((row) => row.status === 'prepared');
	const openCount = routeRows.filter((row) => row.status === 'prepared' && row.settlementStatus !== 'completed').length;
	const canPrepare = orders.enabled && orders.setup?.custodyReady && evm.networkIsTestnet && !!evm.address
		&& !!asset && !!destination && asset.contractId === destination.contractId && openCount < (orders.setup?.maxOpenOrders ?? 0);
	function startReview(event: FormEvent) {
		event.preventDefault(); setError(''); setNotice('');
		try {
			if (!canPrepare || !destination) throw new Error('Verify your source asset and select its verified bridge route before preparing an order.');
			const value = amount.trim();
			if (value.length > 278) throw new Error('The amount is too long.');
			if (tokenAmountToRaw(value, asset!.decimals) > BigInt(asset!.totalSupplyRaw)) throw new Error('Amount exceeds the verified token total supply.');
			if (!/^0x[0-9a-f]{40}$/i.test(selectedRecipient) || /^0x0{40}$/i.test(selectedRecipient) || selectedRecipient.toLowerCase() === destination.contractAddress.toLowerCase()) throw new Error('Use a nonzero receiving wallet address, different from the Wrapped token contract.');
			setReview({ idempotencyKey: crypto.randomUUID(), deploymentId: destination.id, amount: value, recipient: selectedRecipient });
		} catch (cause) { setError(getErrorMessage(cause)); }
	}
	async function saveReview() {
		if (!review || !canPrepare || busy) return;
		if (await orders.prepare(review, orderId)) {
			setReview(null); setAmount(''); setRecipient(''); setError('');
			setNotice('Order saved. Your tokens remain in your wallet. Open this order’s payment details when you are ready to transfer your selected token.');
			onOrderSaved?.();
		}
	}
	useEffect(() => {
		if (hasSavedOrder) onOrderAvailable?.();
	}, [hasSavedOrder, onOrderAvailable]);
	const archive = direction === 'forward' ? routeRows.filter(row => row.status === 'cancelled' || row.settlementStatus === 'completed') : [];
	const currentRows = routeRows.filter(row => direction === 'forward' ? !archive.includes(row) : row.status === 'prepared' && row.settlementStatus === 'completed');
	const displayedRows = stage === 'all' ? currentRows : routeRows.filter((row) => row.status === 'prepared');
	function renderOrder(row: BridgeOrder, includeSettlement: boolean) {
		return <article className="htlc-section" key={row.id}>
			<h4>{formatRawAmount(row.amountRaw, row.decimals)} {direction === 'forward' ? `${row.symbol} → ${row.wrappedSymbol}` : `${row.wrappedSymbol} → ${row.symbol} · original transfer`} · {row.status === 'cancelled' ? 'Closed' : row.settlementStatus === 'completed' ? 'Completed' : row.settlementStarted ? 'Order in progress' : 'Prepared'}</h4>
			<p className="history-note">Created {formatDateTime(row.createdAt)} MYT · Order <code>{row.id}</code></p>
			<details className="bridge-flow-history"><summary>Order details</summary><dl className="history-detail-grid">
				<div><dt>Receiving wallet · {destinationName} ({destinationChainId})</dt><dd><code>{row.recipient}</code></dd></div>
				<div><dt>Wrapped token contract</dt><dd><code>{row.destinationContract}</code></dd></div>
				<div><dt>Progress</dt><dd>{row.status === 'prepared' ? row.settlementStarted ? 'Continue below' : 'Open payment details to continue' : `Unused preparation closed ${formatDateTime(row.cancelledAt!)} MYT`}</dd></div>
			</dl></details>
			{stage === 'all' && row.status === 'prepared' && !row.settlementStarted && <button type="button" className="history-secondary" disabled={busy} onClick={() => { void orders.cancel(row); }}>{orders.action === `cancel:${row.id}` ? 'Closing…' : 'Close unused preparation'}</button>}
			{includeSettlement && row.status === 'prepared' && <BridgeSettlement order={row} session={session} evm={evm} active={active} onChanged={orders.refresh} returnOnly={direction === 'return'} onReturn={onReturn} allowReturn={returnEnabled} />}
		</article>;
	}
	const returnOrder = direction === 'return'
		? routeRows.find((row) => row.status === 'prepared' && row.settlementStatus === 'completed')
		: undefined;

	if (compactReturn) return <section className="bridge-return-panel" aria-labelledby="bridge-return-panel-title" aria-busy={!!orders.action || orders.loading}>
		<header className="history-titlebar bridge-return-panel-heading">
			<div>
				<p className="eyebrow">BURN-RETURN</p>
				<h3 id="bridge-return-panel-title">Burn wrapped tokens and receive the original tokens</h3>
				<p className="history-note">This return belongs to the completed bridge-out order below. It does not create a second transfer order.</p>
			</div>
			<span className="network-pill">Ethereum Sepolia → TBC Testnet</span>
		</header>
		{!orders.enabled && <p className="history-feedback">Connect the original Turing Wallet on TBC Testnet to load and continue this return.</p>}
		{orders.loading && <p role="status">Loading saved return progress…</p>}
		{orders.error && <p className="result error" role="alert">{orders.error}</p>}
		{orders.enabled && !orders.loading && !returnOrder && !orders.error && <p className="result warning">The completed bridge-out order is not available for this wallet. Return to Reconciliation and open the transfer with its original TBC wallet.</p>}
		{returnOrder && <>
			<dl className="history-detail-grid bridge-return-summary">
				<div><dt>Amount to burn · Ethereum Sepolia</dt><dd>{formatRawAmount(returnOrder.amountRaw, returnOrder.decimals)} {returnOrder.wrappedSymbol}</dd></div>
				<div><dt>Amount to receive · TBC Testnet</dt><dd>{formatRawAmount(returnOrder.amountRaw, returnOrder.decimals)} {returnOrder.symbol}</dd></div>
				<div><dt>Burn from original receiving wallet</dt><dd><code>{returnOrder.recipient}</code></dd></div>
				<div><dt>Return to original TBC wallet</dt><dd><code>{returnOrder.sender}</code></dd></div>
			</dl>
			<BridgeSettlement order={returnOrder} session={session} evm={evm} active={active} onChanged={orders.refresh} returnOnly onReturn={onReturn} allowReturn={returnEnabled} />
		</>}
	</section>;

	return <section className="htlc-section bridge-orders" aria-labelledby="bridge-orders-title" aria-busy={!!orders.action || orders.loading}>
		<header className="history-titlebar"><div><h3 id="bridge-orders-title">{stage === 'order' ? 'Amount and receiving account' : direction === 'forward' ? stage === 'transfer' ? 'Pay and receive' : 'Create or continue an order' : 'Return tokens to TBC'}</h3><p>{stage === 'order' ? 'Review and save the exact transfer terms. Saving does not move tokens.' : direction === 'forward' ? 'Follow the highlighted action to pay once, verify the deposit and receive the wrapped token.' : 'Continue from the forward order that minted your wrapped tokens.'}</p></div><span className="network-pill">Testnet · wallet confirmation</span></header>
		{direction === 'forward' ? <p>Save the amount and receiving wallet, pay your selected token once through Turing Wallet, then confirm minting in MetaMask.</p> : <p>{destinationChainId === 11_155_111 ? `Return the full original amount. ${wrappedSymbol} is burned on Sepolia; only the verified burn authorizes release of the original ${sourceSymbol} reserve.` : 'Return the full original amount. Your wrapped tokens will be permanently locked before the source tokens are sent to your TBC wallet.'}</p>}
		<div className="htlc-actions"><button type="button" className="history-secondary" disabled={!orders.enabled || busy} onClick={orders.refresh}>Refresh saved orders</button></div>
		{!orders.enabled && <p>{!session.address || !session.networkIsDevnet || !session.backendAuth.ready
			? 'Connect Turing Wallet on TBC Testnet to load your orders. Use Reconnect if its login needs confirmation.'
			: 'This saved bridge route is not ready. Refresh the transfer or return to Reconciliation and open it again.'}</p>}
		{orders.setup && !orders.setup.custodyReady && <p className="history-feedback">{orders.setup.message}</p>}
		{direction === 'forward' && orders.enabled && !asset && <p>To create a transfer, choose and verify your token above.</p>}
		{orders.enabled && !evm.networkIsTestnet && <p>Connect MetaMask on {destinationName} ({destinationChainId}) to choose your receiving account.</p>}
		{orders.setup && !routes.length && direction === 'forward' && asset && <p>Create your wrapped token above, then refresh your orders.</p>}
		{orders.setup && openCount >= orders.setup.maxOpenOrders && <p>You have {openCount} unfinished orders. Complete one or close an unused preparation before creating another.</p>}
		{stage !== 'transfer' && direction === 'forward' && orders.enabled && (!orderId || !routeRows.length) && <details className="bridge-flow-history" open={!orders.rows.length || !!review || !!orderId}><summary>{orderId ? 'Add amount and receiving account' : 'Create a new transfer'}</summary><form className="htlc-form" onSubmit={startReview}>
			{routes.length > 1 && <><label htmlFor="bridge-order-contract">Bridge route</label>
			<select id="bridge-order-contract" value={deploymentId} disabled={busy || !!review} onChange={(event) => setDeploymentId(event.target.value)}>
				<option value="">Choose a verified bridge route</option>
				{routes.map((row) => <option key={row.id} value={row.id}>{row.sourceSymbol} · TBC Testnet → {row.wrappedSymbol} · {destinationName}</option>)}
			</select></>}
			{destination && <><h4>Selected bridge route</h4><dl className="history-detail-grid">
				<div><dt>Send from Turing Wallet</dt><dd>{asset?.name} ({sourceSymbol}) · TBC Testnet</dd></div>
				<div><dt>Receive in MetaMask</dt><dd>{destination.wrappedName} ({wrappedSymbol}) · {destinationName}</dd></div>
				<div><dt>Bridge method</dt><dd>{destinationChainId === 11_155_111 ? 'TBC custody → Sepolia mint · burn to return' : 'TBC custody → HyperEVM mint · permanent lock to return'}</dd></div>
				<div><dt>Destination token contract</dt><dd><code>{destination.contractAddress}</code></dd></div>
			</dl></>}
			{destinationChainId === 11_155_111 && destination?.sourceAssetKind === 'native-tbc' && <p className="history-feedback"><strong>Source asset: Native TBC.</strong> Choose a verified FT route above if you want to bridge Turing Token (TT).</p>}
			<label htmlFor="bridge-order-amount">Amount ({sourceSymbol})</label><input id="bridge-order-amount" type="text" inputMode="decimal" autoComplete="off" placeholder="Amount" value={amount} disabled={busy || !!review} onChange={(event) => setAmount(event.target.value)} />
			<label className="bridge-role-choice"><input type="checkbox" checked={useConnected} disabled={busy || !!review} onChange={(event) => setUseConnected(event.target.checked)} /> Receive with connected MetaMask account</label>
			<label htmlFor="bridge-order-recipient">{destinationName} receiving address</label><input id="bridge-order-recipient" type="text" spellCheck={false} autoComplete="off" value={selectedRecipient} readOnly={useConnected} disabled={busy || !!review} onChange={(event) => setRecipient(event.target.value)} placeholder="0x…" />
			<p className="history-note">1 {sourceSymbol} = 1 {wrappedSymbol}. Check the receiving address before saving.</p>
			{!review && <button type="submit" disabled={!canPrepare || busy || !destination}>Review order</button>}
		</form>
		{review && <section className="htlc-section" aria-labelledby="bridge-order-review-title">
			<h4 id="bridge-order-review-title">Review transfer</h4>
			<dl className="history-detail-grid">
				<div><dt>Source → destination amount</dt><dd>{review.amount} {sourceSymbol} → {review.amount} {wrappedSymbol}</dd></div>
				<div><dt>Receiving wallet · {destinationName} ({destinationChainId})</dt><dd><code>{review.recipient}</code></dd></div>
				<div><dt>Wrapped token contract</dt><dd><code>{destination?.contractAddress}</code></dd></div>
				<div><dt>Source asset · TBC Testnet</dt><dd>{destination?.sourceAssetKind === 'native-tbc' ? 'Native TBC' : <code>{asset?.contractId}</code>}</dd></div>
			</dl>
			<p>Save this order, then open its payment details to get the deposit address.</p>
			<div className="htlc-actions"><button type="button" disabled={!canPrepare || busy} onClick={() => { void saveReview(); }}>{orders.action === 'prepare' ? 'Preparing order…' : 'Save order'}</button><button type="button" className="history-secondary" disabled={busy} onClick={() => { setReview(null); setError(''); }}>Edit terms</button></div>
			<p className="history-note">If a request times out, refresh saved orders before retrying this review or starting another. No payment is sent by a retry.</p>
		</section>}
		</details>}
		{(error || orders.error) && <p className="result error" role="alert">{error || orders.error}</p>}
		{notice && <p className="result success" role="status">{notice}</p>}
		<h4>{orderId ? stage === 'order' ? 'Saved order' : 'This transfer' : direction === 'forward' ? 'Your transfers' : 'Your return orders'}</h4>
		{direction === 'return' && !orders.loading && !routeRows.some((row) => row.status === 'prepared' && row.settlementStatus === 'completed') && <p>Complete a forward transfer before returning wrapped tokens. Choose the forward direction for this destination to continue an unfinished transfer.</p>}
		{orders.loading && <p role="status">Loading saved orders…</p>}
		{orders.enabled && !orders.loading && !routeRows.length && !orders.error && <p>{stage === 'transfer' ? 'No saved order is available for this transfer yet.' : 'No saved orders for this route yet.'}</p>}
		{stage === 'transfer' && orders.enabled && !orders.loading && !routeRows.length && onBackToOrder && <button type="button" onClick={onBackToOrder}>Go to Step 3 · Create order</button>}
		{stage === 'all' && direction === 'forward' && orders.enabled && !orders.loading && !orders.error && orders.rows.length > 0 && !currentRows.length && <p>No active transfers. Completed receipts are in the history below.</p>}
		{displayedRows.map(row => renderOrder(row, stage !== 'order'))}
		{stage === 'order' && hasSavedOrder && onContinueTransfer && <div className="bridge-stage-actions"><button type="button" onClick={onContinueTransfer}>Continue to transfer</button><p>The order is saved. Payment and confirmation happen in Step 4.</p></div>}
		{stage === 'all' && archive.length > 0 && <details className="bridge-flow-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
			<summary>Completed and closed transfers ({archive.length})</summary>
			<p className="history-note">These are saved receipts. Open a receipt to view its transactions or add the wrapped token to your wallet.</p>
			<Link to="/bridge-lab?tab=reconciliation">Search all transfers, transactions and fees</Link>
			{historyOpen && archive.map(row => renderOrder(row, true))}
		</details>}
	</section>;
}
