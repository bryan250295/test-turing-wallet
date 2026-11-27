import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BridgeReconciliation as Report } from '../../../../shared/src/types/bridgeReconciliation';
import type { WalletPageProps } from '../../types/wallet';
import useBridgeReconciliation from '../../hooks/useBridgeReconciliation';
import WalletConnection from '../WalletConnection';
import { formatDateTime } from '../../utils/dateTime';
import { reconciliationRequests, matchesReconciliationSearch, reconciliationAmount, shortReference, requestStatusLabels, requestStageLabel, requestDirectionLabel, requestFlowLabel, requestStatusLabel } from '../../utils/bridgeReconciliation';
import ReconciliationBalances from './ReconciliationBalances';

type ReportState = ReturnType<typeof useBridgeReconciliation>;
function History({ report, state }: { report: Report; state: ReportState }) {
 const [view, setView] = useState<'requests' | 'balances'>('requests');
 const [query, setQuery] = useState('');
 const [direction, setDirection] = useState('all');
 const [status, setStatus] = useState('all');
 const [contract, setContract] = useState('all');
 const [sort, setSort] = useState('newest');
 const [page, setPage] = useState(1);
 const [pageSize, setPageSize] = useState(10);
 const requests = useMemo(() => reconciliationRequests(report), [report]);
 const matches = requests.filter(row => matchesReconciliationSearch(row, query) && (direction === 'all' || row.direction === direction) && (status === 'all' || row.category === status) && (contract === 'all' || row.route.deploymentId === contract));
 if (sort === 'oldest') matches.reverse();
 const pages = Math.max(1, Math.ceil(matches.length / pageSize));
 const currentPage = Math.min(page, pages);
 const offset = (currentPage - 1) * pageSize;
 const filtered = query !== '' || direction !== 'all' || status !== 'all' || contract !== 'all' || sort !== 'newest';
 function reset() { setQuery(''); setDirection('all'); setStatus('all'); setContract('all'); setSort('newest'); setPage(1); }
 return <>
  <p className="history-note recon-report-meta">Wallet <span title={report.identityAddress}>{shortReference(report.identityAddress)}</span> · Updated {formatDateTime(report.generatedAt)} MYT</p>
  <div className="recon-view-switch" role="group" aria-label="History view">
   <button type="button" aria-pressed={view === 'requests'} onClick={() => setView('requests')}>Requests</button>
   <button type="button" aria-pressed={view === 'balances'} onClick={() => setView('balances')}>Bridge balances</button>
  </div>
  {view === 'balances' ? <ReconciliationBalances routes={report.routes} balances={state.balances} checking={state.checking} loading={state.loading} check={state.check} /> : <>
   <dl className="recon-summary">
    <div><dt>Total requests</dt><dd>{requests.length}</dd></div>
    <div><dt>In progress</dt><dd>{requests.filter(row => row.category === 'pending').length}</dd></div>
    <div><dt>Completed</dt><dd>{requests.filter(row => row.category === 'completed').length}</dd></div>
   </dl>
   <div className="recon-filters">
    <label className="recon-search">Find a request<input type="search" value={query} placeholder="Request ID, transaction hash or address" onChange={event => { setQuery(event.target.value); setPage(1); }} /></label>
    <label>Direction<select value={direction} onChange={event => { setDirection(event.target.value); setPage(1); }}><option value="all">All directions</option><option value="forward">TBC → HyperEVM</option><option value="return">HyperEVM → TBC</option></select></label>
    <label>Status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="all">All statuses</option>{Object.entries(requestStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Sort<select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
    {report.routes.length > 1 && <label>Contract<select value={contract} onChange={event => { setContract(event.target.value); setPage(1); }}><option value="all">All contracts</option>{report.routes.map(route => <option key={route.deploymentId} value={route.deploymentId}>{shortReference(route.wrappedToken)}</option>)}</select></label>}
   </div>
   <div className="recon-list-heading"><h3>Your requests</h3>{filtered && <button className="history-secondary" type="button" onClick={reset}>Clear filters</button>}</div>
   {!matches.length ? <p className="recon-empty">{requests.length ? 'No requests match your filters.' : 'No requests yet. Open Transfer to start.'}</p> : <div className="history-scroll recon-request-table" role="region" aria-label="Your bridge requests" tabIndex={0}>
    <table className="history-table"><thead><tr><th scope="col">Created · MYT</th><th scope="col">Request ID</th><th scope="col">Direction</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col"><span className="recon-sr-only">Details</span></th></tr></thead>
     <tbody>{matches.slice(offset, offset + pageSize).map(row => <tr key={row.key}>
      <td>{formatDateTime(row.createdAt)}</td>
      <td><code title={row.id}>{shortReference(row.id)}</code></td>
      <td>{requestDirectionLabel(row)}</td>
      <td className="recon-amount-cell">{row.amountRaw === null ? 'Not set' : reconciliationAmount(row.amountRaw, row.route.decimals)} <small>{requestFlowLabel(row)}</small></td>
      <td><span className={`recon-status recon-status-${row.category}`}>{requestStatusLabel(row)}</span><small>{requestStageLabel(row) !== requestStatusLabel(row) ? requestStageLabel(row) : ''}</small></td>
      <td><Link className="history-secondary" aria-label={`View request ${row.id}`} to={`/bridge-transfer/${row.id}`}>View</Link></td>
     </tr>)}</tbody>
    </table>
   </div>}
   <div className="recon-pagination">
    <span role="status">{matches.length ? `Showing ${offset + 1}–${Math.min(offset + pageSize, matches.length)} of ${matches.length}` : '0 requests'}</span>
    <label>Rows<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10, 25, 50].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
    <div><button className="history-secondary" type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage} of {pages}</span><button className="history-secondary" type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
   </div>
  </>}
 </>;
}
export default function BridgeReconciliation({ session, active }: WalletPageProps & { active: boolean }) {
 const state = useBridgeReconciliation(session, active);
 return <section className="bridge-reconciliation" aria-labelledby="reconciliation-title" aria-busy={state.loading || !!state.checking}>
  <header className="history-titlebar recon-page-header"><div><h2 id="reconciliation-title">Bridge history</h2><p className="intro">Find a transfer and view its progress, transactions and fees.</p></div><div className="recon-live-actions"><span className={`history-live history-live-${state.realtime}`} role="status" title="The list refreshes only after the backend reports saved bridge progress changes."><span>●</span>{state.realtime === 'connected' ? 'Live updates' : state.realtime === 'reconnecting' ? 'Reconnecting once…' : state.realtime === 'connecting' ? 'Connecting…' : state.realtime === 'stopped' ? 'Live stopped' : 'Live off'}</span><button type="button" onClick={state.refresh} disabled={!state.enabled || state.loading || !!state.checking}>{state.loading ? 'Refreshing…' : 'Refresh history'}</button></div></header>
  {!state.enabled && <><WalletConnection session={session} /><p>Connect your TBC Testnet wallet to view your requests.</p></>}
  {state.error && <p className="result error" role="alert">{state.error}</p>}
  {state.report && <History key={state.report.identityAddress} report={state.report} state={state} />}
 </section>;
}
