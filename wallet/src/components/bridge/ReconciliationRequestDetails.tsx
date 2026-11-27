import { Link } from 'react-router-dom';
import type { ReconciliationRedemption, ReconciliationSepoliaReturn, ReconciliationTransaction } from '../../../../shared/src/types/bridgeReconciliation';
import type { ReconciliationRequest } from '../../utils/bridgeReconciliation';
import { reconciliationAmount as amount, recordedRequestFees, requestFlowLabel, requestStage, requestStageLabel, requestStatusLabel, routeDestinationName, routeFeeSymbol } from '../../utils/bridgeReconciliation';
import { formatDateTime } from '../../utils/dateTime';
import ReconciliationTransactions, { CopyReference } from './ReconciliationTransactions';

interface Props { request: ReconciliationRequest }
type ReturnLeg = { id: string; kind: 'burn' | 'refund'; amountRaw: string; recipient: string; holder: string; status: string; fundingRaw: string | null; transactions: ReconciliationTransaction[] };

function returnLeg(record: ReconciliationSepoliaReturn | ReconciliationRedemption): ReturnLeg {
	if ('holder' in record) return { id: record.id, kind: 'burn', amountRaw: record.amountRaw, recipient: record.recipient, holder: record.holder, status: record.status, fundingRaw: record.fundingRaw, transactions: record.transactions };
	return { id: record.id, kind: 'refund', amountRaw: record.amountRaw, recipient: record.recipient, holder: record.escrowAddress, status: record.status, fundingRaw: record.fundingRaw, transactions: record.transactions };
}

function RecordedFees({ rows, destinationFeeSymbol }: { rows: ReconciliationTransaction[]; destinationFeeSymbol: string }) {
	const fees = recordedRequestFees(rows);
	return <>
		<div><dt>Recorded TBC fee</dt><dd>{fees.tbc === null ? 'Not recorded' : `${amount(fees.tbc.toString(), 6)} TBC`}</dd></div>
		<div><dt>Recorded destination fee</dt><dd>{fees.hyperevm === null ? 'Not recorded' : `${amount(fees.hyperevm.toString(), 18)} ${destinationFeeSymbol}`}</dd></div>
	</>;
}

export default function ReconciliationRequestDetails({ request }: Props) {
	const fees = recordedRequestFees(request.transactions);
	const redemption = request.redemption;
	const sepoliaReturn = request.sepoliaReturn;
	const destinationName = routeDestinationName(request.route);
	const feeSymbol = routeFeeSymbol(request.route);
	const forward = request.order;
	const returns = sepoliaReturn ? [returnLeg(sepoliaReturn)] : redemption ? [returnLeg(redemption)] : (forward?.redemptions ?? []).map(returnLeg);
	return <section className="recon-request-details" aria-label="Request details">
		<div className="recon-detail-body">
			<div className="recon-request-amount"><strong>{request.amountRaw === null ? 'Amount not set' : amount(request.amountRaw, request.route.decimals)} · {requestFlowLabel(request)}</strong><span className={`recon-status recon-status-${request.category}`}>{requestStatusLabel(request)}</span></div>
			<p className="history-note">{requestStageLabel(request)}</p>
			<dl className="history-detail-grid">
				<div><dt>Request ID</dt><dd><CopyReference value={request.id} label="request ID" /></dd></div>
				<div><dt>Created · MYT</dt><dd>{formatDateTime(request.createdAt)}</dd></div>
				{request.recipient && <div><dt>Receiving wallet · {request.direction === 'forward' ? destinationName : 'TBC Testnet'}</dt><dd><CopyReference value={request.recipient} label="receiving wallet" /></dd></div>}
				<div><dt>Wrapped token contract</dt><dd><CopyReference value={request.route.wrappedToken} label="Wrapped token contract" /></dd></div>
				{sepoliaReturn && <div><dt>Return wallet · TBC Testnet</dt><dd><CopyReference value={sepoliaReturn.recipient} label="return wallet" /></dd></div>}
				<div><dt>Recorded TBC fees</dt><dd>{fees.tbc === null ? 'Not recorded' : `${amount(fees.tbc.toString(), 6)} TBC`}</dd></div>
				<div><dt>Recorded {feeSymbol} fees</dt><dd>{fees.hyperevm === null ? 'Not recorded' : `${amount(fees.hyperevm.toString(), 18)} ${feeSymbol}`}</dd></div>
			</dl>
			<p className="history-note">Fees cover this request’s recorded transactions. Contract setup fees are under Bridge balances. Missing fees are excluded.</p>
			{redemption && <section className="recon-return-details">
				<p>Related deposit: <Link className="recon-text-button" to={`/bridge-transfer/${request.order!.id}`}>{request.order!.id}</Link></p>
				{redemption.fundingRaw !== null && <p className="history-note">TBC fee payment: {amount(redemption.fundingRaw, 6)} TBC · Planned return fee: {amount(redemption.plannedReleaseFeeRaw!, 6)} TBC · Planned TBC remaining at the bridge: {amount(redemption.plannedNativeChangeRaw!, 6)} TBC, without an automatic refund.</p>}
			</section>}
			{sepoliaReturn && <section className="recon-return-details">
				<p><strong>Burn-return evidence</strong></p>
				<p className="history-note">The full {amount(sepoliaReturn.amountRaw, request.route.decimals)} {request.route.wrappedSymbol} was burned on Ethereum Sepolia before the matching {request.route.symbol} release was accepted on TBC Testnet.</p>
			</section>}
			{forward && <section className="recon-flow-leg" aria-labelledby={`forward-leg-${forward.id}`}>
				<header className="recon-flow-leg-header"><div><span className="recon-flow-number">1</span><div><p className="eyebrow">BRIDGE OUT</p><h3 id={`forward-leg-${forward.id}`}>{request.route.symbol} on TBC Testnet → {request.route.wrappedSymbol} on {destinationName}</h3></div></div><span className={`recon-status recon-status-${['completed', 'verified'].includes(forward.status) ? 'completed' : request.category}`}>{requestStage(forward.status)}</span></header>
				<dl className="history-detail-grid recon-flow-grid">
					<div><dt>Sent from TBC Testnet</dt><dd>{amount(forward.amountRaw, request.route.decimals)} {request.route.symbol}</dd></div>
					<div><dt>Received on {destinationName}</dt><dd>{amount(forward.amountRaw, request.route.decimals)} {request.route.wrappedSymbol}</dd></div>
					<div><dt>Source token ID</dt><dd><CopyReference value={request.route.contractId} label="source token ID" /></dd></div>
					<div><dt>Receiving wallet</dt><dd><CopyReference value={forward.recipient} label="receiving wallet" /></dd></div>
					<RecordedFees rows={forward.transactions} destinationFeeSymbol={feeSymbol} />
				</dl>
				<ReconciliationTransactions rows={forward.transactions} title="Bridge-out transactions" destinationName={destinationName} destinationFeeSymbol={feeSymbol} />
			</section>}
			{returns.map((leg, index) => <section className="recon-flow-leg recon-flow-leg-return" aria-labelledby={`return-leg-${leg.id}`} key={leg.id}>
				<header className="recon-flow-leg-header"><div><span className="recon-flow-number">{index + 2}</span><div><p className="eyebrow">{leg.kind === 'burn' ? 'BURN AND RETURN' : 'REFUND / RETURN'}</p><h3 id={`return-leg-${leg.id}`}>{request.route.wrappedSymbol} on {destinationName} → {request.route.symbol} on TBC Testnet</h3></div></div><span className={`recon-status recon-status-${['completed', 'verified'].includes(leg.status) ? 'completed' : request.category}`}>{requestStage(leg.status)}</span></header>
				<dl className="history-detail-grid recon-flow-grid">
					<div><dt>{leg.kind === 'burn' ? 'Burned' : 'Locked'} on {destinationName}</dt><dd>{amount(leg.amountRaw, request.route.decimals)} {request.route.wrappedSymbol}</dd></div>
					<div><dt>Released on TBC Testnet</dt><dd>{amount(leg.amountRaw, request.route.decimals)} {request.route.symbol}</dd></div>
					<div><dt>{leg.kind === 'burn' ? 'Wrapped-token holder' : 'Return escrow'}</dt><dd><CopyReference value={leg.holder} label={leg.kind === 'burn' ? 'wrapped-token holder' : 'return escrow'} /></dd></div>
					<div><dt>Return wallet</dt><dd><CopyReference value={leg.recipient} label="return wallet" /></dd></div>
					{leg.fundingRaw !== null && <div><dt>TBC fee funding</dt><dd>{amount(leg.fundingRaw, 6)} TBC</dd></div>}
					<RecordedFees rows={leg.transactions} destinationFeeSymbol={feeSymbol} />
				</dl>
				<ReconciliationTransactions rows={leg.transactions} title={leg.kind === 'burn' ? 'Burn-return transactions' : 'Refund transactions'} destinationName={destinationName} destinationFeeSymbol={feeSymbol} />
			</section>)}
			{!forward && request.transactions.length > 0 && <ReconciliationTransactions rows={request.transactions} title="Transactions for this request" destinationName={destinationName} destinationFeeSymbol={feeSymbol} />}
			<p className="history-note">Last saved status check: {request.checkedAt ? `${formatDateTime(request.checkedAt)} MYT` : 'Not recorded'}.</p>
		</div>
	</section>;
}
