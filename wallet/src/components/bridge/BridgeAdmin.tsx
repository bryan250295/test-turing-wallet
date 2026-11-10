import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletSession } from '../../types/wallet';
import BridgeWalletConnections from './BridgeWalletConnections';
import ProofBridgeTestnetV3Setup from './ProofBridgeTestnetV3Setup';

export default function BridgeAdmin({ session, active }: { session: WalletSession; active: boolean }) {
	const evm = useHyperEvmWallet(active);
	const enabled = BRIDGE_ROUTE_CATALOG.find((route) => route.status === 'enabled')!;

	return <section className="bridge-admin" aria-labelledby="bridge-admin-title">
		<header className="history-titlebar">
			<div><h2 id="bridge-admin-title">Bridge administration</h2><p className="intro">Deploy and register shared wrapped-token infrastructure. This is operator setup, not a step for each user or mint.</p></div>
			<span className="network-pill">Operator only</span>
		</header>
		<aside><strong>Shared deployment policy.</strong> One verified route serves every user. Deploying another contract does not upgrade an existing route and must never be presented as a normal transfer step.</aside>
		<section className="htlc-section" aria-labelledby="admin-route-catalog-title">
			<h3 id="admin-route-catalog-title">Route catalog</h3>
			<div className="bridge-route-catalog">
				{BRIDGE_ROUTE_CATALOG.map((route) => <article className={`bridge-route-card route-${route.status}`} key={route.id}>
					<header><strong>{route.sourceSymbol} → {route.wrappedSymbol}</strong><span className={`status-badge ${route.status === 'enabled' ? 'status-confirmed' : ''}`}>{route.status === 'enabled' ? 'Enabled' : 'Disabled'}</span></header>
					<p>TBC Testnet → HyperEVM Testnet (998)</p>
					<code>{route.sourceContractId}</code>
					{route.status === 'disabled' && <p className="history-note">Historical legacy route only. It cannot create new transfers and may be assigned to a different network in a later reviewed release.</p>}
				</article>)}
			</div>
			<label htmlFor="admin-route-template">Prepared deployment template</label>
			<select id="admin-route-template" value={enabled.id} onChange={() => undefined}>
				<option value={enabled.id}>{enabled.sourceName} ({enabled.sourceSymbol}) → {enabled.wrappedName} ({enabled.wrappedSymbol}) · HyperEVM Testnet</option>
			</select>
			<p className="history-note">Only audited templates can be deployed. Arbitrary source contracts, networks and wrapped-token bytecode are not accepted from form input.</p>
		</section>
		<section className="htlc-section" aria-labelledby="admin-wallets-title">
			<h3 id="admin-wallets-title">Operator wallets</h3>
			<BridgeWalletConnections session={session} evm={evm} />
		</section>
		<ProofBridgeTestnetV3Setup session={session} evm={evm} active={active} />
	</section>;
}
