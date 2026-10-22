import { useCallback, useEffect, useRef, useState } from 'react';
import { BITBUS_API_BASE } from '../config/constants';
import { getBitbusHealth, getBitbusAssets, getBitbusTradingPairs } from '../bitbusApi';

const initialState = { loading: true, health: null, assets: null, pairs: null, errors: [], updated: null };

function getHealthDisplay(health, loading) {
	if (loading) return { tone: 'warning', label: 'Checking…' };
	if (!health) return { tone: 'danger', label: 'Unavailable' };
	if (health.status.trim().toLowerCase() === 'ok') {
		return { tone: 'success', label: 'Healthy' };
	}
	// Undocumented API statuses remain visible instead of assuming their meaning.
	return { tone: 'warning', label: health.status.trim() || 'Unknown' };
}

function ResponseDetails({ data }) {
	return <details className="inquiry-response"><summary>View response data</summary><pre className="history-json">{JSON.stringify(data, null, 4)}</pre></details>;
}

export default function InquiryPage() {
	const [state, setState] = useState(initialState);
	const request = useRef(null);

	const loadInquiry = useCallback(async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setState({ ...initialState });
		const results = await Promise.allSettled([
			getBitbusHealth({ signal: controller.signal }),
			getBitbusAssets({ signal: controller.signal }),
			getBitbusTradingPairs({ signal: controller.signal }),
		]);
		if (controller.signal.aborted) return;
		const labels = ['Service health', 'Assets', 'Trading pairs'];
		setState({
			loading: false,
			health: results[0].status === 'fulfilled' ? results[0].value : null,
			assets: results[1].status === 'fulfilled' ? results[1].value : null,
			pairs: results[2].status === 'fulfilled' ? results[2].value : null,
			errors: results.flatMap((result, index) => result.status === 'rejected' ? [`${labels[index]}: ${result.reason.message}`] : []),
			updated: new Date(),
		});
	}, []);

	useEffect(() => {
		void loadInquiry();
		return () => request.current?.abort();
	}, [loadInquiry]);

	const healthDisplay = getHealthDisplay(state.health, state.loading);

	return <section className="card history-card inquiry-page" aria-busy={state.loading}>
		<div className="history-titlebar">
			<div><p className="eyebrow">BITBUS / PUBLIC SERVICE</p><h1>Inquiry</h1><p className="intro">Explore BitBus assets and available trading pairs.</p></div>
			<button type="button" disabled={state.loading} onClick={loadInquiry}>{state.loading ? 'Loading…' : '↻ Refresh'}</button>
		</div>
		<aside className="inquiry-environment"><strong>Public BitBus service · Query only</strong><p>This page reads <code>{BITBUS_API_BASE}</code>. A Devnet endpoint has not been verified. These results are independent of your wallet’s selected network.</p><p>No wallet connection is needed. No orders, signatures or transfers are submitted.</p></aside>
		<div className="history-stats">
			<div><span>Service health</span><strong className={`service-health service-health-${healthDisplay.tone}`} role="status" title={state.health ? `API status: ${state.health.status}` : undefined}>{healthDisplay.label}</strong></div>
			<div><span>Supported assets</span><strong>{state.loading ? '…' : state.assets?.length ?? '—'}</strong></div>
			<div><span>Trading pairs</span><strong>{state.loading ? '…' : state.pairs?.length ?? '—'}</strong></div>
		</div>
		<p className="history-feedback" role="status">{state.loading ? 'Checking BitBus service and loading market data…' : `Last checked: ${state.updated?.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' })} MYT${state.errors.length ? ' · Some requests failed' : ''}`}</p>
		{state.errors.map((error) => <p className="result error" role="alert" key={error}>{error}</p>)}
		{state.health && <ResponseDetails data={state.health} />}
		<section className="inquiry-section" aria-labelledby="inquiry-assets"><h2 id="inquiry-assets">Supported assets</h2><p>Assets reported by the service. Listing does not guarantee a currently executable route.</p>
			{state.assets && <div className="history-scroll" role="region" aria-label="Supported BitBus assets" tabIndex={0}><table className="history-table"><thead><tr><th scope="col">Asset</th><th scope="col">Symbol</th><th scope="col">Blockchain</th><th scope="col">Asset ID</th></tr></thead><tbody>{state.assets.map((asset) => <tr key={asset.id}><td>{asset.name || '—'}</td><td>{asset.symbol || '—'}</td><td>{asset.chain || '—'}</td><td><code>{asset.id}</code></td></tr>)}{!state.assets.length && <tr><td colSpan={4}>No assets returned.</td></tr>}</tbody></table></div>}
			{state.assets && <ResponseDetails data={state.assets} />}
		</section>
		<section className="inquiry-section" aria-labelledby="inquiry-pairs"><h2 id="inquiry-pairs">Trading pairs</h2><p>Active pairs still need a matching quote or counterparty to execute a trade.</p>
			{state.pairs && <div className="history-scroll" role="region" aria-label="BitBus trading pairs" tabIndex={0}><table className="history-table"><thead><tr><th scope="col">Pair</th><th scope="col">Base asset / chain</th><th scope="col">Quote asset / chain</th><th scope="col">Decimals (base / quote)</th><th scope="col">Status</th></tr></thead><tbody>{state.pairs.map((pair) => <tr key={pair.id}><td>{pair.base_asset?.symbol ?? '—'} / {pair.quote_asset?.symbol ?? '—'}</td><td>{pair.base_asset?.name ?? '—'}<small className="inquiry-chain">{pair.base_asset?.chain ?? '—'}</small></td><td>{pair.quote_asset?.name ?? '—'}<small className="inquiry-chain">{pair.quote_asset?.chain ?? '—'}</small></td><td>{pair.base_asset?.decimals ?? '—'} / {pair.quote_asset?.decimals ?? '—'}</td><td><span className={`status-badge ${pair.is_active === true ? 'status-confirmed' : ''}`}>{pair.is_active === true ? 'Active' : pair.is_active === false ? 'Inactive' : 'Unknown'}</span></td></tr>)}{!state.pairs.length && <tr><td colSpan={5}>No trading pairs returned.</td></tr>}</tbody></table></div>}
			{state.pairs && <ResponseDetails data={state.pairs} />}
		</section>
	</section>;
}
