import { useEffect, useState } from 'react';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { BridgeDeploymentRecord, V15ActivationKind, V15ActivationPreview, V15ActivationState, V15ActivationStatus } from '../../types/learningBridge';
import { checkV15Activation, getV15ActivationState, previewV15Activation, savedV15Activation, saveV15Activation, type SavedV15Activation } from '../../services/v15Activation';
import { formatHypeBalance } from '../../services/evmWallet';
import { getErrorMessage } from '../../utils/errors';

export default function V15RouteActivation({ row, evm, active }: { row: BridgeDeploymentRecord; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean }) {
	const [state, setState] = useState<V15ActivationState | null>(null);
	const [saved, setSaved] = useState<SavedV15Activation | null>(() => savedV15Activation(row.id));
	const [preview, setPreview] = useState<V15ActivationPreview | null>(null);
	const [status, setStatus] = useState<V15ActivationStatus | null>(null);
	const [busy, setBusy] = useState('');
	const [error, setError] = useState('');
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		setBusy('state'); setError(''); setPreview(null);
		void (async () => {
			try {
				const next = await getV15ActivationState(row, controller.signal);
				if (controller.signal.aborted) return;
				setState(next);
				if (next.active) { saveV15Activation(row.id, null); setSaved(null); setStatus(null); return; }
				const stored = savedV15Activation(row.id);
				setSaved(stored);
				if (stored) {
					const kind: V15ActivationKind = stored.approvalHash ? 'approve' : 'propose';
					const hash = stored.approvalHash ?? stored.proposalHash;
					setStatus(await checkV15Activation(row, kind, stored.actionId, hash, controller.signal));
				}
			} catch (cause) { if (!controller.signal.aborted) setError(getErrorMessage(cause)); }
			finally { if (!controller.signal.aborted) setBusy(''); }
		})();
		return () => controller.abort();
	}, [active, row.id, revision]);

	useEffect(() => {
		if (!active || !saved || !status || !['pending', 'confirming'].includes(status.status)) return;
		const timer = setTimeout(() => setRevision((value) => value + 1), 5000);
		return () => clearTimeout(timer);
	}, [active, saved, status]);

	useEffect(() => {
		if (status?.kind === 'approve' && status.status === 'verified' && !status.paused) {
			setRevision((value) => value + 1);
		}
	}, [status?.kind, status?.paused, status?.status]);

	async function prepare(kind: V15ActivationKind) {
		if (!state || busy) return;
		setBusy(`prepare:${kind}`); setError('');
		try { setPreview(await previewV15Activation(row, state, kind, saved?.actionId, AbortSignal.timeout(45_000))); }
		catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(''); }
	}

	async function send() {
		if (!preview || !state || busy) return;
		setBusy(`send:${preview.kind}`); setError('');
		try {
			const txHash = await evm.sendBridgeCall(preview.transaction);
			const next = preview.kind === 'propose'
				? { actionId: preview.actionId, proposalHash: txHash }
				: { actionId: preview.actionId, proposalHash: saved!.proposalHash, approvalHash: txHash };
			saveV15Activation(row.id, next); setSaved(next); setPreview(null);
			setStatus(await checkV15Activation(row, preview.kind, preview.actionId, txHash, AbortSignal.timeout(45_000)));
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(''); }
	}

	const proposalVerified = saved && status?.kind === 'propose' && status.status === 'verified';
	const failed = status && ['reverted', 'invalid'].includes(status.status);
	const requiredAccount = preview?.transaction.from ?? (proposalVerified ? state?.signer2 : state?.signer1);
	const accountMatches = !!requiredAccount && evm.address?.toLowerCase() === requiredAccount.toLowerCase();
	const walletBusy = !!evm.pending || evm.loading;

	return <section className="htlc-section" aria-labelledby={`v15-activation-${row.id}`} aria-busy={!!busy}>
		<h4 id={`v15-activation-${row.id}`}>One-time 2-of-2 route activation</h4>
		{state?.active ? <p className="result success"><strong>Route active.</strong> The wrapped contract is unpaused and can accept verified mint instructions.</p> : <>
			<p>The wrapped token starts paused. Signer 1 proposes the exact <code>unpause()</code> call; Signer 2 approves and executes that same action. Neither signer receives mint authority.</p>
			{state && <dl className="history-detail-grid">
				<div><dt>Wrapped token</dt><dd><code>{state.contractAddress}</code></dd></div>
				<div><dt>Admin multisig</dt><dd><code>{state.admin}</code></dd></div>
				<div><dt>Step 1 · Signer 1</dt><dd><code>{state.signer1}</code></dd></div>
				<div><dt>Step 2 · Signer 2</dt><dd><code>{state.signer2}</code></dd></div>
			</dl>}
			{busy === 'state' && <p role="status">Checking activation state…</p>}
			{saved && status && <p className={status.status === 'verified' ? 'result success' : failed ? 'result error' : 'history-feedback'}>
				<strong>{status.kind === 'propose' ? 'Proposal' : 'Approval'}: {status.status}.</strong> Confirmations {status.confirmations} / {status.confirmationsRequired}{status.actualFeeWei ? ` · Actual fee ${formatHypeBalance(status.actualFeeWei)} HYPE` : ''}{status.lastError ? ` · ${status.lastError}` : ''}
			</p>}
			{!saved && state && !preview && <button type="button" disabled={!!busy || walletBusy} onClick={() => { void prepare('propose'); }}>Prepare Signer 1 proposal</button>}
			{proposalVerified && !preview && <button type="button" disabled={!!busy || walletBusy} onClick={() => { void prepare('approve'); }}>Prepare Signer 2 approval</button>}
			{preview && <section className="htlc-section">
				<h4>{preview.kind === 'propose' ? 'Review Signer 1 proposal' : 'Review Signer 2 approval and execution'}</h4>
				<p>Required account: <code>{preview.transaction.from}</code></p>
				<p>Maximum reviewed gas budget: <strong>{formatHypeBalance(preview.bufferedFeeWei)} HYPE</strong></p>
				{!preview.sufficientBalance && <p className="result error">This signer needs more Testnet HYPE before continuing.</p>}
				{!accountMatches && <p className="history-feedback">Select the required signer account in MetaMask, then refresh the wallet connection.</p>}
				<div className="htlc-actions"><button type="button" disabled={!!busy || walletBusy || !preview.sufficientBalance || !accountMatches || !evm.networkIsTestnet} onClick={() => { void send(); }}>Confirm {preview.kind} in MetaMask</button><button type="button" className="history-secondary" disabled={!!busy || walletBusy} onClick={() => setPreview(null)}>Cancel review</button></div>
			</section>}
			{failed && <button type="button" className="history-secondary" disabled={!!busy} onClick={() => { saveV15Activation(row.id, null); setSaved(null); setStatus(null); setPreview(null); setRevision((value) => value + 1); }}>Clear failed activation and retry</button>}
			{requiredAccount && !accountMatches && !preview && <p className="history-note">Next required MetaMask account: <code>{requiredAccount}</code>.</p>}
			<div className="htlc-actions"><button type="button" className="history-secondary" disabled={!!busy || walletBusy} onClick={() => setRevision((value) => value + 1)}>Check activation now</button><button type="button" className="history-secondary" disabled={walletBusy} onClick={evm.refresh}>Refresh MetaMask account</button></div>
		</>}
		{error && <p className="result error" role="alert">{error}</p>}
	</section>;
}
