import { useEffect, useId, useRef } from 'react';
import type { ReconciliationRequest } from '../../utils/bridgeReconciliation';
import { reconciliationAmount as amount, recordedRequestFees, requestStage, requestStatusLabels } from '../../utils/bridgeReconciliation';
import { formatDateTime } from '../../utils/dateTime';
import ReconciliationTransactions, { CopyReference } from './ReconciliationTransactions';

interface Props { request: ReconciliationRequest; onClose: () => void; onRelated: (key: string) => void }
export default function ReconciliationRequestDetails({ request, onClose, onRelated }: Props) {
	const dialog = useRef<HTMLDialogElement>(null);
	const title = useId();
	useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
	const fees = recordedRequestFees(request.transactions);
	const redemption = request.redemption;
	return <dialog ref={dialog} className="recon-request-dialog" aria-labelledby={title} onClose={onClose}>
		<header className="recon-dialog-header"><div><p className="eyebrow">{request.direction === 'forward' ? 'TBC → HYPEREVM' : 'HYPEREVM → TBC'}</p><h2 id={title}>Request details</h2></div><button type="button" className="history-secondary" autoFocus onClick={() => dialog.current?.close()}>Close</button></header>
		<div className="recon-dialog-body">
			<div className="recon-request-amount"><strong>{amount(request.amountRaw, request.route.decimals)} {request.direction === 'forward' ? `${request.route.symbol} → ${request.route.wrappedSymbol}` : `${request.route.wrappedSymbol} → ${request.route.symbol}`}</strong><span className={`recon-status recon-status-${request.category}`}>{requestStatusLabels[request.category]}</span></div>
			<p className="history-note">{requestStage(request.status)}</p>
			<dl className="history-detail-grid">
				<div><dt>Request ID</dt><dd><CopyReference value={request.id} label="request ID" /></dd></div>
				<div><dt>Created · MYT</dt><dd>{formatDateTime(request.createdAt)}</dd></div>
				<div><dt>Receiving wallet · {request.direction === 'forward' ? 'HyperEVM Testnet' : 'TBC Testnet'}</dt><dd><CopyReference value={request.recipient} label="receiving wallet" /></dd></div>
				<div><dt>Wrapped token contract</dt><dd><CopyReference value={request.route.wrappedToken} label="Wrapped token contract" /></dd></div>
				<div><dt>Recorded TBC fees</dt><dd>{fees.tbc === null ? 'Not recorded' : `${amount(fees.tbc.toString(), 6)} TBC`}</dd></div>
				<div><dt>Recorded HYPE fees</dt><dd>{fees.hyperevm === null ? 'Not recorded' : `${amount(fees.hyperevm.toString(), 18)} HYPE`}</dd></div>
			</dl>
			<p className="history-note">Fees cover this request’s recorded transactions. Contract setup fees are under Bridge balances. Missing fees are excluded.</p>
			{redemption && <section className="recon-return-details">
				<p>Related deposit: <button type="button" className="recon-text-button" onClick={() => onRelated(`forward:${request.order.id}`)}>{request.order.id}</button></p>
				{redemption.fundingRaw !== null && <p className="history-note">TBC fee payment: {amount(redemption.fundingRaw, 6)} TBC · Planned return fee: {amount(redemption.plannedReleaseFeeRaw!, 6)} TBC · Planned TBC remaining at the bridge: {amount(redemption.plannedNativeChangeRaw!, 6)} TBC, without an automatic refund.</p>}
			</section>}
			<ReconciliationTransactions rows={request.transactions} title="Transactions for this request" />
			<p className="history-note">Last saved status check: {request.checkedAt ? `${formatDateTime(request.checkedAt)} MYT` : 'Not recorded'}.</p>
		</div>
	</dialog>;
}
