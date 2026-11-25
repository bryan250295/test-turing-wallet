import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletSession } from '../../types/wallet';
import BridgeWalletConnections from './BridgeWalletConnections';
import EthereumBurnAdminSetup from './EthereumBurnAdminSetup';
import { ArchivedBridgeRoute } from './BridgeRouteDetails';
import V15AdminSetup from './V15AdminSetup';

export default function BridgeAdmin({ session, active }: { session: WalletSession; active: boolean }) {
	const evm = useHyperEvmWallet(active);
	const enabled = BRIDGE_ROUTE_CATALOG.find((route) => route.status === 'enabled')!;
	const archived = BRIDGE_ROUTE_CATALOG.filter((route) => route.status === 'archived');

	return <section className="bridge-admin" aria-labelledby="bridge-admin-title">
		<header className="history-titlebar">
			<div><h2 id="bridge-admin-title">Bridge administration</h2><p className="intro">Prepare the shared V1.5 wrapped-token route and inspect retired proof contracts. This is operator setup, not a user transfer step.</p></div>
			<span className="network-pill">Operator only</span>
		</header>
		<aside><strong>V1.5 authority policy.</strong> Each reviewed source FT has its own wrapped contract. Every contract owner must be an offline multisig; its hot relayer receives mint-only authority and never holds the Admin or custody key.</aside>
		<section className="htlc-section" aria-labelledby="admin-route-catalog-title">
			<h3 id="admin-route-catalog-title">Route catalog</h3>
			<div className="bridge-route-catalog">
				{BRIDGE_ROUTE_CATALOG.map((route) => <article className={`bridge-route-card route-${route.status}`} key={route.id}>
					<header><strong>{route.status === 'enabled' ? `${route.version} · selectable FT → dedicated wrapped FT` : `${route.version} · ${route.sourceSymbol} → ${route.wrappedSymbol}`}</strong><span className={`status-badge ${route.status === 'enabled' ? 'status-confirmed' : ''}`}>{route.status === 'enabled' ? 'Active design' : route.status === 'archived' ? 'Read only' : 'Disabled'}</span></header>
					<p>TBC Testnet → HyperEVM Testnet (998) · {route.protocol}</p>
					<code>{route.status === 'enabled' ? 'Source chosen and verified below' : route.sourceContractId}</code>
					<p className="history-note">{route.description}</p>
				</article>)}
			</div>
			<label htmlFor="admin-route-template">Deployment version</label>
			<select id="admin-route-template" value={enabled.id} onChange={() => undefined}>
				<option value={enabled.id}>{enabled.version} · Selectable TBC FT → dedicated wrapped FT · Active</option>
				{archived.map((route) => <option key={route.id} value={route.id} disabled>{route.version} · {route.sourceSymbol} → {route.wrappedSymbol} · Read only</option>)}
			</select>
			<p className="history-note">V1.5 is selected above and is the only deployable version. V2/V3 stay visible as disabled, read-only history.</p>
		</section>
		<EthereumBurnAdminSetup session={session} active={active} />
		<section className="htlc-section" aria-labelledby="admin-wallets-title">
			<h3 id="admin-wallets-title">Operator wallets</h3>
			<BridgeWalletConnections session={session} evm={evm} />
		</section>
		<V15AdminSetup session={session} evm={evm} active={active} />
		<details className="bridge-flow-history">
			<summary>Archived proof-backed contracts ({archived.length}) · read only</summary>
			{archived.map((route) => <ArchivedBridgeRoute key={route.id} route={route} />)}
		</details>
	</section>;
}
