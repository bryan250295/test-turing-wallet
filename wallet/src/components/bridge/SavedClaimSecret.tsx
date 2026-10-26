import { useId, useState } from 'react';
import type { WalletSession } from '../../types/wallet';
import useSavedClaimSecret from '../../hooks/useSavedClaimSecret';

export default function SavedClaimSecret({ session, owner, lockTxid }: { session: WalletSession; owner: string; lockTxid: string }) {
	const id = useId();
	const state = useSavedClaimSecret(session, owner, lockTxid);
	const [show, setShow] = useState(false);
	const [message, setMessage] = useState('');
	if (session.address !== owner) return null;

	return <div className="saved-claim-secret">
		{!state.secret && <button type="button" className="history-secondary" disabled={!state.ready || session.busy || state.loading} onClick={() => { setShow(false); setMessage(''); void state.retrieve(); }}>{state.loading ? 'Verify in wallet…' : 'Retrieve claim secret'}</button>}
		{state.secret && <>
			<label htmlFor={id}>Saved claim secret</label>
			<div className="htlc-secret-field"><input id={id} value={state.secret} type={show ? 'text' : 'password'} readOnly autoComplete="off" spellCheck={false} /><button type="button" aria-pressed={show} onClick={() => setShow((value) => !value)}>{show ? 'Hide' : 'Show'}</button><button type="button" onClick={async () => {
				try { await navigator.clipboard.writeText(state.secret); setMessage('Secret copied. Share it with the recipient only when you intend to allow the claim.'); }
				catch { setMessage('Copy unavailable. Use Show to copy the secret manually.'); }
			}}>Copy</button><button type="button" className="history-secondary" onClick={() => { state.clear(); setShow(false); setMessage(''); }}>Close</button></div>
		</>}
		{state.loading && <p className="history-note">Sign the ownership message in your sender wallet. This sends no transaction.</p>}
		{state.error && <p className="amount-error" role="alert">{state.error}</p>}
		{message && state.secret && <p className="history-note" role="status">{message}</p>}
	</div>;
}
