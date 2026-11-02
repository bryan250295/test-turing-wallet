import RedemptionRelease from './RedemptionRelease';
import { useEffect, useRef, useState } from 'react';
import type { BridgeOrder, RedemptionEscrowDeployment, RedemptionOrder } from '../../../../shared/src/types/learningBridge';
import type { WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import { cancelRedemption, listRedemptions, prepareRedemption, redemptionRequestKey } from '../../services/redemptionOrders';
import { formatRawAmount, tokenAmountToRaw } from '../../utils/tokenAmounts';
import { formatDateTime } from '../../utils/dateTime';
import { getErrorMessage } from '../../utils/errors';

interface Props { order: BridgeOrder; escrow: RedemptionEscrowDeployment; session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean }
export default function RedemptionOrders({ order, escrow, session, evm, active }: Props) {
	const enabled = active && session.address === order.sender && session.networkIsDevnet && session.backendAuth.ready;
	const context = JSON.stringify([enabled, session.address, evm.address, evm.chainId, order.id, escrow.id]);
	const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch;
	const live = () => enabled && current.current.context === context && current.current.epoch === epoch;
	const controller = useRef<AbortController | null>(null); const working = useRef(false);
	const [revision, setRevision] = useState(0);
	const [state, setState] = useState<{ context: string; epoch: number; rows: RedemptionOrder[]; loading: boolean; error: string; notice: string }>({ context, epoch, rows: [], loading: false, error: '', notice: '' });
	const scale = 10n ** BigInt(order.decimals);
	const rawAmount = BigInt(order.amountRaw);
	const fraction = (rawAmount % scale).toString().padStart(order.decimals, '0').replace(/0+$/, '');
	const amount = `${rawAmount / scale}${fraction ? `.${fraction}` : ''}`;
	const [recipient, setRecipient] = useState(order.sender);
	const [review, setReview] = useState<{ context: string; epoch: number; amount: string; amountRaw: string; recipient: string; holder: string } | null>(null);
	useEffect(() => {
		setReview(null); setRecipient(order.sender);
		return () => { controller.current?.abort(); };
	}, [context]);
	useEffect(() => {
		const request = new AbortController();
		setState({ context, epoch, rows: [], loading: enabled, error: '', notice: '' });
		if (enabled) void listRedemptions(order, AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]))
			.then((rows) => { if (!request.signal.aborted && live()) setState({ context, epoch, rows, loading: false, error: '', notice: '' }); })
			.catch((cause) => { if (!request.signal.aborted && live()) setState({ context, epoch, rows: [], loading: false, error: getErrorMessage(cause), notice: '' }); });
		return () => request.abort();
	}, [context, revision]);
	const visible = state.context === context && state.epoch === epoch ? state : { rows: [], loading: enabled, error: '', notice: '' };
	const busy = visible.loading || session.busy || evm.loading || !!evm.pending;
	const canPrepare = enabled && !busy && escrow.status === 'verified' && !escrow.lastError && evm.networkIsTestnet && evm.address?.toLowerCase() === order.recipient.toLowerCase();
	const reviewed = review?.context === context && review.epoch === epoch ? review : null;
	const open = visible.rows.filter((row) => row.status === 'prepared');
	const reserved = open.reduce((total, row) => total + BigInt(row.amountRaw), 0n);
	function reviewTerms() {
		if (!canPrepare || working.current) return;
		try {
			const raw = tokenAmountToRaw(amount, order.decimals);
			if (raw + reserved > BigInt(order.amountRaw)) throw new Error('A return is already reserved for this amount. Continue or close your unused return below.');
			if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(recipient.trim())) throw new Error('Enter a valid TBC receiving address.');
			setReview({ context, epoch, amount, amountRaw: raw.toString(), recipient: recipient.trim(), holder: evm.address!.toLowerCase() });
			setState((old) => ({ ...old, error: '', notice: '' }));
		} catch (cause) { setState((old) => ({ ...old, error: getErrorMessage(cause) })); }
	}
	async function run(operation: (signal: AbortSignal) => Promise<string>) {
		if (!live() || working.current || busy) return;
		working.current = true;
		const request = new AbortController(); controller.current = request;
		setState((old) => ({ ...old, loading: true, error: '', notice: '' }));
		try {
			const signal = AbortSignal.any([request.signal, AbortSignal.timeout(125_000)]);
			const notice = await operation(signal);
			if (!live()) return;
			const rows = await listRedemptions(order, signal);
			if (live()) { setReview(null); setState({ context, epoch, rows, loading: false, error: '', notice }); }
		} catch (cause) {
			if (live()) {
				let rows = visible.rows;
				try { rows = await listRedemptions(order, AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])); } catch { /* Retain saved evidence. */ }
				if (live()) setState({ context, epoch, rows, loading: false, error: `${getErrorMessage(cause)} Refresh your returns before trying again.`, notice: '' });
			}
		} finally { working.current = false; if (controller.current === request) controller.current = null; }
	}
	function save() {
		if (!canPrepare || !reviewed) return;
		void run(async (signal) => {
			const account = await evm.readCurrent();
			if (!live() || account.chainId !== 998 || account.address.toLowerCase() !== reviewed.holder) throw new Error('The MetaMask account or network changed. Review the return again.');
			const terms = JSON.stringify([escrow.id, reviewed.holder, reviewed.recipient, reviewed.amountRaw]);
			await prepareRedemption(order, escrow, { escrowId: escrow.id, idempotencyKey: redemptionRequestKey(order, terms), holder: reviewed.holder, tbcRecipient: reviewed.recipient, amount: reviewed.amount }, reviewed.amountRaw, signal);
			return 'Return saved. Continue below to pay the TBC fee and confirm your return.';
		});
	}
	return <section className="htlc-section" aria-label="Your returns" aria-busy={busy}>
		<h4>Your {order.symbol} return</h4>
		{reserved === 0n ? <p>Review the full return amount and your TBC receiving address.</p> : <p>Continue your saved return below.</p>}
		{reserved === 0n && <details className="bridge-flow-history" open={!visible.rows.length}><summary>Create a return order</summary>
			{!canPrepare && <p className="history-note">Connect your original TBC wallet and select the account holding {order.wrappedSymbol} in MetaMask on HyperEVM Testnet.</p>}
			<label htmlFor={`redeem-amount-${order.id}`}>{order.wrappedSymbol} amount</label><input id={`redeem-amount-${order.id}`} type="text" value={amount} readOnly disabled={!canPrepare} />
			<label htmlFor={`redeem-recipient-${order.id}`}>Receive {order.symbol} at this TBC address</label><input id={`redeem-recipient-${order.id}`} type="text" autoComplete="off" spellCheck={false} value={recipient} disabled={!canPrepare} onChange={(event) => { setRecipient(event.target.value); setReview(null); }} />
			<button type="button" disabled={!canPrepare || open.length >= 3} onClick={reviewTerms}>Review return</button>
			{reviewed && <div className="bridge-deployment-record"><h4>Review return</h4>
				<p>{formatRawAmount(reviewed.amountRaw, order.decimals)} {order.wrappedSymbol} → {formatRawAmount(reviewed.amountRaw, order.decimals)} {order.symbol}</p>
				<p>From: <code>{reviewed.holder}</code></p><p>Receive {order.symbol} at: <code>{reviewed.recipient}</code></p>
				<p>Lock contract: <code>{escrow.contractAddress}</code></p>
				<button type="button" disabled={!canPrepare} onClick={save}>Save return</button>
			</div>}
		</details>}
		<button type="button" className="history-secondary" disabled={!enabled || busy || working.current} onClick={() => setRevision((old) => old + 1)}>Refresh returns</button>
		{visible.loading && <p role="status">Loading your returns…</p>}
		{visible.notice && <p className="result success" role="status">{visible.notice}</p>}
		{visible.error && <p className="result error" role="alert">{visible.error}</p>}
		{visible.rows.map((row) => <article className="bridge-deployment-record" key={row.id}>
			<h4>{formatRawAmount(row.amountRaw, order.decimals)} {order.wrappedSymbol} → {order.symbol} · {row.status === 'cancelled' ? 'Closed' : 'Saved return'}</h4>
			<p>Receive {order.symbol} at: <code>{row.tbcRecipient}</code></p>
			<p className="history-note">Saved {formatDateTime(row.createdAt)} MYT</p>
			{row.status === 'prepared' && <>{!row.releaseStarted && <button type="button" className="history-secondary" disabled={!enabled || busy} onClick={() => { void run(async (signal) => { await cancelRedemption(order, row, signal); return 'Unused return closed. No tokens were moved.'; }); }}>Close unused return</button>}
				<RedemptionRelease order={order} row={row} escrow={escrow} evm={evm} enabled={enabled} context={context} onOpened={() => setRevision((old) => old + 1)} />
			</>}
		</article>)}
	</section>;
}
