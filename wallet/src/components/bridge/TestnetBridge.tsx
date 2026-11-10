import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletPageProps } from '../../types/wallet';
import BridgeWalletConnections from './BridgeWalletConnections';
import ProofBridgeTestnetV3Transfer from './ProofBridgeTestnetV3Transfer';

export default function TestnetBridge({ session, active }: WalletPageProps & { active: boolean }) {
	const evm = useHyperEvmWallet(active);
	const route = BRIDGE_ROUTE_CATALOG.find((item) => item.status === 'enabled')!;
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
				<label htmlFor="bridge-destination-network">Receive network
					<select id="bridge-destination-network" value={route.destinationId} onChange={() => undefined}>
						<option value={route.destinationId}>HyperEVM Testnet · Chain ID {route.destinationChainId}</option>
					</select>
				</label>
			</div>
			<div className="bridge-route-summary">
				<div><span>Send</span><strong>{route.sourceSymbol}</strong><small>TBC Testnet</small></div>
				<span className="bridge-route-arrow" aria-hidden="true">→</span>
				<div><span>Receive</span><strong>{route.wrappedSymbol}</strong><small>HyperEVM Testnet</small></div>
			</div>
			<p className="history-note">Fixed conversion route: 1 {route.sourceSymbol} = 1 {route.wrappedSymbol}. The legacy {legacy.wrappedSymbol} application route is disabled and cannot be selected for a new HyperEVM transfer.</p>
		</section>
		<details className="bridge-flow-history bridge-wallet-setup" open={!session.networkIsDevnet || !evm.networkIsTestnet}>
			<summary>Connect source and receiving wallets</summary>
			<BridgeWalletConnections session={session} evm={evm} />
		</details>
		<ProofBridgeTestnetV3Transfer session={session} evm={evm} active={active} />
	</section>;
}
