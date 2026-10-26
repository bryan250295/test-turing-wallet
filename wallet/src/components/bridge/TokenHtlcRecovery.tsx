import { useEffect, useRef, useState } from 'react';
import type { WalletPageProps } from '../../types/wallet';
import type { HtlcRecoveryTarget } from '../../types/htlc';
import { formatRawAmount } from '../../utils/tokenAmounts';
import useHtlcRequests from '../../hooks/useHtlcRequests';
import useTokenHtlcRecovery from '../../hooks/useTokenHtlcRecovery';
import HtlcSubmission from './HtlcSubmission';
import { canRecoverHtlc, htlcRequestStatus } from '../../utils/htlcRequestHistory';
import SavedClaimSecret from './SavedClaimSecret';

export default function TokenHtlcRecovery({ session, recoveryTarget, active }: WalletPageProps & { recoveryTarget?: HtlcRecoveryTarget; active: boolean }) {
	const section = useRef<HTMLElement>(null);
	const [lockTxid, setLockTxid] = useState('');
	const [contractId, setContractId] = useState('');
	const [secret, setSecret] = useState('');
	const [showSecret, setShowSecret] = useState(false);
	const [revealConfirmed, setRevealConfirmed] = useState(false);
	const history = useHtlcRequests(session, active);
	const state = useTokenHtlcRecovery(session);
	const { lock, unsigned, signed, receipt } = state;
	const canAct = state.ready && !session.busy && !state.loading;
	const available = canRecoverHtlc(lock ?? undefined);
	const requests = history.requests.filter((item) => item.sender === session.address || item.receiver === session.address)
		.sort((a, b) => Number(b.submission === 'submitted') - Number(a.submission === 'submitted') || b.createdAt.localeCompare(a.createdAt));
	const selected = requests.find((item) => item.lockTxid === lockTxid);
	const tbc = (raw: string) => `${formatRawAmount(raw, 6)} TBC`;

	function clearTransaction() {
		state.reset(); setSecret(''); setShowSecret(false); setRevealConfirmed(false);
	}

	useEffect(() => {
		if (!recoveryTarget) return;
		clearTransaction();
		setLockTxid(recoveryTarget.lockTxid); setContractId(recoveryTarget.contractId);
	}, [recoveryTarget]);
	useEffect(() => {
		if (active && recoveryTarget) {
			section.current?.scrollIntoView({ block: 'start' });
			section.current?.focus({ preventScroll: true });
		}
	}, [active, recoveryTarget]);

	return <section ref={section} tabIndex={-1} className="htlc-section" aria-labelledby="htlc-recovery-title" aria-busy={state.loading}>
		<h3 id="htlc-recovery-title">Claim or refund tokens</h3>
		<label htmlFor="htlc-saved-request">Saved request</label>
		<select id="htlc-saved-request" value={requests.some((item) => item.lockTxid === lockTxid) ? lockTxid : ''} disabled={!canAct || history.loading} onChange={(event) => {
			const item = requests.find((entry) => entry.lockTxid === event.target.value);
			if (item && (!canRecoverHtlc(history.observations[item.lockTxid]?.lock) || history.observations[item.lockTxid]?.error)) return;
			clearTransaction();
			setLockTxid(item?.lockTxid ?? ''); setContractId(item?.contractId ?? '');
			if (item) void state.load(item.lockTxid, item.contractId);
		}}><option value="">Choose a token lock</option>{requests.map((item) => {
			const observation = history.observations[item.lockTxid];
			const disabled = !canRecoverHtlc(observation?.lock) || !!observation?.error;
			const status = observation?.error ? 'Status unavailable' : observation?.lock ? htlcRequestStatus(item, observation.lock) : history.loading ? 'Loading…' : 'Check status first';
			return <option key={item.lockTxid} value={item.lockTxid} disabled={disabled}>{item.tokenName || 'Unknown token'} ({item.symbol}) · {formatRawAmount(item.amountRaw, item.decimals)} · Contract {item.contractId.slice(0, 8)}… · {status} · {item.lockTxid.slice(0, 10)}…</option>;
		})}</select>
		{history.loading && <p className="history-note" role="status">Loading requests and chain status…</p>}
		<p className="history-note">The server checks saved locks when this list loads. Select an available lock to continue. Completed locks remain disabled.</p>
		{history.error && <p className="result error" role="alert">{history.error}</p>}
		{requests.length > 0 && !history.loading && <button type="button" className="history-secondary" disabled={!canAct} onClick={() => void history.refresh()}>Refresh requests</button>}
		{selected && selected.submission !== 'submitted' && !lock && <p className="history-note">No successful submission is recorded for this entry. Loading checks Testnet availability. A saved signed file alone does not establish an on-chain token lock.</p>}
		{!requests.length && <p className="history-note">No saved requests for this wallet. Add an existing request in My HTLC Requests, or enter its IDs below.</p>}
		<details className="htlc-raw-preview"><summary>Find a request by transaction ID</summary>
			<form id="htlc-request-lookup" onSubmit={(event) => { event.preventDefault(); void state.load(lockTxid, contractId); }}>
				<label htmlFor="htlc-recovery-txid">Original lock TXID</label><input id="htlc-recovery-txid" value={lockTxid} disabled={!canAct} onChange={(event) => { setLockTxid(event.target.value); clearTransaction(); }} autoComplete="off" spellCheck={false} pattern="[0-9a-fA-F]{64}" required />
				<label htmlFor="htlc-recovery-contract">Token contract ID</label><input id="htlc-recovery-contract" value={contractId} disabled={!canAct} onChange={(event) => { setContractId(event.target.value); clearTransaction(); }} autoComplete="off" spellCheck={false} pattern="[0-9a-fA-F]{64}" required />
			</form>
		</details>
		{lockTxid && contractId && <button type="submit" form="htlc-request-lookup" disabled={!canAct}>{state.loading ? 'Loading…' : lock ? 'Refresh request' : 'Load request'}</button>}
		{!state.ready && <p className="history-feedback">Connect your wallet on TBC Testnet to continue.</p>}
		{state.error && <p className="result error" role="alert">{state.error}</p>}
		{lock && <>
			<dl className="history-detail-grid">
				<div><dt>Token</dt><dd>{lock.name || selected?.tokenName || 'Unknown token'} ({lock.symbol})<small className="inquiry-chain">Contract: <code>{lock.contractId}</code></small></dd></div>
				<div><dt>Locked tokens</dt><dd>{formatRawAmount(lock.amountRaw, lock.decimals)} {lock.symbol}</dd></div>
				<div><dt>Status</dt><dd>{!lock.controlUnspent || !lock.tokenUnspent ? 'Spent / unavailable' : lock.confirmations > 0 ? 'Locked' : 'Awaiting confirmation'}</dd></div>
				<div><dt>Recipient</dt><dd><code>{lock.receiver}</code></dd></div>
				<div><dt>Refund address</dt><dd><code>{lock.sender}</code></dd></div>
				<div><dt>Refund eligible after</dt><dd>{new Date(lock.refundTimestamp * 1000).toLocaleString()}<br />{lock.refundEligible ? 'Refund time reached on Testnet' : 'Waiting for Testnet chain time'}</dd></div>
			</dl>
			<details className="htlc-raw-preview"><summary>More details</summary><p>Testnet median time: {new Date(lock.chainMedianTime * 1000).toLocaleString()}<br />Checked: {new Date(lock.checkedAt).toLocaleString()}<br />Confirmations: {lock.confirmations}</p><p>Hashlock: <code>{lock.hashHex}</code></p></details>
			<SavedClaimSecret session={session} owner={lock.sender} lockTxid={lock.lockTxid} />
			{!available && <p className="history-feedback">The lock must be confirmed and unspent. Check its latest status before continuing.</p>}
			{available && !unsigned && <>
				{session.address !== lock.sender && session.address !== lock.receiver && <p>Switch to the recipient’s wallet to claim, or the refund wallet to refund.</p>}
				<div className="htlc-actions">
					{session.address === lock.receiver && <button type="button" disabled={!canAct} onClick={() => { setSecret(''); setRevealConfirmed(false); void state.build('claim'); }}>Review claim</button>}
					{session.address === lock.sender && <button type="button" disabled={!canAct || !lock.refundEligible} onClick={() => { setSecret(''); void state.build('refund'); }}>Review refund</button>}
				</div>
			</>}
		</>}
		{unsigned && <section className="htlc-section" aria-labelledby="htlc-recovery-review">
			<h4 id="htlc-recovery-review">{unsigned.action === 'claim' ? 'Claim tokens' : 'Refund tokens'}</h4>
			<dl className="history-detail-grid">
				<div><dt>Token</dt><dd>{unsigned.plan.tokenName || 'Unknown token'} ({unsigned.plan.symbol})</dd></div>
				<div><dt>Amount</dt><dd>{formatRawAmount(unsigned.plan.amountRaw, unsigned.plan.decimals)} {unsigned.plan.symbol}</dd></div>
				<div><dt>Receive at</dt><dd><code>{unsigned.signerAddress}</code></dd></div>
				<div><dt>Transaction fee</dt><dd>{tbc(unsigned.feeRaw)}</dd></div>
			</dl>
			{!signed && <>
				{unsigned.action === 'claim' && <>
					<label htmlFor="htlc-claim-secret">Claim secret</label>
					<div className="htlc-secret-field"><input id="htlc-claim-secret" type={showSecret ? 'text' : 'password'} value={secret} disabled={!canAct} onChange={(event) => setSecret(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the original 64-character secret" /><button type="button" aria-pressed={showSecret} onClick={() => setShowSecret((value) => !value)}>{showSecret ? 'Hide' : 'Show'}</button></div>
					<label className="htlc-secret-confirmation"><input type="checkbox" checked={revealConfirmed} disabled={!canAct} onChange={(event) => setRevealConfirmed(event.target.checked)} /><span>I understand that submitting a claim makes this secret public.</span></label>
				</>}
				<button type="button" disabled={!canAct || (unsigned.action === 'claim' && (!/^[0-9a-f]{64}$/i.test(secret.trim()) || !revealConfirmed))} onClick={async () => { await state.sign(secret.trim()); setSecret(''); setShowSecret(false); }}>{state.loading ? 'Waiting for wallet…' : 'Sign with wallet'}</button>
			</>}
			{signed && <HtlcSubmission transaction={unsigned} signed={signed} receipt={receipt} disabled={!state.ready || session.busy} loading={state.loading} onSubmit={(checkOnly) => void state.submit(checkOnly)} />}
		</section>}
	</section>;
}
