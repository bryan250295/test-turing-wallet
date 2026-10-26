import { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { WalletSession } from '../../types/wallet';
import type { TokenHtlcLock } from '../../types/htlc';
import type { HtlcRequest } from '../../services/htlcRequestHistory';
import { formatHtlcDate, htlcRequestStatus, isCompletedHtlc } from '../../utils/htlcRequestHistory';
import { formatRawAmount } from '../../utils/tokenAmounts';
import { formatFeeTbc } from '../../utils/transactions';
import SavedClaimSecret from './SavedClaimSecret';

interface Props {
	item: HtlcRequest;
	lock?: TokenHtlcLock;
	error?: string;
	session: WalletSession;
	onClose: () => void;
}

export default function HtlcRequestDetails({ item, lock, error, session, onClose }: Props) {
	const dialog = useRef<HTMLDialogElement>(null);
	const title = useId();
	useEffect(() => {
		const element = dialog.current;
		if (element && !element.open) element.showModal();
	}, []);
	const transactions = new Map(item.recoveries.map((entry) => [entry.txid, entry]));
	if (lock?.recovery && !transactions.has(lock.recovery.txid)) transactions.set(lock.recovery.txid, { ...lock.recovery, submission: 'submitted' });
	const role = item.sender === session.address && item.receiver === session.address ? 'Sender A / Recipient B' : item.sender === session.address ? 'Sender A' : 'Recipient B';
	const fee = (value?: string) => value === undefined ? 'Unavailable' : formatFeeTbc(value);
	const completed = isCompletedHtlc(lock, error);

	return <dialog ref={dialog} className="htlc-details-dialog" aria-labelledby={title} onClose={onClose}>
		<div className="htlc-details-heading"><div><p className="eyebrow">TBC TESTNET</p><h3 id={title}>Token lock details</h3></div><button type="button" className="history-secondary" autoFocus aria-label="Close token lock details" onClick={() => dialog.current?.close()}>Close ×</button></div>
		<div className="htlc-details-body">
			{error && <p className="result error" role="alert">Status check failed: {error}. Any prior result below is from the last successful check.</p>}
			<dl className="history-detail-grid">
				<div><dt>Token</dt><dd>{lock?.name || item.tokenName || 'Unknown token'} ({lock?.symbol ?? item.symbol})</dd></div>
				<div><dt>Locked amount</dt><dd>{formatRawAmount(lock?.amountRaw ?? item.amountRaw, lock?.decimals ?? item.decimals)} {lock?.symbol ?? item.symbol}</dd></div>
				<div><dt>Status{error ? ' · previous result' : ''}</dt><dd>{htlcRequestStatus(item, lock)}</dd></div>
				<div><dt>Your role</dt><dd>{role}</dd></div>
				<div><dt>Token contract ID</dt><dd><code>{item.contractId}</code></dd></div>
				<div><dt>Decimals</dt><dd>{lock?.decimals ?? item.decimals}</dd></div>
				<div><dt>Sender / refund address (A)</dt><dd><code>{item.sender}</code></dd></div>
				<div><dt>Claim recipient (B)</dt><dd><code>{item.receiver}</code></dd></div>
				<div><dt>Refund eligible after · MYT</dt><dd>{formatHtlcDate(item.refundTimestamp)}<small className="inquiry-chain">{completed ? 'Completed' : error || !lock ? 'Eligibility not verified' : !lock.controlUnspent || !lock.tokenUnspent || lock.recovery ? 'Lock no longer available' : lock.refundEligible ? 'Eligible by chain time; not an automatic refund' : 'Waiting for Testnet chain time'}</small></dd></div>
				<div><dt>Last checked · MYT</dt><dd>{lock ? formatHtlcDate(lock.checkedAt) : 'Not checked'}</dd></div>
				<div><dt>Lock confirmations</dt><dd>{lock?.confirmations ?? 'Not checked'}</dd></div>
				<div><dt>Testnet median time · MYT</dt><dd>{lock ? formatHtlcDate(lock.chainMedianTime) : 'Not checked'}</dd></div>
				<div><dt>Public hashlock</dt><dd><code>{lock?.hashHex ?? 'Unavailable'}</code></dd></div>
				<div><dt>Lock transaction fee</dt><dd>{fee(lock?.feeRaw)}</dd></div>
			</dl>
			<h4>Related transactions</h4>
			<ul className="htlc-related-transactions">
				<li><strong>Lock</strong><Link to={`/transaction?txid=${item.lockTxid}`}><code>{item.lockTxid}</code></Link><span>{lock ? `${lock.confirmations} confirmations` : 'Confirmation status not checked'}</span></li>
				{[...transactions.values()].map((entry) => {
					const verified = lock?.recovery?.txid === entry.txid ? lock.recovery : undefined;
					return <li key={entry.txid}><strong>{entry.action === 'claim' ? 'Claim' : 'Refund'}</strong><Link to={`/transaction?txid=${entry.txid}`}><code>{entry.txid}</code></Link><span>{verified ? `${verified.confirmations} confirmations${error ? ' · previous result' : ''}` : entry.submission === 'rejected' ? 'Submission rejected' : 'Unverified attempt'} · Fee: {fee(verified?.feeRaw)}</span></li>;
				})}
			</ul>
			{lock?.recoveryWarning && <p className="history-feedback">{lock.recoveryWarning}</p>}
			<p className="history-note">Times use Asia/Kuala_Lumpur (MYT). Status and fees reflect the last check. Opening details does not send a transaction or start another status check.</p>
			<SavedClaimSecret session={session} owner={item.sender} lockTxid={item.lockTxid} />
		</div>
	</dialog>;
}
