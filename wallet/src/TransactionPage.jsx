import { Fragment, useEffect, useRef, useState } from 'react';
import { getNativeHistory, getTokenHistory } from './tbcApi';

const shortId = (value) => `${value.slice(0, 10)}…${value.slice(-8)}`;
const statusOf = (row) => row.records.some(({ data }) => data.confirmations === 0 || data.height === -1) ? 'Pending'
	: row.records.some(({ data }) => data.confirmations > 0) ? 'Confirmed' : 'Unknown';
const timeOf = (row) => Math.max(0, ...row.records.map(({ data }) => Number(data.time) || 0));
const dateOf = (time) => time ? new Date(time * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' }) : 'Awaiting confirmation';

export default function TransactionPage({ session, hidden }) {
	const { address, networkIsDevnet } = session;
	const [refresh, setRefresh] = useState(0);
	const [notices, setNotices] = useState([]);
	const [notificationMessage, setNotificationMessage] = useState('');
	const [desktopEnabled, setDesktopEnabled] = useState(false);
	const desktopRef = useRef(false);
	const observed = useRef({ address: '', statuses: new Map(), notified: new Set() });
	async function enableNotifications() {
		if (!('Notification' in window)) { setNotificationMessage('Desktop notifications are not supported in this browser.'); return; }
		try {
			const permission = await Notification.requestPermission();
			desktopRef.current = permission === 'granted';
			setDesktopEnabled(desktopRef.current);
			setNotificationMessage(permission === 'granted' ? 'Desktop confirmation notifications enabled.' : 'Desktop notifications are blocked. In-app alerts still work.');
		} catch { setNotificationMessage('Could not enable desktop notifications. In-app alerts still work.'); }
	}
	const [search, setSearch] = useState('');
	const [statusFilter, setStatusFilter] = useState('All statuses');
	const [activityFilter, setActivityFilter] = useState('All assets');
	const [page, setPage] = useState(1);
	const [expanded, setExpanded] = useState(null);
	const [copyMessage, setCopyMessage] = useState('');
	useEffect(() => { setPage(1); setExpanded(null); }, [address, search, statusFilter, activityFilter]);
	const [state, setState] = useState({ address: '', loading: true, rows: [], errors: [] });
	useEffect(() => {
		const controller = new AbortController();
		let timer;
		let failures = 0;
		if (observed.current.address !== address) {
			observed.current = { address, statuses: new Map(), notified: new Set() };
			setNotices([]);
		}
		setState((previous) => previous.address === address ? { ...previous, loading: true } : { address, loading: true, rows: [], errors: [] });
		if (!address || !networkIsDevnet) return () => controller.abort();
		async function load() {
			const results = await Promise.allSettled([
				getNativeHistory(address, { signal: controller.signal }),
				getTokenHistory(address, { signal: controller.signal }),
			]);
			if (controller.signal.aborted) return;
			const grouped = new Map();
			const errors = [];
			results.forEach((result, index) => {
				const source = index === 0 ? 'Native TBC' : 'FT tokens';
				if (result.status === 'rejected') { errors.push(`${source}: ${result.reason.message}`); return; }
				for (const data of result.value) {
					if (!grouped.has(data.txid)) grouped.set(data.txid, { txid: data.txid, records: [] });
					grouped.get(data.txid).records.push({ source, data });
				}
			});
			const rows = [...grouped.values()];
			const pending = (row) => row.records.some(({ data }) => data.confirmations === 0 || data.height === -1);
			const newest = (row, key) => Math.max(0, ...row.records.map(({ data }) => Number(data[key]) || 0));
			rows.sort((a, b) => Number(pending(b)) - Number(pending(a)) || newest(b, 'time') - newest(a, 'time') || newest(b, 'height') - newest(a, 'height') || a.txid.localeCompare(b.txid));
			const tracking = observed.current;
			for (const row of rows) {
				const status = statusOf(row);
				if (tracking.statuses.get(row.txid) === 'Pending' && status === 'Confirmed' && !tracking.notified.has(row.txid)) {
					tracking.notified.add(row.txid);
					setNotices((previous) => [...previous, row.txid].slice(-5));
					if (desktopRef.current && 'Notification' in window && Notification.permission === 'granted') {
						try { new Notification('TBC Devnet · Transaction confirmed', { body: row.txid, tag: row.txid }); } catch { /* In-app alert remains available. */ }
					}
				}
				// Missing rows and failed requests never imply a transaction failed.
				tracking.statuses.set(row.txid, status);
			}
			setState((previous) => ({ address, loading: false, rows: errors.length === 2 ? previous.rows : rows, errors }));
			failures = errors.length ? failures + 1 : 0;
			const hasPending = [...tracking.statuses.values()].includes('Pending');
			const delay = failures ? Math.min(120000, 15000 * 2 ** Math.min(failures, 3)) : hasPending ? 15000 : 60000;
			timer = window.setTimeout(load, delay);
		}
		void load();
		return () => { controller.abort(); window.clearTimeout(timer); };
	}, [address, networkIsDevnet, refresh]);

	const rows = state.address === address && networkIsDevnet ? state.rows : [];
	const filtered = rows.filter((row) =>
		(statusFilter === 'All statuses' || statusOf(row) === statusFilter) &&
		(activityFilter === 'All assets' || row.records.some(({ source }) => source === activityFilter)) &&
		(!search.trim() || JSON.stringify(row).toLowerCase().includes(search.trim().toLowerCase())));
	const pageCount = Math.max(1, Math.ceil(filtered.length / 15));
	const currentPage = Math.min(page, pageCount);
	const visible = filtered.slice((currentPage - 1) * 15, currentPage * 15);
	const confirmed = rows.filter((row) => statusOf(row) === 'Confirmed').length;
	const pending = rows.filter((row) => statusOf(row) === 'Pending').length;

	async function copyTxid(txid) {
		try { await navigator.clipboard.writeText(txid); setCopyMessage('Transaction ID copied.'); }
		catch { setCopyMessage('Copy unavailable. Select the full ID in transaction details.'); }
	}

	return <>
		<div className="confirmation-notices" aria-live="polite">{notices.map((txid) => <div className="confirmation-notice" key={txid}><div><strong>Transaction confirmed</strong><code title={txid}>{shortId(txid)}</code></div><button type="button" aria-label="Dismiss confirmation notification" onClick={() => setNotices((previous) => previous.filter((value) => value !== txid))}>×</button></div>)}</div>
		<section className="card history-card" hidden={hidden}>
		<div className="history-titlebar">
			<div><p className="eyebrow">ACTIVITY / TBC DEVNET</p><h1>Transaction history</h1><p className="intro">Your on-chain activity, in one place.</p></div>
			<button type="button" className="history-refresh" disabled={state.loading || !address || !networkIsDevnet} onClick={() => setRefresh((value) => value + 1)}>{state.loading ? 'Refreshing…' : '↻ Refresh'}</button>
		</div>
		<div className="history-account"><div><span className={`dot ${networkIsDevnet ? 'ok' : ''}`} /><strong>{networkIsDevnet && address ? 'Connected account' : 'Wallet connection required'}</strong><code title={address}>{address || 'No account connected'}</code></div><span className="network-pill">Devnet · Test assets</span><button type="button" className="history-secondary" disabled={session.busy} onClick={session.connect}>{session.busy ? 'Connecting…' : address ? 'Reconnect' : 'Connect wallet'}</button></div>
		{!address || !networkIsDevnet ? <div className="history-empty"><h2>Connect to see your activity</h2><p>Select TBC Devnet in your wallet, then connect your account.</p></div> : <>
			<div className="notification-settings"><span>● Auto-updates on · {pending ? 'Checking pending transactions every 15 seconds' : 'Checking for activity every 60 seconds'}</span><button type="button" className="history-secondary" disabled={desktopEnabled} onClick={enableNotifications}>{desktopEnabled ? 'Desktop alerts enabled' : 'Enable desktop alerts'}</button></div>
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
				<thead><tr><th scope="col">Transaction</th><th scope="col">Asset type</th><th scope="col">Status</th><th scope="col">Date & time <small>MYT</small></th><th scope="col">Confirmations</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
				<tbody>{visible.map((row) => {
					const status = statusOf(row);
					const confirmations = row.records.map(({ data }) => data.confirmations).filter((value) => typeof value === 'number');
					return <Fragment key={row.txid}><tr className={expanded === row.txid ? 'is-expanded' : ''}>
						<td><div className="history-txid"><code title={row.txid}>{shortId(row.txid)}</code><button type="button" className="copy-txid" aria-label={`Copy transaction ID ${row.txid}`} onClick={() => copyTxid(row.txid)}>Copy</button></div></td>
						<td>{[...new Set(row.records.map(({ source }) => source))].join(' / ')}</td>
						<td><span className={`status-badge status-${status.toLowerCase()}`}><span aria-hidden="true">●</span> {status}</span></td>
						<td className="history-date">{dateOf(timeOf(row))}</td>
						<td>{confirmations.length ? Math.min(...confirmations).toLocaleString() : '—'}</td>
						<td><button type="button" className="history-detail-button" aria-expanded={expanded === row.txid} aria-controls={`details-${row.txid}`} onClick={() => setExpanded(expanded === row.txid ? null : row.txid)}>{expanded === row.txid ? 'Close ↑' : 'Details ↓'}</button></td>
					</tr>
					{expanded === row.txid && <tr id={`details-${row.txid}`} className="history-detail-row"><td colSpan={6}><div className="history-detail-content"><h3>Transaction details</h3><p>All fields returned by the API. Amount fields retain their original units.</p>{row.records.map((record, index) => <section key={index}><h4>{record.source}</h4><dl className="history-detail-grid">{Object.entries(record.data).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value !== null && typeof value === 'object' ? <pre className="history-json">{JSON.stringify(value, null, 2)}</pre> : <code>{value == null ? '—' : String(value)}</code>}</dd></div>)}</dl></section>)}</div></td></tr>}
					</Fragment>;
				})}
				{!visible.length && <tr><td colSpan={6}><div className="history-empty"><h3>{state.loading ? 'Loading your activity…' : state.errors.length ? 'History unavailable' : rows.length ? 'No matching transactions' : 'No activity yet'}</h3><p>{state.loading ? 'Fetching your native TBC and token transactions.' : rows.length ? 'Try another search or change your filters.' : state.errors.length ? 'Refresh to try loading your transactions again.' : 'Your transactions will appear here after you send, receive or mint.'}</p></div></td></tr>}
				</tbody>
			</table></div>
			<div className="history-footer"><span>{filtered.length ? `${(currentPage - 1) * 15 + 1}–${Math.min(currentPage * 15, filtered.length)} of ${filtered.length}` : '0 results'}</span><div><button type="button" className="history-secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage} / {pageCount}</span><button type="button" className="history-secondary" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
			<p className="history-note">Native TBC & fungible tokens · Times in Malaysia time · NFT activity is not included</p>
		</>}
	</section></>;
}
