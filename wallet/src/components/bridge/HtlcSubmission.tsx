import { Link } from 'react-router-dom';
import type { SignedTokenHtlc, TokenHtlcBroadcast, UnsignedTokenHtlc } from '../../types/htlc';

interface BroadcastPanelProps {
	transaction: UnsignedTokenHtlc;
	signed: SignedTokenHtlc;
	receipt: TokenHtlcBroadcast | null;
	disabled: boolean;
	loading: boolean;
	onSubmit: (checkOnly: boolean) => void;
}

export default function HtlcSubmission({ transaction, signed, receipt, disabled, loading, onSubmit }: BroadcastPanelProps) {
	const action = transaction.action ?? 'lock';
	return <section className="htlc-section" aria-label={`${action} submission`} aria-busy={loading}>
		{signed.storageWarning && <p className="result error" role="alert">{signed.storageWarning}</p>}
		{!signed.feeSufficient && <p className="result error" role="alert">The fee is insufficient. Prepare a new transaction before submitting.</p>}
		{!receipt && <>
			<p role="status">Signed and verified. Ready to submit on TBC Testnet.</p>
			<button type="button" disabled={disabled || loading || !signed.feeSufficient} onClick={() => onSubmit(false)}>{loading ? 'Submitting…' : `Submit ${action}`}</button>
		</>}
		{receipt && <>
			<div className={`result ${receipt.status === 'submitted' ? 'success' : receipt.status === 'rejected' ? 'error' : ''}`} role="status"><strong>{receipt.status === 'submitted' ? 'Submitted · awaiting confirmation' : receipt.status === 'rejected' ? 'Submission rejected' : 'Submission status unknown'}</strong><p>{receipt.message}</p></div>
			<p className="selected-contract">TXID: <Link to={`/transaction?txid=${receipt.txid}`}><code>{receipt.txid}</code></Link></p>
			{receipt.status !== 'submitted' && <button type="button" disabled={disabled || loading} onClick={() => onSubmit(true)}>{loading ? 'Checking…' : 'Check submission status'}</button>}
			<p className="history-note">Request history is saved automatically. Check confirmations in My HTLC Requests.</p>
		</>}
	</section>;
}
