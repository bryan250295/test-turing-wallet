import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';

type Route = typeof BRIDGE_ROUTE_CATALOG[number];

function ContractRow({ label, value }: { label: string; value: string | null }) {
	return <div><dt>{label}</dt><dd><code>{value ?? 'Not used / not deployed'}</code></dd></div>;
}

export function ArchivedBridgeRoute({ route }: { route: Route }) {
	return <section className="htlc-section archived-bridge-route" aria-labelledby="archived-route-title">
		<header className="history-titlebar">
			<div>
				<h3 id="archived-route-title">{route.version} contract archive</h3>
				<p>{route.description}</p>
			</div>
			<span className="network-pill route-archived">Read only</span>
		</header>
		<p className="result warning"><strong>New transfers are disabled.</strong> These contracts remain visible for historical receipts and technical review. Selecting this entry never opens a wallet request or broadcasts a transaction.</p>
		<dl className="history-detail-grid">
			<div><dt>Protocol</dt><dd>{route.protocol}</dd></div>
			<div><dt>Source token</dt><dd>{route.sourceName} ({route.sourceSymbol}) · <code>{route.sourceContractId}</code></dd></div>
			<ContractRow label="Header Relay" value={route.contracts.relay} />
			<ContractRow label="Gateway" value={route.contracts.gateway} />
			<ContractRow label="Wrapped token" value={route.contracts.wrappedToken} />
		</dl>
	</section>;
}

export function CustodialBridgeV15Transfer({ route }: { route: Route }) {
	return <section className="htlc-section proof-transfer" aria-labelledby="custodial-transfer-title">
		<header className="history-titlebar">
			<div>
				<h3 id="custodial-transfer-title">2. Send MT and receive wMT</h3>
				<p>V1.5 uses six source confirmations followed by one limited relayer mint. V2/V3 proof relays are not part of this route.</p>
			</div>
			<span className="network-pill">V1.5 setup</span>
		</header>
		<dl className="history-detail-grid">
			<div><dt>Source custody</dt><dd>TBC Testnet custody address · backend observes every 60 seconds</dd></div>
			<div><dt>Contract administrator</dt><dd>Offline multisig · role changes and emergency pause only</dd></div>
			<div><dt>Runtime minter</dt><dd>Limited relayer · mint only · no admin or custody key</dd></div>
			<div><dt>Wrapped token</dt><dd>{route.contracts.wrappedToken ? <code>{route.contracts.wrappedToken}</code> : 'A new V1.5 wMT contract must be deployed once'}</dd></div>
		</dl>
		{!route.contracts.wrappedToken && <p className="result warning"><strong>Operator setup required.</strong> Transfer is intentionally unavailable until Admin registers a separately deployed V1.5 wMT contract whose owner is the reviewed multisig and whose minter is the limited relayer. The archived V2/V3 wMT contracts cannot be reused because their mint authority is permanently bound to their proof Gateways.</p>}
		<div className="htlc-actions"><button type="button" disabled>{route.contracts.wrappedToken ? 'Start V1.5 transfer' : 'Waiting for V1.5 Admin setup'}</button></div>
		<p className="history-note">No user contract deployment and no user HYPE payment. The source wallet pays the TBC transaction fee; the operator relayer pays only the destination mint gas.</p>
	</section>;
}
