import { useState } from 'react';
import type { WalletPageProps } from '../../types/wallet';
import useHtlcTokenLock from '../../hooks/useHtlcTokenLock';
import useHtlcSecret from '../../hooks/useHtlcSecret';
import { formatTokenBalance, getTransferPreview } from '../../utils/tokenAmounts';
import RefundDateTimePicker from './RefundDateTimePicker';
import TokenLockReview from './TokenLockReview';
import RecipientAddressInput from '../RecipientAddressInput';

export default function HtlcTokenLock({ session, onViewRequests }: WalletPageProps & { onViewRequests: () => void }) {
	const [contractId, setContractId] = useState('');
	const [receiver, setReceiver] = useState('');
	const [amount, setAmount] = useState('');
	const [refundTime, setRefundTime] = useState('');
	const [showSecret, setShowSecret] = useState(false);
	const [copyStatus, setCopyStatus] = useState('');
	const secret = useHtlcSecret();
	const state = useHtlcTokenLock(session);
	const token = state.tokens.find((item) => item.contract_id === contractId);
	const preview = getTransferPreview(token, amount);
	const loading = state.loading || secret.busy;
	const canEdit = state.ready && !session.busy && !loading;

	function edit() {
		state.reset();
		secret.clear();
		setShowSecret(false);
		setCopyStatus('');
	}

	return <section className="htlc-section" aria-labelledby="htlc-token-lock" aria-busy={loading}>
		<h3 id="htlc-token-lock">{state.unsigned ? 'Review token lock' : 'Create a token lock'}</h3>
		{!state.unsigned && <form onSubmit={async (event) => {
			event.preventDefault();
			if (!canEdit) return;
			const pair = await secret.generate();
			if (pair) await state.prepare({ sender: session.address, receiver: receiver.trim(), contractId, amount: amount.trim(), hashHex: pair.hashHex, refundTime });
		}}>
			<p className="field-label" id="htlc-token-label">Token</p>
			<details className="token-picker" onToggle={(event) => { if (event.currentTarget.open && canEdit) void state.loadTokens(); }}>
				<summary aria-labelledby="htlc-token-label" aria-disabled={!canEdit} onClick={(event) => { if (!canEdit) event.preventDefault(); }}>{token ? `${token.name || 'Unnamed token'} · ${formatTokenBalance(token)} ${token.symbol || 'FT'} · Decimals: ${token.decimal ?? 'Unknown'}` : 'Choose an FT token'}</summary>
				<div className="token-options" aria-live="polite">
					{state.loading ? <p>Loading tokens…</p> : state.tokens.length ? state.tokens.map((item) => <button type="button" key={item.contract_id} disabled={!canEdit} onClick={(event) => {
						setContractId(item.contract_id); setAmount(''); state.reset();
						const picker = event.currentTarget.closest('details'); if (picker) picker.open = false;
					}}>{item.name || 'Unnamed token'} · {formatTokenBalance(item)} {item.symbol || 'FT'} · Decimals: {item.decimal ?? 'Unknown'} · {item.contract_id.slice(0, 8)}…{item.contract_id.slice(-6)}</button>) : <p>{state.error ? 'Close and reopen to retry loading tokens.' : 'No FT tokens found.'}</p>}
				</div>
			</details>
			{token && <p className="selected-contract">Balance: {formatTokenBalance(token)} {token.symbol} · Decimals: {token.decimal ?? 'Unknown'}<br /><small>Contract: <code>{token.contract_id}</code></small></p>}
			<RecipientAddressInput id="htlc-receiver" owner={session.address} value={receiver} disabled={!canEdit} onChange={setReceiver} />
			<label htmlFor="htlc-lock-amount" className="amount-label"><span>Amount {token?.symbol ? `(${token.symbol})` : ''}</span>{token && <span className="amount-available" aria-live="polite">Available {preview.remaining} {token.symbol}</span>}</label>
			<input id="htlc-lock-amount" value={amount} disabled={!canEdit || !token} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="Enter token amount" aria-invalid={!!preview.error} aria-describedby={preview.error ? 'htlc-amount-error' : undefined} required />
			{preview.error && <p id="htlc-amount-error" className="amount-error" role="status">{preview.error}</p>}
			<RefundDateTimePicker disabled={!canEdit} initialValue={refundTime} onChange={setRefundTime} />
			<button type="submit" disabled={!canEdit || !token || !preview.valid || !receiver.trim() || !refundTime}>{loading ? 'Preparing lock…' : 'Review lock'}</button>
		</form>}
		{loading && !state.unsigned && <p role="status">Checking funds and calculating the transaction fee…</p>}
		{!state.ready && <p className="history-feedback">Connect your wallet on TBC Testnet to create a lock.</p>}
		{(state.error || secret.error) && <p className="result error" role="alert">{state.error || secret.error}</p>}
		{state.unsigned && secret.pair && <>
			{!state.broadcast && <button type="button" className="history-secondary" disabled={!canEdit} onClick={edit}>Edit details</button>}
			<section className="htlc-secret-backup" aria-labelledby="htlc-backup-title">
				<h4 id="htlc-backup-title">Claim secret</h4>
				<p>{state.signed?.secretStored ? 'Saved encrypted on this app server. You can retrieve it later from My HTLC Requests using the sender wallet.' : 'This secret will be saved on this app server when you sign the lock. The recipient needs it to claim.'}</p>
				<label htmlFor="htlc-secret">Claim secret</label>
				<div className="htlc-secret-field"><input id="htlc-secret" type={showSecret ? 'text' : 'password'} value={secret.pair.secretHex} readOnly autoComplete="off" spellCheck={false} /><button type="button" aria-pressed={showSecret} onClick={() => setShowSecret((value) => !value)}>{showSecret ? 'Hide' : 'Show'}</button><button type="button" onClick={async () => {
					try { await navigator.clipboard.writeText(secret.pair!.secretHex); setCopyStatus('Secret copied. Store it privately.'); }
					catch { setCopyStatus('Copy unavailable. Use Show to save the secret manually.'); }
				}}>Copy</button></div>
				{copyStatus && <p role="status">{copyStatus}</p>}
			</section>
			<TokenLockReview key={state.unsigned.buildId} transaction={state.unsigned} signed={state.signed} disabled={!canEdit} loading={state.loading} onSign={() => void state.signUnsigned(secret.pair!.secretHex)} receipt={state.broadcast} onSubmit={(checkOnly) => void state.submitSigned(checkOnly)} />
			{state.broadcast && <div className="htlc-actions"><button type="button" className="history-secondary" onClick={onViewRequests}>View my requests</button>{state.broadcast.status === 'submitted' && <button type="button" disabled={!canEdit} onClick={edit}>Create another lock</button>}</div>}
		</>}
	</section>;
}
