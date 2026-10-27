import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Health } from '../types/api';
import type { WalletPageProps } from '../types/wallet';
import { BITBUS_API_BASE } from '../config/constants';
import useInquiry from '../hooks/useInquiry';
import HtlcTestnet from '../components/bridge/HtlcTestnet';
import HtlcRequests from '../components/bridge/HtlcRequests';
import type { HtlcRecoveryTarget } from '../types/htlc';
import { formatDateTime } from '../utils/dateTime';

function getHealthDisplay(health: Health | null, loading: boolean) {
	if (loading) return { tone: 'warning', label: 'Checking…' };
	if (!health) return { tone: 'danger', label: 'Unavailable' };
	if (health.status.trim().toLowerCase() === 'ok') {
		return { tone: 'success', label: 'Healthy' };
	}
	// Undocumented API statuses remain visible instead of assuming their meaning.
	return { tone: 'warning', label: health.status.trim() || 'Unknown' };
}

const tabs = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'htlc', label: 'HTLC Testnet' },
	{ id: 'requests', label: 'My HTLC Requests' },
] as const;

type BridgeTab = typeof tabs[number]['id'];

export default function BridgeLabPage({ session }: WalletPageProps) {
	const [activeTab, setActiveTab] = useState<BridgeTab>('overview');
	const [recoveryTarget, setRecoveryTarget] = useState<HtlcRecoveryTarget>();

	function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
		const current = tabs.findIndex((tab) => tab.id === activeTab);
		let next: number;
		switch (event.key) {
			case 'ArrowRight': next = (current + 1) % tabs.length; break;
			case 'ArrowLeft': next = (current + tabs.length - 1) % tabs.length; break;
			case 'Home': next = 0; break;
			case 'End': next = tabs.length - 1; break;
			default: return;
		}
		event.preventDefault();
		setActiveTab(tabs[next].id);
		event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#bridge-${tabs[next].id}-tab`)?.focus();
	}

	return (
		<section className="card history-card inquiry-page">
			<p className="eyebrow">BRIDGE LAB</p>
			<h1>Bridge Lab</h1>
			<p className="intro">Explore BitBus data and manage TBC Testnet token locks.</p>
			<div className="page-tabs bridge-lab-tabs" role="tablist" aria-label="Bridge Lab sections">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						id={`bridge-${tab.id}-tab`}
						type="button"
						role="tab"
						className={activeTab === tab.id ? 'selected' : ''}
						aria-selected={activeTab === tab.id}
						aria-controls={`bridge-${tab.id}-panel`}
						tabIndex={activeTab === tab.id ? 0 : -1}
						onClick={() => setActiveTab(tab.id)}
						onKeyDown={handleTabKeyDown}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div id="bridge-overview-panel" role="tabpanel" aria-labelledby="bridge-overview-tab" hidden={activeTab !== 'overview'} tabIndex={0}>
				<BridgeOverview />
			</div>
			<div id="bridge-htlc-panel" role="tabpanel" aria-labelledby="bridge-htlc-tab" hidden={activeTab !== 'htlc'} tabIndex={0}>
				<HtlcTestnet active={activeTab === 'htlc'} session={session} recoveryTarget={recoveryTarget} onViewRequests={() => setActiveTab('requests')} />
			</div>
			<div id="bridge-requests-panel" role="tabpanel" aria-labelledby="bridge-requests-tab" hidden={activeTab !== 'requests'} tabIndex={0}>
				<HtlcRequests session={session} active={activeTab === 'requests'} onRecover={(target) => {
					setRecoveryTarget(target);
					setActiveTab('htlc');
				}} />
			</div>
		</section>
	);
}

function BridgeOverview() {
	const state = useInquiry();

	const healthDisplay = getHealthDisplay(state.health, state.loading);

	return <section aria-label="BitBus overview" aria-busy={state.loading}>
		<div className="history-titlebar">
			<div><h2>BitBus overview</h2><p className="intro">Explore BitBus assets and available trading pairs.</p></div>
			<button type="button" disabled={state.loading} onClick={state.refresh}>{state.loading ? 'Loading…' : '↻ Refresh'}</button>
		</div>
		<aside className="inquiry-environment"><strong>Public BitBus service · Query only</strong><p>This page reads <code>{BITBUS_API_BASE}</code>. A Devnet endpoint has not been verified. These results are independent of your wallet’s selected network.</p><p>No wallet connection is needed. No orders, signatures or transfers are submitted.</p></aside>
		<div className="history-stats">
			<div><span>Service health</span><strong className={`service-health service-health-${healthDisplay.tone}`} role="status" title={state.health ? `API status: ${state.health.status}` : undefined}>{healthDisplay.label}</strong></div>
			<div><span>Supported assets</span><strong>{state.loading ? '…' : state.assets?.length ?? '—'}</strong></div>
			<div><span>Trading pairs</span><strong>{state.loading ? '…' : state.pairs?.length ?? '—'}</strong></div>
		</div>
		<p className="history-feedback" role="status">{state.loading ? 'Checking BitBus service and loading market data…' : `Last checked: ${state.updated ? formatDateTime(state.updated) : 'Unavailable'} MYT${state.errors.length ? ' · Some requests failed' : ''}`}</p>
		{state.errors.map((error) => <p className="result error" role="alert" key={error}>{error}</p>)}
		<section className="inquiry-section" aria-labelledby="inquiry-assets"><h2 id="inquiry-assets">Supported assets</h2><p>Assets reported by the service. Listing does not guarantee a currently executable route.</p>
			{state.assets && <div className="history-scroll" role="region" aria-label="Supported BitBus assets" tabIndex={0}><table className="history-table"><thead><tr><th scope="col">Asset</th><th scope="col">Symbol</th><th scope="col">Blockchain</th><th scope="col">Asset ID</th></tr></thead><tbody>{state.assets.map((asset) => <tr key={asset.id}><td>{asset.name || '—'}</td><td>{asset.symbol || '—'}</td><td>{asset.chain || '—'}</td><td><code>{asset.id}</code></td></tr>)}{!state.assets.length && <tr><td colSpan={4}>No assets returned.</td></tr>}</tbody></table></div>}
		</section>
		<section className="inquiry-section" aria-labelledby="inquiry-pairs"><h2 id="inquiry-pairs">Trading pairs</h2><p>Active pairs still need a matching quote or counterparty to execute a trade.</p>
			{state.pairs && <div className="history-scroll" role="region" aria-label="BitBus trading pairs" tabIndex={0}><table className="history-table"><thead><tr><th scope="col">Pair</th><th scope="col">Base asset / chain</th><th scope="col">Quote asset / chain</th><th scope="col">Decimals (base / quote)</th><th scope="col">Status</th></tr></thead><tbody>{state.pairs.map((pair) => <tr key={pair.id}><td>{pair.base_asset?.symbol ?? '—'} / {pair.quote_asset?.symbol ?? '—'}</td><td>{pair.base_asset?.name ?? '—'}<small className="inquiry-chain">{pair.base_asset?.chain ?? '—'}</small></td><td>{pair.quote_asset?.name ?? '—'}<small className="inquiry-chain">{pair.quote_asset?.chain ?? '—'}</small></td><td>{pair.base_asset?.decimals ?? '—'} / {pair.quote_asset?.decimals ?? '—'}</td><td><span className={`status-badge ${pair.is_active === true ? 'status-confirmed' : ''}`}>{pair.is_active === true ? 'Active' : pair.is_active === false ? 'Inactive' : 'Unknown'}</span></td></tr>)}{!state.pairs.length && <tr><td colSpan={5}>No trading pairs returned.</td></tr>}</tbody></table></div>}
		</section>
	</section>;
}
