import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import ReconciliationRequestDetails from '../components/bridge/ReconciliationRequestDetails';
import TestnetBridge from '../components/bridge/TestnetBridge';
import WalletConnection from '../components/WalletConnection';
import useBridgeReconciliation from '../hooks/useBridgeReconciliation';
import { loadBridgeOrderDraft } from '../services/bridgeOrders';
import type { BridgeOrderDraft } from '../types/learningBridge';
import type { WalletPageProps } from '../types/wallet';
import { reconciliationRequests, requestDirectionLabel, requestStatusLabel } from '../utils/bridgeReconciliation';
import { getErrorMessage } from '../utils/errors';

export default function BridgeTransferDetailsPage({ session }: WalletPageProps) {
	const { requestId } = useParams();
	const reconciliation = useBridgeReconciliation(session, true);
	const requests = useMemo(() => reconciliation.report ? reconciliationRequests(reconciliation.report) : [], [reconciliation.report]);
	const request = requests.find((item) => item.id === requestId) ?? null;
	const workflowId = request?.order?.id ?? request?.draft?.id ?? null;
	const returnAvailable = !!request?.order && request.direction === 'forward' && request.category === 'completed'
		&& !request.sepoliaReturn && request.order.redemptions.length === 0;
	const returnWorkflow = returnAvailable || !!request?.sepoliaReturn || !!request?.redemption;
	const workflowAvailable = request?.category === 'pending' || returnAvailable;
	const [draft, setDraft] = useState<BridgeOrderDraft | null>(null);
	const [workflowLoading, setWorkflowLoading] = useState(false);
	const [workflowError, setWorkflowError] = useState('');

	useEffect(() => {
		const controller = new AbortController();
		setDraft(null); setWorkflowError('');
		if (!workflowId || !workflowAvailable || !session.address || !session.networkIsDevnet || !session.backendAuth.ready) return () => controller.abort();
		setWorkflowLoading(true);
		void loadBridgeOrderDraft(workflowId, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
			.then((value) => { if (!controller.signal.aborted) setDraft(value); })
			.catch((cause) => { if (!controller.signal.aborted) setWorkflowError(getErrorMessage(cause)); })
			.finally(() => { if (!controller.signal.aborted) setWorkflowLoading(false); });
		return () => controller.abort();
	}, [session.address, session.backendAuth.ready, session.networkIsDevnet, workflowAvailable, workflowId]);

	if (!requestId) return <Navigate to="/bridge-lab?tab=reconciliation" replace />;
	const connected = !!session.address && session.networkIsDevnet && session.backendAuth.ready;
	return <section className="card history-card bridge-request-page">
		<header className="create-bridge-header bridge-request-header">
			<div>
				<p className="eyebrow">BRIDGE TRANSFER</p>
				<h1>{request ? requestDirectionLabel(request) : 'Transfer details'}</h1>
				<p className="intro">Review the saved route, progress, transactions, fees and return evidence in one place.</p>
				<p className="history-note">Request ID <code>{requestId}</code></p>
			</div>
			<div className="bridge-request-header-actions">
				{request && <span className={`recon-status recon-status-${request.category}`}>{requestStatusLabel(request)}</span>}
				<Link className="history-secondary create-bridge-back" to="/bridge-lab?tab=reconciliation">Back to Reconciliation</Link>
			</div>
		</header>
		{!connected && <><WalletConnection session={session} /><p>Connect the TBC Testnet wallet that owns this transfer.</p></>}
		{connected && reconciliation.loading && <p className="history-feedback" role="status">Loading transfer details…</p>}
		{reconciliation.error && <p className="result error" role="alert">{reconciliation.error}</p>}
		{connected && !reconciliation.loading && reconciliation.report && !request && <p className="result error" role="alert">This transfer was not found for the connected wallet.</p>}
		{request && <ReconciliationRequestDetails request={request} />}
		{workflowAvailable && <section id="transfer-progress" className="bridge-request-progress" aria-labelledby="transfer-progress-title">
			<header className="bridge-request-progress-heading"><div><p className="eyebrow">{returnWorkflow ? 'BURN-RETURN' : 'LIVE PROCEDURE'}</p><h2 id="transfer-progress-title">{returnWorkflow ? 'Return to TBC' : 'Transfer progress'}</h2></div><button type="button" className="history-secondary" onClick={reconciliation.refresh} disabled={reconciliation.loading}>Refresh progress</button></header>
			{workflowLoading && <p className="history-feedback" role="status">Loading saved progress…</p>}
			{workflowError && <p className="result error" role="alert">{workflowError}</p>}
			{draft?.status === 'cancelled' && <p className="result warning">This transfer was closed.</p>}
			{draft && draft.status !== 'cancelled' && <TestnetBridge session={session} active mode="workflow" draft={draft} initialDirection={returnWorkflow ? 'return' : undefined} />}
		</section>}
	</section>;
}
