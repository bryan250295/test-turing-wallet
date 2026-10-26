import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { WalletPageProps } from '../../types/wallet';
import type { HtlcRecoveryTarget } from '../../types/htlc';
import type { HtlcRequest } from '../../services/htlcRequestHistory';
import { isObject } from '../../services/apiValidation';
import { getErrorMessage } from '../../utils/errors';
import { formatRawAmount } from '../../utils/tokenAmounts';
import useHtlcRequests from '../../hooks/useHtlcRequests';
import WalletConnection from '../WalletConnection';
import { canRecoverHtlc, formatHtlcDate, htlcActionReason, htlcRequestStatus, isCompletedHtlc } from '../../utils/htlcRequestHistory';
import HtlcRequestDetails from './HtlcRequestDetails';

export default function HtlcRequests({ session, active, onRecover }: WalletPageProps & { active: boolean; onRecover: (target: HtlcRecoveryTarget) => void }) {
	const state = useHtlcRequests(session, active);
	const [lockTxid, setLockTxid] = useState('');
	const [contractId, setContractId] = useState('');
	const [importError, setImportError] = useState('');
	const disabled = !state.ready || state.loading || session.busy;
	const [filter, setFilter] = useState<'active' | 'completed' | 'all'>('all');
	const [selection, setSelection] = useState<{ address: string; txid: string } | null>(null);
	useEffect(() => { setFilter('all'); setSelection(null); }, [session.address, session.networkIsDevnet]);
	const completedCount = state.requests.filter((item) => {
		const observation = state.observations[item.lockTxid];
		return isCompletedHtlc(observation?.lock, observation?.error);
	}).length;
	const counts = { active: state.requests.length - completedCount, completed: completedCount, all: state.requests.length };
	const visible = state.requests.filter((item) => {
		if (filter === 'all') return true;
		const observation = state.observations[item.lockTxid];
		return isCompletedHtlc(observation?.lock, observation?.error) === (filter === 'completed');
	});
	const selected = active && state.ready && selection?.address === session.address ? state.requests.find((item) => item.lockTxid === selection.txid) : undefined;

	return <section aria-labelledby="htlc-requests-title" aria-busy={state.loading}>
		<div className="history-titlebar"><div><h2 id="htlc-requests-title">My HTLC Requests</h2><p>Token locks involving your connected Testnet wallet.</p></div><div className="htlc-actions"><button type="button" disabled={disabled} onClick={() => void state.refresh()}>{state.loading ? 'Loading requests…' : 'Refresh requests'}</button></div></div>
		<WalletConnection session={session} />
		<p className="history-note">Requests are saved automatically on this local app server and loaded for your selected wallet. Existing browser history is migrated automatically. Add an older lock once if it has never been saved here. This list does not discover every HTLC on the network. The server checks saved locks when this list loads and returns their latest available status. Use Refresh requests to reload; recent checks may be reused briefly.</p>
		{!state.ready && <p className="history-feedback">Connect your wallet on TBC Testnet to view its requests.</p>}
		{state.storageError && <p className="result error" role="alert">{state.storageError}</p>}
		{state.error && <p className="result error" role="alert">{state.error}</p>}
		<details className="htlc-section"><summary>Add an existing request</summary>
			<label htmlFor="htlc-history-file">Import lock or recovery receipt JSON</label>
			<input id="htlc-history-file" type="file" accept="application/json,.json" disabled={disabled} onChange={async (event) => {
				const input = event.currentTarget;
				const file = input.files?.[0];
				if (!file) return;
				setImportError('');
				try {
					if (file.size > 2 * 1024 * 1024) throw new Error('Choose a JSON file smaller than 2 MB.');
					const root: unknown = JSON.parse(await file.text());
					if (!isObject(root) || !isObject(root.unsigned) || !isObject(root.unsigned.plan) || !isObject(root.unsigned.plan.terms)) throw new Error('Choose a signed lock export, lock receipt or recovery receipt.');
					const unsigned = root.unsigned;
					const recovery = unsigned.action === 'claim' || unsigned.action === 'refund';
					const candidate = isObject(root.receipt) ? root.receipt.txid : isObject(root.signed) ? root.signed.txid : undefined;
					const original = recovery ? unsigned.lockTxid : candidate;
					const contract = root.unsigned.plan.terms.contractId;
					if (typeof original !== 'string' || !/^[0-9a-f]{64}$/i.test(original) || typeof contract !== 'string' || !/^[0-9a-f]{64}$/i.test(contract)) throw new Error('This file has no valid lock TXID and contract ID. Add them manually below.');
					if (root.network && root.network !== 'testnet' || unsigned.network !== 'testnet') throw new Error('Only TBC Testnet exports are supported.');
					const candidates: HtlcRequest['recoveries'] = recovery && typeof candidate === 'string' && /^[0-9a-f]{64}$/i.test(candidate) ? [{ txid: candidate.toLowerCase(), action: unsigned.action as 'claim' | 'refund', submission: 'unknown' }] : [];
					setLockTxid(original.toLowerCase()); setContractId(contract.toLowerCase());
					await state.add(original, contract, candidates);
				} catch (cause) { setImportError(getErrorMessage(cause)); }
				finally { input.value = ''; }
			}} />
			<p className="history-note">Only public transaction IDs are sent for verification. Secrets, signatures and transaction hex are not saved in this list.</p>
			{importError && <p className="result error" role="alert">{importError}</p>}
			<form onSubmit={(event) => { event.preventDefault(); void state.add(lockTxid, contractId); }}>
				<label htmlFor="htlc-history-txid">Original lock TXID</label><input id="htlc-history-txid" value={lockTxid} onChange={(event) => setLockTxid(event.target.value)} required pattern="[0-9a-fA-F]{64}" disabled={disabled} autoComplete="off" spellCheck={false} />
				<label htmlFor="htlc-history-contract">FT contract ID</label><input id="htlc-history-contract" value={contractId} onChange={(event) => setContractId(event.target.value)} required pattern="[0-9a-fA-F]{64}" disabled={disabled} autoComplete="off" spellCheck={false} />
				<button type="submit" disabled={disabled}>Verify and add request</button>
			</form>
		</details>
		{state.ready && !state.loading && !state.requests.length && <p className="history-feedback">No saved requests for this wallet. Add your existing lock above to get started.</p>}
		{state.requests.length > 0 && <>
			<div className="htlc-request-filters" role="group" aria-label="Filter token lock requests">
				{(['all', 'active', 'completed'] as const).map((value) => <button type="button" key={value} className={filter === value ? 'selected' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'active' ? 'Active' : value === 'completed' ? 'Completed' : 'All'} <span>{counts[value]}</span></button>)}
			</div>
			<p className="history-feedback" role="status">{visible.length} {filter === 'all' ? '' : filter + ' '}requests{state.loading ? ' · Updating status…' : ''}. Active includes pending and unverified requests; Completed requires a confirmed Claim or Refund.</p>
			<div className="history-scroll" role="region" aria-label="Saved HTLC requests" tabIndex={0}><table className="history-table"><thead><tr><th scope="col">Lock transaction</th><th scope="col">Your role</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Refund · MYT</th><th scope="col">Actions</th></tr></thead><tbody>{visible.map((item) => {
				const observation = state.observations[item.lockTxid];
				const lock = observation?.lock;
				const completed = isCompletedHtlc(lock, observation?.error);
				const canRecover = !observation?.error && canRecoverHtlc(lock);
				const sender = item.sender === session.address;
				const recipient = item.receiver === session.address;
				return <tr key={item.lockTxid}>
					<td><Link to={`/transaction?txid=${item.lockTxid}`}><code>{item.lockTxid.slice(0, 12)}…{item.lockTxid.slice(-8)}</code></Link><small className="inquiry-chain">Contract: {item.contractId.slice(0, 12)}…</small></td>
					<td>{sender && recipient ? 'Sender A / Recipient B' : sender ? 'Sender A' : 'Recipient B'}</td>
					<td><strong>{lock?.name || item.tokenName || 'Unknown token'}</strong><small className="inquiry-chain">{formatRawAmount(lock?.amountRaw ?? item.amountRaw, lock?.decimals ?? item.decimals)} {lock?.symbol ?? item.symbol}</small></td>
					<td><strong className={`status-badge ${completed ? 'status-confirmed' : observation?.error ? 'status-unavailable' : 'status-pending'}`}>{observation?.error ? 'Status unavailable' : htlcRequestStatus(item, lock)}</strong>{lock && <small className="inquiry-chain">Checked {formatHtlcDate(lock.checkedAt)} MYT{observation?.error ? ` · Previous result: ${htlcRequestStatus(item, lock)}` : ''}</small>}{observation?.error && <p role="status">Check failed: {observation.error}</p>}{lock?.recoveryWarning && <p>{lock.recoveryWarning}</p>}{lock?.recovery && <small className="inquiry-chain"><Link to={`/transaction?txid=${lock.recovery.txid}`}>{lock.recovery.action === 'claim' ? 'Claim' : 'Refund'}: {lock.recovery.txid.slice(0, 10)}…</Link> · {lock.recovery.confirmations} confirmations{observation?.error ? ' · Previous result' : ''}</small>}</td>
					<td>{formatHtlcDate(item.refundTimestamp)}<small className="inquiry-chain">{completed ? 'Completed' : observation?.error || !lock ? 'Eligibility not verified' : !lock.controlUnspent || !lock.tokenUnspent || lock.recovery ? 'Unavailable' : lock.refundEligible ? 'Eligible by chain time' : 'Pending chain time'}</small></td>
					<td><div className="htlc-row-actions">
						{!completed && (['claim', 'refund'] as const).filter((action) => action === 'claim' ? recipient : sender).map((action) => {
							const reason = htlcActionReason(lock, observation?.error, action);
							const reasonId = `${item.lockTxid}-${action}-reason`;
							return <div key={action}><button type="button" disabled={disabled || !canRecover || !!reason} aria-describedby={reason ? reasonId : undefined} onClick={() => {
								if (canRecover && !reason) onRecover({ lockTxid: item.lockTxid, contractId: item.contractId });
							}}>{action === 'claim' ? 'Claim' : 'Refund'}</button>{reason && <small id={reasonId} className="inquiry-chain">{reason}</small>}</div>;
						})}
						<button type="button" className="history-secondary" aria-haspopup="dialog" onClick={() => setSelection({ address: session.address, txid: item.lockTxid })}>View details</button>
					</div></td>
				</tr>;
			})}
			{!visible.length && <tr><td colSpan={6}><div className="history-empty"><h3>{filter === 'completed' ? 'No confirmed completed locks' : 'No active requests'}</h3><p>{filter === 'completed' ? 'Confirmed claims and refunds will appear here.' : 'Open Completed to view finished locks, or All to see every saved request.'}</p></div></td></tr>}
			</tbody></table></div>
		</>}
		{selected && <HtlcRequestDetails key={selected.lockTxid} item={selected} lock={state.observations[selected.lockTxid]?.lock} error={state.observations[selected.lockTxid]?.error} session={session} onClose={() => setSelection(null)} />}
	</section>;
}
