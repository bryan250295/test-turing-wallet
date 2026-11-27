import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import TestnetBridge from '../components/bridge/TestnetBridge';
import WalletConnection from '../components/WalletConnection';
import { loadBridgeOrderDraft } from '../services/bridgeOrders';
import type { BridgeOrderDraft } from '../types/learningBridge';
import type { WalletPageProps } from '../types/wallet';
import { getErrorMessage } from '../utils/errors';

export default function CreateBridgingOrderPage({ session }: WalletPageProps) {
	const { orderId } = useParams();
	const [draft, setDraft] = useState<BridgeOrderDraft | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	useEffect(() => {
		const controller = new AbortController();
		setDraft(null); setError('');
		if (!orderId || !session.address || !session.networkIsDevnet || !session.backendAuth.ready) return () => controller.abort();
		setLoading(true);
		void loadBridgeOrderDraft(orderId, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
			.then((value) => { if (!controller.signal.aborted) setDraft(value); })
			.catch((cause) => { if (!controller.signal.aborted) setError(getErrorMessage(cause)); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [orderId, session.address, session.backendAuth.ready, session.networkIsDevnet]);
	if (!orderId) return <Navigate to="/bridge-lab?tab=testnet-bridge" replace />;
	return <section className="card history-card create-bridge-page">
		<header className="create-bridge-header">
			<div>
				<p className="eyebrow">SAVED TRANSFER</p>
				<h1>Complete your bridge transfer</h1>
				<p className="intro">This procedure is saved under one transfer ID. You can close the page and continue it later from Reconciliation.</p>
				<p className="history-note">Transfer ID <code>{orderId}</code></p>
			</div>
			<Link className="history-secondary create-bridge-back" to="/bridge-lab?tab=reconciliation">View Reconciliation</Link>
		</header>
		{(!session.address || !session.networkIsDevnet || !session.backendAuth.ready) && <><WalletConnection session={session} /><p>Connect the TBC Testnet wallet that created this transfer.</p></>}
		{loading && <p className="history-feedback" role="status">Loading saved transfer…</p>}
		{error && <p className="result error" role="alert">{error}</p>}
		{draft?.status === 'cancelled' && <p className="result warning">This transfer was closed. Return to Transfer to start a new one.</p>}
		{draft && draft.status !== 'cancelled' && <TestnetBridge session={session} active mode="workflow" draft={draft} />}
	</section>;
}
