import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { VerifiedBridgeAsset } from '../../types/learningBridge';
import type { WalletSession } from '../../types/wallet';
import BridgeOrders from './BridgeOrders';

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

interface CustodialBridgeV15TransferProps {
	session: WalletSession;
	evm: ReturnType<typeof useHyperEvmWallet>;
	asset: VerifiedBridgeAsset | null;
	active: boolean;
	direction: 'forward' | 'return';
	onReturn: () => void;
}

export function CustodialBridgeV15Transfer({ session, evm, asset, active, direction, onReturn }: CustodialBridgeV15TransferProps) {
	return <section className="htlc-section proof-transfer" aria-labelledby="custodial-transfer-title">
		<header className="history-titlebar">
			<div>
				<h3 id="custodial-transfer-title">V1.5 confirmation-based transfer</h3>
				<p>V1.5 uses six source confirmations followed by one limited-relayer mint. V2/V3 proof relays are not part of this route.</p>
			</div>
			<span className="network-pill">V1.5 active route</span>
		</header>
		<dl className="history-detail-grid">
			<div><dt>Source custody</dt><dd>TBC Testnet custody address · backend observes every 60 seconds</dd></div>
			<div><dt>Contract administrator</dt><dd>Offline multisig · role changes and emergency pause only</dd></div>
			<div><dt>Runtime minter</dt><dd>Limited relayer · mint only · no admin or custody key</dd></div>
			<div><dt>Selected source</dt><dd>{asset ? <>{asset.name} ({asset.symbol}) · <code>{asset.contractId}</code></> : 'Choose and verify a TBC Testnet FT above'}</dd></div>
		</dl>
		{!asset && <p className="history-feedback">Choose a source token above and wait for its canonical-chain verification. Its matching saved V1.5 deployment will then be selected automatically.</p>}
		<BridgeOrders session={session} evm={evm} asset={asset} active={active} direction={direction} onReturn={onReturn} />
		<p className="history-note">No user contract deployment and no user HYPE payment. The source wallet pays the TBC transaction fee; the operator relayer pays only the destination mint gas.</p>
	</section>;
}
