import { useEffect, useState } from 'react';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { BridgeOrder, RedemptionEscrowActivationPreview, RedemptionEscrowActivationState, RedemptionEscrowActivationStatus, RedemptionEscrowDeployment, V15ActivationKind } from '../../../../shared/src/types/learningBridge';
import { checkEscrowActivation, getEscrowActivation, previewEscrowActivation, savedEscrowActivation, saveEscrowActivation, type SavedEscrowActivation } from '../../services/redemptionEscrowActivation';
import { formatHypeBalance } from '../../services/evmWallet';
import { getErrorMessage } from '../../utils/errors';

interface Props { order: BridgeOrder; escrow: RedemptionEscrowDeployment; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean; onActive: () => void }
export default function V15EscrowActivation({ order, escrow, evm, active, onActive }: Props) {
	const [state, setState] = useState<RedemptionEscrowActivationState | null>(null);
	const [saved, setSaved] = useState<SavedEscrowActivation | null>(() => savedEscrowActivation(escrow.id));
	const [preview, setPreview] = useState<RedemptionEscrowActivationPreview | null>(null);
	const [status, setStatus] = useState<RedemptionEscrowActivationStatus | null>(null);
	const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!active) return;
		const controller = new AbortController(); setBusy('state'); setError(''); setPreview(null);
		void (async () => { try {
			const next = await getEscrowActivation(order, escrow, controller.signal); if (controller.signal.aborted) return; setState(next);
			if (next.active) { saveEscrowActivation(escrow.id, null); setSaved(null); setStatus(null); onActive(); return; }
			const stored = savedEscrowActivation(escrow.id); setSaved(stored);
			if (stored) { const kind: V15ActivationKind = stored.approvalHash ? 'approve' : 'propose'; const txHash = stored.approvalHash ?? stored.proposalHash;
				setStatus(await checkEscrowActivation(order, escrow, kind, stored.actionId, txHash, controller.signal)); }
		} catch (cause) { if (!controller.signal.aborted) setError(getErrorMessage(cause)); } finally { if (!controller.signal.aborted) setBusy(''); } })();
		return () => controller.abort();
	}, [active, order.id, escrow.id, revision]);
	useEffect(() => { if (!active || !saved || !status || !['pending', 'confirming'].includes(status.status)) return; const timer = setTimeout(() => setRevision((value) => value + 1), 5000); return () => clearTimeout(timer); }, [active, saved, status]);
	useEffect(() => { if (status?.kind === 'approve' && status.status === 'verified' && !status.paused) setRevision((value) => value + 1); }, [status?.kind, status?.paused, status?.status]);
	async function prepare(kind: V15ActivationKind) { if (!state || busy) return; setBusy(`prepare:${kind}`); setError('');
		try { setPreview(await previewEscrowActivation(order, escrow, kind, saved?.actionId, AbortSignal.timeout(45_000))); } catch (cause) { setError(getErrorMessage(cause)); } finally { setBusy(''); } }
	async function send() { if (!preview || !state || busy) return; setBusy(`send:${preview.kind}`); setError('');
		try { const txHash = await evm.sendBridgeCall(preview.transaction); const next = preview.kind === 'propose' ? { actionId: preview.actionId, proposalHash: txHash } : { actionId: preview.actionId, proposalHash: saved!.proposalHash, approvalHash: txHash };
			saveEscrowActivation(escrow.id, next); setSaved(next); setPreview(null); setStatus(await checkEscrowActivation(order, escrow, preview.kind, preview.actionId, txHash, AbortSignal.timeout(45_000)));
		} catch (cause) { setError(getErrorMessage(cause)); } finally { setBusy(''); } }
	const proposalVerified = !!saved && status?.kind === 'propose' && status.status === 'verified'; const failed = status && ['reverted', 'invalid'].includes(status.status);
	const required = preview?.transaction.from ?? (proposalVerified ? state?.signer2 : state?.signer1); const accountMatches = !!required && evm.address?.toLowerCase() === required.toLowerCase(); const walletBusy = !!evm.pending || evm.loading;
	return <section className="htlc-section" aria-busy={!!busy}>
		<h4>One-time 2-of-2 return escrow activation</h4>
		{state?.active ? <p className="result success"><strong>Return escrow active.</strong> Continue with the exact token approval and permanent lock below.</p> : <>
			<p>Signer 1 proposes the escrow’s exact <code>unpause()</code> call. Signer 2 approves and executes it. The deployment payer and token holder receive no Admin authority.</p>
			{state && <dl className="history-detail-grid"><div><dt>Return escrow</dt><dd><code>{state.contractAddress}</code></dd></div><div><dt>Admin multisig</dt><dd><code>{state.admin}</code></dd></div><div><dt>Signer 1</dt><dd><code>{state.signer1}</code></dd></div><div><dt>Signer 2</dt><dd><code>{state.signer2}</code></dd></div></dl>}
			{busy === 'state' && <p role="status">Checking return escrow activation…</p>}
			{saved && status && <p className={status.status === 'verified' ? 'result success' : failed ? 'result error' : 'history-feedback'}><strong>{status.kind === 'propose' ? 'Proposal' : 'Approval'}: {status.status}.</strong> Confirmations {status.confirmations} / {status.confirmationsRequired}{status.actualFeeWei ? ` · Actual fee ${formatHypeBalance(status.actualFeeWei)} HYPE` : ''}{status.lastError ? ` · ${status.lastError}` : ''}</p>}
			{!saved && state && !preview && <button type="button" disabled={!!busy || walletBusy} onClick={() => { void prepare('propose'); }}>Prepare Signer 1 proposal</button>}
			{proposalVerified && !preview && <button type="button" disabled={!!busy || walletBusy} onClick={() => { void prepare('approve'); }}>Prepare Signer 2 approval</button>}
			{preview && <section className="htlc-section"><h4>{preview.kind === 'propose' ? 'Review Signer 1 proposal' : 'Review Signer 2 approval and execution'}</h4><p>Required account: <code>{preview.transaction.from}</code></p><p>Maximum reviewed gas budget: <strong>{formatHypeBalance(preview.bufferedFeeWei)} HYPE</strong></p>{!preview.sufficientBalance && <p className="result error">This signer needs more Testnet HYPE.</p>}{!accountMatches && <p className="history-feedback">Select the required signer in MetaMask, then refresh the wallet connection.</p>}<div className="htlc-actions"><button type="button" disabled={!!busy || walletBusy || !preview.sufficientBalance || !accountMatches || !evm.networkIsTestnet} onClick={() => { void send(); }}>Confirm {preview.kind} in MetaMask</button><button type="button" className="history-secondary" disabled={!!busy || walletBusy} onClick={() => setPreview(null)}>Cancel review</button></div></section>}
			{failed && <button type="button" className="history-secondary" disabled={!!busy} onClick={() => { saveEscrowActivation(escrow.id, null); setSaved(null); setStatus(null); setPreview(null); setRevision((value) => value + 1); }}>Clear failed activation and retry</button>}
			{required && !accountMatches && !preview && <p className="history-note">Next required MetaMask account: <code>{required}</code>.</p>}
			<div className="htlc-actions"><button type="button" className="history-secondary" disabled={!!busy || walletBusy} onClick={() => setRevision((value) => value + 1)}>Check activation now</button><button type="button" className="history-secondary" disabled={walletBusy} onClick={evm.refresh}>Refresh MetaMask account</button></div>
		</>}
		{error && <p className="result error" role="alert">{error}</p>}
	</section>;
}
