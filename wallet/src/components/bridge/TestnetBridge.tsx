import { useState } from 'react';
import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletPageProps } from '../../types/wallet';
import BridgeWalletConnections from './BridgeWalletConnections';
import { ArchivedBridgeRoute, CustodialBridgeV15Transfer } from './BridgeRouteDetails';

export default function TestnetBridge({ session, active }: WalletPageProps & { active: boolean }) {
	const evm = useHyperEvmWallet(active);
	const activeRoute = BRIDGE_ROUTE_CATALOG.find((item) => item.status === 'enabled')!;
	const [selectedRouteId, setSelectedRouteId] = useState<string>(activeRoute.id);
	const route = BRIDGE_ROUTE_CATALOG.find((item) => item.id === selectedRouteId) ?? activeRoute;
	const legacy = BRIDGE_ROUTE_CATALOG.find((item) => item.wrappedSymbol === 'lwFT')!;

	return <section className="testnet-bridge" aria-labelledby="testnet-bridge-title">
		<header className="history-titlebar">
			<div>
				<h2 id="testnet-bridge-title">Transfer tokens</h2>
				<p className="intro">Choose a supported TBC token and destination. The shared contracts are already selected; users never deploy a wrapped token for each transfer.</p>
			</div>
			<span className="network-pill">Test networks only</span>
		</header>
		<section className="htlc-section bridge-route-selection" aria-labelledby="bridge-route-selection-title">
			<h3 id="bridge-route-selection-title">1. Choose token and network</h3>
			<div className="bridge-route-selectors">
				<label htmlFor="bridge-source-token">Send token
					<select id="bridge-source-token" value={route.id} onChange={() => undefined}>
						<option value={route.id}>{route.sourceName} ({route.sourceSymbol}) · TBC Testnet</option>
					</select>
				</label>
				<label htmlFor="bridge-destination-network">Receive network and bridge version
					<select id="bridge-destination-network" value={route.id} onChange={(event) => setSelectedRouteId(event.target.value)}>
						{BRIDGE_ROUTE_CATALOG.filter((item) => item.wrappedSymbol !== legacy.wrappedSymbol).map((item) => <option key={item.id} value={item.id}>
							HyperEVM Testnet · {item.version} · {item.status === 'enabled' ? 'Active route' : 'Archived / view only'}
						</option>)}
					</select>
				</label>
			</div>
			<div className="bridge-route-summary">
				<div><span>Send</span><strong>{route.sourceSymbol}</strong><small>TBC Testnet</small></div>
				<span className="bridge-route-arrow" aria-hidden="true">→</span>
				<div><span>Receive</span><strong>{route.wrappedSymbol}</strong><small>HyperEVM Testnet</small></div>
			</div>
			<p className="history-note">{route.version}: {route.description} Fixed conversion route: 1 {route.sourceSymbol} = 1 {route.wrappedSymbol}. The legacy {legacy.wrappedSymbol} application route remains disabled.</p>
		</section>
		{route.status === 'enabled' && <details className="bridge-flow-history bridge-wallet-setup" open={!session.networkIsDevnet || !evm.networkIsTestnet}>
			<summary>Connect source and receiving wallets</summary>
			<BridgeWalletConnections session={session} evm={evm} />
		</details>}
		{route.status === 'enabled' ? <CustodialBridgeV15Transfer route={route} /> : <ArchivedBridgeRoute route={route} />}
	</section>;
}
