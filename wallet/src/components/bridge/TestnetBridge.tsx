import { useEffect, useRef, useState } from 'react';
import { BRIDGE_ROUTE_CATALOG, sepoliaWrappedMetadata } from '../../../../shared/src/config/bridgeRoutes';
import useBridgeFtAsset from '../../hooks/useBridgeFtAsset';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletPageProps } from '../../types/wallet';
import BridgeWalletConnections from './BridgeWalletConnections';
import { ArchivedBridgeRoute, CustodialBridgeV15Transfer } from './BridgeRouteDetails';
import BridgeOrders from './BridgeOrders';
import { loadEthereumSepoliaNativeRoute, type EthereumSepoliaNativeRoute } from '../../services/ethereumSepoliaRoute';
import { getErrorMessage } from '../../utils/errors';

const SEPOLIA_NATIVE_ROUTE = 'ethereum-sepolia-native-tbc-burn-v1';

export default function TestnetBridge({ session, active }: WalletPageProps & { active: boolean }) {
	const activeRoute = BRIDGE_ROUTE_CATALOG.find((item) => item.status === 'enabled')!;
	const legacy = BRIDGE_ROUTE_CATALOG.find((item) => item.wrappedSymbol === 'lwFT')!;
	const [selectedRouteId, setSelectedRouteId] = useState<string>(() => {
		const destination = new URLSearchParams(window.location.search).get('destination');
		if (destination && BRIDGE_ROUTE_CATALOG.some((item) => item.id === destination)) return destination;
		return destination === 'hyperevm' ? activeRoute.id : SEPOLIA_NATIVE_ROUTE;
	});
	const sepoliaSelected = selectedRouteId === SEPOLIA_NATIVE_ROUTE;
	const evm = useHyperEvmWallet(active, sepoliaSelected ? 'sepolia' : 'hyperevm');
	const [sepoliaRoute, setSepoliaRoute] = useState<EthereumSepoliaNativeRoute | null>(null);
	const [sepoliaLoading, setSepoliaLoading] = useState(false);
	const [sepoliaError, setSepoliaError] = useState('');
	const [sepoliaSourceId, setSepoliaSourceId] = useState(() => new URLSearchParams(window.location.search).get('source') || 'native-tbc');
	const [direction, setDirection] = useState<'forward' | 'return'>('forward');
	const route = BRIDGE_ROUTE_CATALOG.find((item) => item.id === selectedRouteId) ?? activeRoute;
	const live = !sepoliaSelected && route.status === 'enabled';
	const routeLive = sepoliaSelected || live;
	const source = useBridgeFtAsset(session, active && routeLive);
	const loadedWallet = useRef('');
	const autoSelected = useRef('');
	const verifiedSource = useRef('');

	useEffect(() => {
		const controller = new AbortController();
		if (!active || !sepoliaSelected || !session.backendAuth.ready) return () => controller.abort();
		setSepoliaLoading(true); setSepoliaError('');
		void loadEthereumSepoliaNativeRoute(AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]))
			.then((value) => { if (!controller.signal.aborted) setSepoliaRoute(value); })
			.catch((cause) => { if (!controller.signal.aborted) { setSepoliaRoute(null); setSepoliaError(getErrorMessage(cause)); } })
			.finally(() => { if (!controller.signal.aborted) setSepoliaLoading(false); });
		return () => controller.abort();
	}, [active, sepoliaSelected, session.address, session.backendAuth.ready]);

	useEffect(() => {
		const wallet = active && routeLive && source.ready ? `${session.address}:${session.backendAuth.ready ? 'authenticated' : 'connecting'}` : '';
		if (!wallet || loadedWallet.current === wallet) return;
		loadedWallet.current = wallet;
		autoSelected.current = '';
		verifiedSource.current = '';
		void source.loadTokens();
	}, [active, routeLive, session.address, session.backendAuth.ready, source.ready]);

	useEffect(() => {
		if (!routeLive || source.loading || source.selected || source.tokens.length !== 1) return;
		const contractId = source.tokens[0].contract_id;
		if (autoSelected.current === contractId) return;
		autoSelected.current = contractId;
		if (sepoliaSelected) setSepoliaSourceId(contractId);
		void source.select(contractId);
	}, [routeLive, sepoliaSelected, source.loading, source.selected, source.tokens]);

	useEffect(() => {
		const contractId = source.selected?.contractId ?? '';
		if (!routeLive || !contractId || sepoliaSelected && sepoliaSourceId === 'native-tbc' || source.loading || source.verified || source.error || !session.backendAuth.ready || verifiedSource.current === contractId) return;
		verifiedSource.current = contractId;
		void source.verify();
	}, [routeLive, sepoliaSelected, sepoliaSourceId, session.backendAuth.ready, source.error, source.loading, source.selected, source.verified]);

	const selectedSource = source.verified ?? source.selected;
	const sepoliaFt = sepoliaSelected && sepoliaSourceId !== 'native-tbc';
	const sourceName = sepoliaSelected ? sepoliaFt ? selectedSource?.name ?? 'Selected FT' : 'Native TBC' : live ? selectedSource?.name ?? route.sourceName : route.sourceName;
	const sourceSymbol = sepoliaSelected ? sepoliaFt ? selectedSource?.symbol ?? 'FT' : 'TBC' : live ? selectedSource?.symbol ?? route.sourceSymbol : route.sourceSymbol;
	const wrappedSymbol = sepoliaSelected ? sepoliaFt && selectedSource ? sepoliaWrappedMetadata(selectedSource.name, selectedSource.symbol).wrappedSymbol : 'wTBC' : live && selectedSource ? `w${sourceSymbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}` : route.wrappedSymbol;
	const nativeAsset = sepoliaRoute ? { contractId: sepoliaRoute.contractId, name: sepoliaRoute.sourceName, symbol: sepoliaRoute.sourceSymbol,
		decimals: sepoliaRoute.decimals, totalSupplyRaw: '21000000000000', verifiedAt: sepoliaRoute.verifiedAt } : null;

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
					<select id="bridge-source-token" value={sepoliaSelected ? sepoliaSourceId : live ? source.selected?.contractId ?? '' : route.sourceContractId}
						disabled={!routeLive || !source.ready || source.loading}
					onChange={(event) => { const next = event.target.value; verifiedSource.current = ''; setDirection('forward'); if (sepoliaSelected) {
						setSepoliaSourceId(next); const url = new URL(window.location.href); url.searchParams.set('source', next); window.history.replaceState(window.history.state, '', url);
					} if (next && next !== 'native-tbc') void source.select(next); }}>
						{sepoliaSelected ? <><option value="native-tbc">Native TBC · TBC Testnet</option>{source.tokens.map((token) => <option key={token.contract_id} value={token.contract_id}>{token.name || 'Unnamed FT'} ({token.symbol || 'FT'}) · TBC Testnet</option>)}</> : live ? <>
							<option value="">Choose a TBC Testnet FT</option>
							{source.tokens.map((token) => <option key={token.contract_id} value={token.contract_id}>{token.name || 'Unnamed FT'} ({token.symbol || 'FT'}) · TBC Testnet</option>)}
						</> : <option value={route.sourceContractId}>{route.sourceName} ({route.sourceSymbol}) · TBC Testnet</option>}
					</select>
				</label>
				<label htmlFor="bridge-destination-network">Receive network and bridge version
					<select id="bridge-destination-network" value={selectedRouteId} onChange={(event) => {
						const next = event.target.value;
						setSelectedRouteId(next); setDirection('forward');
						const url = new URL(window.location.href);
						url.searchParams.set('destination', next === SEPOLIA_NATIVE_ROUTE ? 'sepolia' : next);
						window.history.replaceState(window.history.state, '', url);
					}}>
						<option value={SEPOLIA_NATIVE_ROUTE}>Ethereum Sepolia · custody/mint and burn-return routes</option>
						{BRIDGE_ROUTE_CATALOG.filter((item) => item.wrappedSymbol !== legacy.wrappedSymbol).map((item) => <option key={item.id} value={item.id}>
							HyperEVM Testnet · {item.version} · {item.status === 'enabled' ? 'Active route' : 'Archived / view only'}
						</option>)}
					</select>
				</label>
			</div>
			<div className="bridge-route-summary">
				<div><span>Send</span><strong>{sourceSymbol}</strong><small>TBC Testnet</small></div>
				<span className="bridge-route-arrow" aria-hidden="true">→</span>
				<div><span>Receive</span><strong>{wrappedSymbol}</strong><small>{sepoliaSelected ? 'Ethereum Sepolia' : 'HyperEVM Testnet'}</small></div>
			</div>
			<p className="history-note">{sepoliaSelected ? `${sourceName} is held in a per-order TBC custody output and an equal ${wrappedSymbol} amount is minted on Sepolia. The return direction burns ${wrappedSymbol} before releasing ${sourceSymbol}.` : `${route.version}: ${route.description}`} Fixed conversion route: 1 {sourceSymbol} = 1 {wrappedSymbol}. The legacy {legacy.wrappedSymbol} application route remains disabled.</p>
			{sepoliaLoading && <p className="history-feedback" role="status">Verifying the active Sepolia contract, Admin, minter and native TBC binding…</p>}
			{sepoliaError && <p className="result error" role="alert">{sepoliaError}</p>}
			{sepoliaRoute && !sepoliaFt && <p className="result success">Native TBC → Wrapped TBC route verified on Ethereum Sepolia.</p>}
			{routeLive && source.loading && <p className="history-feedback" role="status">Loading and verifying the selected TBC token…</p>}
			{routeLive && source.error && <><p className="result error" role="alert">{source.error}</p><button type="button" className="history-secondary" disabled={source.loading} onClick={() => {
				if (source.selected) { verifiedSource.current = ''; void source.verify(); }
				else { loadedWallet.current = ''; void source.loadTokens(); }
			}}>Retry token check</button></>}
			{routeLive && (sepoliaFt || !sepoliaSelected) && source.verified && <p className="result success">{sourceName} ({sourceSymbol}) verified with {source.verified.confirmations.toLocaleString()} confirmations.</p>}
		</section>
		{(live || sepoliaSelected) && <details className="bridge-flow-history bridge-wallet-setup" open={!session.networkIsDevnet || !evm.networkIsTestnet}>
			<summary>Connect source and receiving wallets</summary>
			<BridgeWalletConnections session={session} evm={evm} />
		</details>}
		{(live || sepoliaSelected) && <nav className="bridge-direction" aria-label="Bridge transfer direction">
			<button type="button" aria-pressed={direction === 'forward'} onClick={() => setDirection('forward')}>TBC → {sepoliaSelected ? 'Ethereum Sepolia' : 'HyperEVM'}</button>
			<button type="button" aria-pressed={direction === 'return'} onClick={() => setDirection('return')}>{sepoliaSelected ? 'Ethereum Sepolia' : 'HyperEVM'} → TBC</button>
		</nav>}
		{sepoliaSelected ? <section className="htlc-section proof-transfer" aria-labelledby="sepolia-native-transfer-title">
			<header className="history-titlebar"><div><h3 id="sepolia-native-transfer-title">{sourceName} → Ethereum Sepolia</h3><p>Six confirmed {sourceSymbol} deposits mint {wrappedSymbol} through the limited relayer. The verified 2-of-2 Admin cannot mint.</p></div><span className="network-pill">Burn-return route</span></header>
			<BridgeOrders session={session} evm={evm} asset={sepoliaFt ? source.verified : nativeAsset} active={active && (sepoliaFt ? !!source.verified : !!sepoliaRoute)} direction={direction} onReturn={() => setDirection('return')} destinationChainId={11_155_111} governanceMode="ethereum-burn-multisig-v1" />
			<p className="history-note">The source wallet pays only the TBC network fee. The limited operator relayer pays Sepolia mint gas. Do not send a deposit until an order displays its unique custody address.</p>
		</section> : live
			? <CustodialBridgeV15Transfer session={session} evm={evm} asset={source.verified} active={active} direction={direction} onReturn={() => setDirection('return')} />
			: <ArchivedBridgeRoute route={route} />}
	</section>;
}
