import { useEffect, useRef, useState } from 'react';
import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';
import useBridgeFtAsset from '../../hooks/useBridgeFtAsset';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletPageProps } from '../../types/wallet';
import BridgeWalletConnections from './BridgeWalletConnections';
import { ArchivedBridgeRoute, CustodialBridgeV15Transfer } from './BridgeRouteDetails';

export default function TestnetBridge({ session, active }: WalletPageProps & { active: boolean }) {
	const evm = useHyperEvmWallet(active);
	const activeRoute = BRIDGE_ROUTE_CATALOG.find((item) => item.status === 'enabled')!;
	const legacy = BRIDGE_ROUTE_CATALOG.find((item) => item.wrappedSymbol === 'lwFT')!;
	const [selectedRouteId, setSelectedRouteId] = useState<string>(activeRoute.id);
	const [direction, setDirection] = useState<'forward' | 'return'>('forward');
	const route = BRIDGE_ROUTE_CATALOG.find((item) => item.id === selectedRouteId) ?? activeRoute;
	const live = route.status === 'enabled';
	const source = useBridgeFtAsset(session, active && live);
	const loadedWallet = useRef('');
	const autoSelected = useRef('');
	const verifiedSource = useRef('');

	useEffect(() => {
		const wallet = active && live && source.ready ? `${session.address}:${session.backendAuth.ready ? 'authenticated' : 'connecting'}` : '';
		if (!wallet || loadedWallet.current === wallet) return;
		loadedWallet.current = wallet;
		autoSelected.current = '';
		verifiedSource.current = '';
		void source.loadTokens();
	}, [active, live, session.address, session.backendAuth.ready, source.ready]);

	useEffect(() => {
		if (!live || source.loading || source.selected || source.tokens.length !== 1) return;
		const contractId = source.tokens[0].contract_id;
		if (autoSelected.current === contractId) return;
		autoSelected.current = contractId;
		void source.select(contractId);
	}, [live, source.loading, source.selected, source.tokens]);

	useEffect(() => {
		const contractId = source.selected?.contractId ?? '';
		if (!live || !contractId || source.loading || source.verified || source.error || !session.backendAuth.ready || verifiedSource.current === contractId) return;
		verifiedSource.current = contractId;
		void source.verify();
	}, [live, session.backendAuth.ready, source.error, source.loading, source.selected, source.verified]);

	const selectedSource = source.verified ?? source.selected;
	const sourceName = live ? selectedSource?.name ?? route.sourceName : route.sourceName;
	const sourceSymbol = live ? selectedSource?.symbol ?? route.sourceSymbol : route.sourceSymbol;
	const wrappedSymbol = live && selectedSource ? `w${sourceSymbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}` : route.wrappedSymbol;

	return <section className="testnet-bridge" aria-labelledby="testnet-bridge-title">
		<header className="history-titlebar">
			<div>
				<h2 id="testnet-bridge-title">Transfer tokens</h2>
				<p className="intro">Choose a supported TBC token and destination. The verified V1.5 wrapped contract is selected from your saved operator routes.</p>
			</div>
			<span className="network-pill">Test networks only</span>
		</header>
		<section className="htlc-section bridge-route-selection" aria-labelledby="bridge-route-selection-title">
			<h3 id="bridge-route-selection-title">1. Choose token and network</h3>
			<div className="bridge-route-selectors">
				<label htmlFor="bridge-source-token">Send token
					<select id="bridge-source-token" value={live ? source.selected?.contractId ?? '' : route.sourceContractId}
						disabled={!live || !source.ready || source.loading || !source.tokens.length}
						onChange={(event) => { verifiedSource.current = ''; setDirection('forward'); if (event.target.value) void source.select(event.target.value); }}>
						{live ? <>
							<option value="">Choose a TBC Testnet FT</option>
							{source.tokens.map((token) => <option key={token.contract_id} value={token.contract_id}>{token.name || 'Unnamed FT'} ({token.symbol || 'FT'}) · TBC Testnet</option>)}
						</> : <option value={route.sourceContractId}>{route.sourceName} ({route.sourceSymbol}) · TBC Testnet</option>}
					</select>
				</label>
				<label htmlFor="bridge-destination-network">Receive network and bridge version
					<select id="bridge-destination-network" value={route.id} onChange={(event) => { setSelectedRouteId(event.target.value); setDirection('forward'); }}>
						{BRIDGE_ROUTE_CATALOG.filter((item) => item.wrappedSymbol !== legacy.wrappedSymbol).map((item) => <option key={item.id} value={item.id}>
							HyperEVM Testnet · {item.version} · {item.status === 'enabled' ? 'Active route' : 'Archived / view only'}
						</option>)}
					</select>
				</label>
			</div>
			<div className="bridge-route-summary">
				<div><span>Send</span><strong>{sourceSymbol}</strong><small>TBC Testnet</small></div>
				<span className="bridge-route-arrow" aria-hidden="true">→</span>
				<div><span>Receive</span><strong>{wrappedSymbol}</strong><small>HyperEVM Testnet</small></div>
			</div>
			<p className="history-note">{route.version}: {route.description} Fixed conversion route: 1 {sourceSymbol} = 1 {wrappedSymbol}. The legacy {legacy.wrappedSymbol} application route remains disabled.</p>
			{live && source.loading && <p className="history-feedback" role="status">Loading and verifying the selected TBC token…</p>}
			{live && source.error && <><p className="result error" role="alert">{source.error}</p><button type="button" className="history-secondary" disabled={source.loading} onClick={() => {
				if (source.selected) { verifiedSource.current = ''; void source.verify(); }
				else { loadedWallet.current = ''; void source.loadTokens(); }
			}}>Retry token check</button></>}
			{live && source.verified && <p className="result success">{sourceName} ({sourceSymbol}) verified with {source.verified.confirmations.toLocaleString()} confirmations.</p>}
		</section>
		{live && <details className="bridge-flow-history bridge-wallet-setup" open={!session.networkIsDevnet || !evm.networkIsTestnet}>
			<summary>Connect source and receiving wallets</summary>
			<BridgeWalletConnections session={session} evm={evm} />
		</details>}
		{live
			? <CustodialBridgeV15Transfer session={session} evm={evm} asset={source.verified} active={active} direction={direction} onReturn={() => setDirection('return')} />
			: <ArchivedBridgeRoute route={route} />}
	</section>;
}
