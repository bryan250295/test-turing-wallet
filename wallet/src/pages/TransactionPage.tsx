import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { Amount, TransactionEntry } from '../types/api';
import type { WalletPageProps } from '../types/wallet';
import type { TransactionRow } from '../types/transaction';
import WalletConnection from '../components/WalletConnection';
import useTransactionHistory from '../hooks/useTransactionHistory';
import { statusOf, shortId, timeOf, dateOf, formatFeeTbc, transactionParties, transactionAmount } from '../utils/transactions';

function AddressList({ entries }: { entries: TransactionEntry[] }) {
	const addresses = [...new Set(entries.map((entry) => entry.address).filter((value): value is string => typeof value === 'string' && Boolean(value)))];
	return addresses.length ? addresses.map((value) => <code className="history-address" key={value} title={value}>{value}</code>) : '—';
}

export default function TransactionPage({ session, hidden }: WalletPageProps) {
	const { address, networkIsDevnet } = session;

	const [notices, setNotices] = useState<string[]>([]);
	const [notificationMessage, setNotificationMessage] = useState('');
	const [desktopEnabled, setDesktopEnabled] = useState(false);
	const desktopRef = useRef(false);
	async function enableNotifications() {
		if (!('Notification' in window)) {
			setNotificationMessage('Desktop notifications are not supported in this browser.');
			return;
		}
		try {
			const permission = await Notification.requestPermission();
			desktopRef.current = permission === 'granted';
			setDesktopEnabled(desktopRef.current);
			setNotificationMessage(permission === 'granted' ? 'Desktop confirmation notifications enabled.' : 'Desktop notifications are blocked. In-app alerts still work.');
		} catch {
			setNotificationMessage('Could not enable desktop notifications. In-app alerts still work.');
		}
	}

	const notifyConfirmation = useCallback((txid: string) => {
		setNotices((previous) => [...previous, txid].slice(-5));
		if (!desktopRef.current || !('Notification' in window) || Notification.permission !== 'granted') return;
		try {
			new Notification('TBC Devnet · Transaction confirmed', { body: txid, tag: txid });
		} catch { /* In-app alert remains available. */ }
	}, []);

	function dismissNotice(txid: string) {
		setNotices((previous) => previous.filter((value) => value !== txid));
	}
	const { state, detailsByTxid, refresh: loadHistory, loadTransactionDetails } =
		useTransactionHistory(address, networkIsDevnet, hidden, notifyConfirmation);

	useEffect(() => { setNotices([]); }, [address]);

	const [search, setSearch] = useState('');
	const [statusFilter, setStatusFilter] = useState('All statuses');
	const [activityFilter, setActivityFilter] = useState('All assets');
	const [page, setPage] = useState(1);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [copyMessage, setCopyMessage] = useState('');
	useEffect(() => {
		setPage(1);
		setExpanded(null);
	}, [address, search, statusFilter, activityFilter]);

	function toggleTransactionDetails(row: TransactionRow) {
		if (expanded === row.txid) {
			setExpanded(null);
			return;
		}
		setExpanded(row.txid);
		void loadTransactionDetails(row);
	}

	const rows = state.address === address && networkIsDevnet
		? state.rows.map((row) => ({ ...row, ...detailsByTxid[row.txid] }))
		: [];
	const filtered = rows.filter((row) =>
		(statusFilter === 'All statuses' || statusOf(row) === statusFilter) &&
		(activityFilter === 'All assets' || row.records.some(({ source }) => source === activityFilter)) &&
		(!search.trim() || JSON.stringify(row).toLowerCase().includes(search.trim().toLowerCase())));
	const pageCount = Math.max(1, Math.ceil(filtered.length / 15));
	const currentPage = Math.min(page, pageCount);
	const visible = filtered.slice((currentPage - 1) * 15, currentPage * 15);
	const confirmed = rows.filter((row) => statusOf(row) === 'Confirmed').length;
	const pending = rows.filter((row) => statusOf(row) === 'Pending').length;

	async function copyTxid(txid: string) {
		try {
			await navigator.clipboard.writeText(txid);
			setCopyMessage('Transaction ID copied.');
		} catch {
			setCopyMessage('Copy unavailable. Select the full ID in transaction details.');
		}
	}

	return <>
		<div className="confirmation-notices" aria-live="polite">{notices.map((txid) => <div className="confirmation-notice" key={txid}><div><strong>Transaction confirmed</strong><code title={txid}>{shortId(txid)}</code></div><button type="button" aria-label="Dismiss confirmation notification" onClick={() => dismissNotice(txid)}>×</button></div>)}</div>
		<section className="card history-card" hidden={hidden}>
		<div className="history-titlebar">
			<div><p className="eyebrow">ACTIVITY / TBC DEVNET</p><h1>Transaction history</h1><p className="intro">Your on-chain activity, in one place.</p></div>
			{/* <button type="button" className="history-refresh" onClick={() => notifyConfirmation(`test-${crypto.randomUUID()}`)}>Test Notification</button> */}
			<button type="button" className="history-refresh" disabled={state.loading || !address || !networkIsDevnet} onClick={loadHistory}>{state.loading ? 'Refreshing…' : '↻ Refresh'}</button>
		</div>
		<WalletConnection session={session} />
		{!address || !networkIsDevnet ? <div className="history-empty"><h2>Connect to see your activity</h2><p>Select TBC Devnet in your wallet, then connect your account.</p></div> : <>
			<div className="notification-settings"><span>Manual updates · Click Refresh to check transaction status</span><button type="button" className="history-secondary" disabled={desktopEnabled} onClick={enableNotifications}>{desktopEnabled ? 'Desktop alerts enabled' : 'Enable desktop alerts'}</button></div>
			{notificationMessage && <p className="history-feedback" role="status">{notificationMessage}</p>}
			<div className="history-stats" aria-label="Transaction summary">
				<div><span>Total transactions</span><strong>{state.loading ? '—' : rows.length}</strong></div>
				<div><span>Confirmed</span><strong>{state.loading ? '—' : confirmed}</strong></div>
				<div><span>Pending</span><strong>{state.loading ? '—' : pending}</strong></div>
			</div>
			{state.errors.map((error) => <p className="result error" role="alert" key={error}>{error} History may be incomplete.</p>)}
			<div className="history-toolbar">
				<label className="history-search">Search activity<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search TXID, address or contract…" /></label>
				<label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>{['All statuses', 'Confirmed', 'Pending', 'Unknown'].map((value) => <option key={value}>{value}</option>)}</select></label>
				<label>Asset type<select value={activityFilter} onChange={(event) => setActivityFilter(event.target.value)}>{['All assets', 'Native TBC', 'FT tokens'].map((value) => <option key={value}>{value}</option>)}</select></label>
			</div>
			<p className="history-feedback" role="status">{copyMessage || (state.loading ? 'Loading transaction history…' : `${filtered.length} transactions · Latest first`)}</p>
			<div className="history-scroll" tabIndex={0} role="region" aria-label="Transaction history"><table className="history-table">
				<thead><tr><th scope="col">Transaction</th><th scope="col">Asset type</th><th scope="col">Status</th><th scope="col">Amount <small>net</small></th><th scope="col">Fee <small>TBC</small></th><th scope="col">Date & time <small>MYT</small></th><th scope="col">Confirmations</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
				<tbody>{visible.map((row) => {
					const status = statusOf(row);
					const parties = transactionParties(row);
					const fees = [...new Set(row.records.map(({ data }) => data.fee).filter((value): value is Amount => value != null))];
					const confirmations = row.records.map(({ data }) => data.confirmations).filter((value) => typeof value === 'number');
					return <Fragment key={row.txid}><tr
						className={`history-transaction-row${expanded === row.txid ? ' is-expanded' : ''}`}
						onClick={(event) => {
							if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
							toggleTransactionDetails(row);
						}}
					>
						<td><div className="history-txid"><code title={row.txid}>{shortId(row.txid)}</code><button type="button" className="copy-txid" aria-label={`Copy transaction ID ${row.txid}`} onClick={() => copyTxid(row.txid)}>Copy</button></div></td>
						<td>{[...new Set(row.records.map(({ source }) => source))].join(' / ')}</td>
						<td><span className={`status-badge status-${status.toLowerCase()}`}><span aria-hidden="true">●</span> {status}</span></td>
						<td className="history-amount">{transactionAmount(row, address)}</td>
						<td className="history-fee" title={fees.length ? `${fees.join(' / ')} satoshis` : undefined}>{fees.length ? fees.map(formatFeeTbc).join(' / ') : '—'}</td>
						<td className="history-date">{dateOf(timeOf(row))}</td>
						<td>{confirmations.length ? Math.min(...confirmations).toLocaleString() : '—'}</td>
						<td><button type="button" className="history-detail-button" aria-label={`${expanded === row.txid ? 'Close' : 'Details for'} transaction ${row.txid}`} aria-expanded={expanded === row.txid} aria-controls={expanded === row.txid ? `details-${row.txid}` : undefined} onClick={() => toggleTransactionDetails(row)}>{expanded === row.txid ? 'Close ↑' : 'Details ↓'}</button></td>
					</tr>
					{expanded === row.txid && <tr id={`details-${row.txid}`} className="history-detail-row"><td colSpan={8}><div className="history-detail-content"><h3>Transaction details</h3>{row.loading && <p role="status">Loading token transaction details…</p>}{row.error && <div><p className="result error" role="alert">{row.error}</p><button type="button" onClick={() => loadTransactionDetails(row)}>Retry details</button></div>}<dl className="history-detail-grid"><div><dt>Sender</dt><dd><AddressList entries={parties.inputs} /></dd></div><div><dt>Receiver / change</dt><dd><AddressList entries={parties.outputs} /></dd></div></dl><p>Amounts in the table show the net change for your connected address; native TBC net change includes fees. Receiver lists include change outputs. Raw fields below retain their API units.</p>{[...row.records, ...(row.tokenDetails ? [{ source: 'Token transfer details', data: row.tokenDetails }] : []), ...(row.tokenInfo ? [{ source: 'Token metadata', data: row.tokenInfo }] : [])].map((record, index) => <section key={index}><h4>{record.source}</h4><dl className="history-detail-grid">{Object.entries(record.data).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value !== null && typeof value === 'object' ? <pre className="history-json">{JSON.stringify(value, null, 2)}</pre> : <code>{value == null ? '—' : String(value)}</code>}</dd></div>)}</dl></section>)}</div></td></tr>}
					</Fragment>;
				})}
				{!visible.length && <tr><td colSpan={8}><div className="history-empty"><h3>{state.loading ? 'Loading your activity…' : state.errors.length ? 'History unavailable' : rows.length ? 'No matching transactions' : 'No activity yet'}</h3><p>{state.loading ? 'Fetching your native TBC and token transactions.' : rows.length ? 'Try another search or change your filters.' : state.errors.length ? 'Refresh to try loading your transactions again.' : 'Your transactions will appear here after you send, receive or mint.'}</p></div></td></tr>}
				</tbody>
			</table></div>
			<div className="history-footer"><span>{filtered.length ? `${(currentPage - 1) * 15 + 1}–${Math.min(currentPage * 15, filtered.length)} of ${filtered.length}` : '0 results'}</span><div><button type="button" className="history-secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage} / {pageCount}</span><button type="button" className="history-secondary" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
			<p className="history-note">Amount = net change for this account · Fees in TBC · Native TBC & fungible tokens · Times in Malaysia time · NFT activity is not included</p>
		</>}
	</section></>;
}
