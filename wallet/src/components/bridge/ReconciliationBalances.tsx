import { useState } from 'react';
import type { ReconciliationBalanceCheck, ReconciliationRoute } from '../../../../shared/src/types/bridgeReconciliation';
import { reconciliationAmount as amount, shortReference } from '../../utils/bridgeReconciliation';
import { formatDateTime } from '../../utils/dateTime';
import ReconciliationTransactions from './ReconciliationTransactions';
const date = (value: string | null) => value ? `${formatDateTime(value)} MYT` : 'Not recorded';
function BalanceCheck({ value, route }: { value: ReconciliationBalanceCheck; route: ReconciliationRoute }) {
	return <section className="reconciliation-observation" aria-label="Observed contract balances">
		<p className={`result ${value.status === 'matching' ? 'success' : value.status === 'unavailable' ? 'error' : ''}`} role="status">{value.status === 'matching' ? 'Balances match.' : value.status === 'difference' ? 'Balances differ. Check in-progress requests in Requests.' : 'Balances could not be checked. Try again later.'}</p>
		<p className="history-note">Last checked: {date(value.checkedAt)}. Covers registered bridge addresses only.</p>
		{value.status !== 'unavailable' && <>
			<dl className="history-detail-grid">
				<div><dt>{route.symbol} held by the bridge</dt><dd>{amount(value.indexedReserveRaw!, route.decimals)} {route.symbol}</dd></div>
				<div><dt>Circulating {route.wrappedSymbol}</dt><dd>{amount(value.circulatingRaw!, route.decimals)} {route.wrappedSymbol}</dd></div>
				<div><dt>Total {route.wrappedSymbol}</dt><dd>{amount(value.totalSupplyRaw!, route.decimals)} {route.wrappedSymbol}</dd></div>
				<div><dt>Permanently locked {route.wrappedSymbol}</dt><dd>{amount(value.permanentlyLockedRaw!, route.decimals)} {route.wrappedSymbol}</dd></div>
				<div><dt>Balance difference</dt><dd>{amount(value.differenceRaw!, route.decimals)} token units</dd></div>
			</dl>
		</>}
	</section>;
}
function Route({ route, observation, checking, busy, check }: { route: ReconciliationRoute; observation?: ReconciliationBalanceCheck; checking: boolean; busy: boolean; check: () => void }) {
	const totals = route.totals;
	const status = { balanced: 'Records match', pending: 'Transfer in progress', needs_review: 'Review needed', empty: 'No confirmed activity' }[route.status];
	return <section className="reconciliation-route" aria-label={`Reconciliation for ${route.wrappedToken}`}>
		<header className="history-titlebar"><h3>{route.symbol} ↔ {route.wrappedSymbol}</h3><span className={`status-badge ${route.status === 'balanced' ? 'status-confirmed' : ''}`}>{status}</span></header>
		<p className="history-note">{route.wrappedSymbol} contract: <code>{route.wrappedToken}</code></p>
		<h4>Your completed transfers</h4>
		<dl className="history-detail-grid reconciliation-totals">
			<div><dt>{route.symbol} deposited</dt><dd>{amount(totals.depositedRaw, route.decimals)} {route.symbol}</dd></div>
			<div><dt>{route.wrappedSymbol} minted</dt><dd>{amount(totals.mintedRaw, route.decimals)} {route.wrappedSymbol}</dd></div>
			<div><dt>{route.wrappedSymbol} permanently locked</dt><dd>{amount(totals.lockedRaw, route.decimals)} {route.wrappedSymbol}</dd></div>
			<div><dt>{route.symbol} returned</dt><dd>{amount(totals.returnedRaw, route.decimals)} {route.symbol}</dd></div>
			<div><dt>Recorded {route.symbol} remaining</dt><dd>{amount(totals.reserveRaw, route.decimals)} {route.symbol}</dd></div>
			<div><dt>Recorded circulating {route.wrappedSymbol}</dt><dd>{amount(totals.circulatingRaw, route.decimals)} {route.wrappedSymbol}</dd></div>
		</dl>
		<p>Recorded balance difference: <strong>{amount(totals.differenceRaw, route.decimals)} token units</strong>. Check pending transfers if these amounts differ.</p>
		{route.issues.map((issue) => <p key={issue} className="result error" role="alert">{issue}</p>)}
		<h4>Check current balances</h4>
		<p>Click below to update the balances for this bridge contract.</p>
		<button type="button" disabled={busy} onClick={check}>{checking ? 'Reading both networks…' : 'Check current balances'}</button>
		<p className="history-note">Balances cover registered bridge addresses and are checked separately on each network. They may differ while a transfer is pending.</p>
		{observation && <BalanceCheck value={observation} route={route} />}
		<h4>Recorded actual fees</h4>
		<dl className="history-detail-grid">
			<div><dt>TBC transaction fees</dt><dd>{amount(totals.tbcFeesRaw, 6)} TBC</dd></div>
			<div><dt>HyperEVM transaction fees · includes deployment</dt><dd>{amount(totals.hypeFeesWei, 18)} HYPE</dd></div>
		</dl>
		<p className="history-note">Totals include recorded fees only. Fees marked Not recorded are excluded.</p>
		<details className="reconciliation-details"><summary>Contract setup transactions</summary><ReconciliationTransactions rows={route.setupTransactions} title="Contract setup" /></details>
	</section>;
}

export default function ReconciliationBalances({ routes, balances, checking, loading, check }: {
 routes: ReconciliationRoute[]; balances: Record<string, ReconciliationBalanceCheck>; checking: string | null; loading: boolean; check: (route: ReconciliationRoute) => Promise<void>;
}) {
 const [selected, setSelected] = useState(routes[0]?.deploymentId ?? '');
 const route = routes.find((item) => item.deploymentId === selected) ?? routes[0];
 if (!route) return <p>No bridge balances are available yet.</p>;
 return <div className="recon-balances">
 <label className="recon-contract-picker">Bridge contract<select value={route.deploymentId} onChange={(event) => setSelected(event.target.value)}>{routes.map((item) => <option key={item.deploymentId} value={item.deploymentId}>{item.symbol} ↔ {item.wrappedSymbol} · {shortReference(item.wrappedToken)}</option>)}</select></label>
 <p className="history-note">Saved totals cover all loaded requests for this contract.</p>
 <Route route={route} observation={balances[route.deploymentId]} checking={checking === route.deploymentId} busy={loading || !!checking} check={() => { void check(route); }} />
 </div>;
}
