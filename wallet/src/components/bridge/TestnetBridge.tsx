import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BRIDGE_ROUTE_CATALOG, sepoliaWrappedMetadata } from '../../../../shared/src/config/bridgeRoutes';
import useBridgeFtAsset from '../../hooks/useBridgeFtAsset';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletPageProps } from '../../types/wallet';
import BridgeWalletConnections from './BridgeWalletConnections';
import { ArchivedBridgeRoute, CustodialBridgeV15Transfer } from './BridgeRouteDetails';
import BridgeOrders from './BridgeOrders';
import { loadEthereumSepoliaNativeRoute, type EthereumSepoliaNativeRoute } from '../../services/ethereumSepoliaRoute';
import { getErrorMessage } from '../../utils/errors';
import type { BridgeOrderDraft } from '../../types/learningBridge';
import { createBridgeOrderDraft } from '../../services/bridgeOrders';

const SEPOLIA_NATIVE_ROUTE = 'ethereum-sepolia-native-tbc-burn-v1';
type WorkflowStep = 1 | 2 | 3 | 4;

export default function TestnetBridge({ session, active, mode = 'selection', draft, initialDirection }: WalletPageProps & { active: boolean; mode?: 'selection' | 'workflow'; draft?: BridgeOrderDraft; initialDirection?: 'forward' | 'return' }) {
	const navigate = useNavigate();
	const activeRoute = BRIDGE_ROUTE_CATALOG.find((item) => item.status === 'enabled')!;
	const legacy = BRIDGE_ROUTE_CATALOG.find((item) => item.wrappedSymbol === 'lwFT')!;
	const [selectedRouteId, setSelectedRouteId] = useState<string>(() => {
		if (draft) return draft.destinationChainId === 11_155_111 ? SEPOLIA_NATIVE_ROUTE : activeRoute.id;
		const destination = new URLSearchParams(window.location.search).get('destination');
		if (destination && BRIDGE_ROUTE_CATALOG.some((item) => item.id === destination)) return destination;
		return destination === 'hyperevm' ? activeRoute.id : SEPOLIA_NATIVE_ROUTE;
	});
	const sepoliaSelected = selectedRouteId === SEPOLIA_NATIVE_ROUTE;
	const evm = useHyperEvmWallet(active, sepoliaSelected ? 'sepolia' : 'hyperevm');
	const [sepoliaRoute, setSepoliaRoute] = useState<EthereumSepoliaNativeRoute | null>(null);
	const [sepoliaLoading, setSepoliaLoading] = useState(false);
	const [sepoliaError, setSepoliaError] = useState('');
	const [sepoliaSourceId, setSepoliaSourceId] = useState(() => draft ? draft.sourceAssetKind === 'native-tbc' ? 'native-tbc' : draft.contractId : new URLSearchParams(window.location.search).get('source') || 'native-tbc');
	const [direction, setDirection] = useState<'forward' | 'return'>(() => initialDirection ?? (new URLSearchParams(window.location.search).get('direction') === 'return' ? 'return' : 'forward'));
	const route = BRIDGE_ROUTE_CATALOG.find((item) => item.id === selectedRouteId) ?? activeRoute;
	const live = !sepoliaSelected && route.status === 'enabled';
	const routeLive = sepoliaSelected || live;
	const source = useBridgeFtAsset(session, active && routeLive);
	const loadedWallet = useRef('');
	const autoSelected = useRef('');
	const verifiedSource = useRef('');
	const draftRequest = useRef({ route: '', id: '' });
	const [draftAction, setDraftAction] = useState('');
	const [draftError, setDraftError] = useState('');
	const [selectedStep, setSelectedStep] = useState<WorkflowStep>(() => draft?.status === 'finalized' ? 4 : 2);
	const [orderCreated, setOrderCreated] = useState(() => draft?.status === 'finalized');
	const savedDraftAsset = draft ? {
		contractId: draft.contractId,
		name: draft.name,
		symbol: draft.symbol,
		decimals: draft.decimals,
		totalSupplyRaw: draft.totalSupplyRaw,
		verifiedAt: draft.verifiedAt,
	} : null;

	useEffect(() => {
		const finalized = draft?.status === 'finalized';
		setOrderCreated(finalized);
		setSelectedStep(finalized ? 4 : 2);
	}, [draft?.id, draft?.status]);

	useEffect(() => {
		if (mode === 'workflow' && initialDirection) setDirection(initialDirection);
	}, [draft?.id, initialDirection, mode]);

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
		const preferred = draft?.contractId ?? (sepoliaSourceId !== 'native-tbc' ? sepoliaSourceId : '');
		if (!routeLive || !preferred || source.loading || source.selected?.contractId === preferred || !source.tokens.some((token) => token.contract_id === preferred)) return;
		void source.select(preferred);
	}, [draft?.contractId, routeLive, sepoliaSourceId, source.loading, source.selected, source.tokens]);

	useEffect(() => {
		if (draft || sepoliaSelected && sepoliaSourceId !== 'native-tbc' || !routeLive || source.loading || source.selected || source.tokens.length !== 1) return;
		const contractId = source.tokens[0].contract_id;
		if (autoSelected.current === contractId) return;
		autoSelected.current = contractId;
		if (sepoliaSelected) setSepoliaSourceId(contractId);
		void source.select(contractId);
	}, [draft, routeLive, sepoliaSelected, sepoliaSourceId, source.loading, source.selected, source.tokens]);

	useEffect(() => {
		const contractId = source.selected?.contractId ?? '';
		if (!routeLive || !contractId || sepoliaSelected && sepoliaSourceId === 'native-tbc' || source.loading || source.verified || source.error || !session.backendAuth.ready || verifiedSource.current === contractId) return;
		verifiedSource.current = contractId;
		void source.verify();
	}, [routeLive, sepoliaSelected, sepoliaSourceId, session.backendAuth.ready, source.error, source.loading, source.selected, source.verified]);

	const selectedSource = savedDraftAsset ?? source.verified ?? source.selected;
	const sepoliaFt = sepoliaSelected && sepoliaSourceId !== 'native-tbc';
	const sepoliaSourceListed = source.tokens.some((token) => token.contract_id === sepoliaSourceId);
	const sourceName = sepoliaSelected ? sepoliaFt ? selectedSource?.name ?? 'Selected FT' : 'Native TBC' : live ? selectedSource?.name ?? route.sourceName : route.sourceName;
	const sourceSymbol = sepoliaSelected ? sepoliaFt ? selectedSource?.symbol ?? 'FT' : 'TBC' : live ? selectedSource?.symbol ?? route.sourceSymbol : route.sourceSymbol;
	const wrappedSymbol = sepoliaSelected ? sepoliaFt ? selectedSource ? sepoliaWrappedMetadata(selectedSource.name, selectedSource.symbol).wrappedSymbol : 'wFT' : 'wTBC' : live && selectedSource ? `w${sourceSymbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}` : route.wrappedSymbol;
	const nativeAsset = sepoliaRoute ? { contractId: sepoliaRoute.contractId, name: sepoliaRoute.sourceName, symbol: sepoliaRoute.sourceSymbol,
		decimals: sepoliaRoute.decimals, totalSupplyRaw: '21000000000000', verifiedAt: sepoliaRoute.verifiedAt } : null;
	const transferAsset = sepoliaSelected ? sepoliaFt ? savedDraftAsset ?? source.verified : savedDraftAsset ?? nativeAsset : savedDraftAsset ?? source.verified;
	const walletsReady = !!session.address && session.networkIsDevnet && session.backendAuth.ready && !!evm.address && evm.networkIsTestnet;
	const selectionReady = draft ? true : sepoliaSelected ? sepoliaFt ? !!source.verified : !!sepoliaRoute : live && !!source.verified;
	async function proceed() {
		const contractId = sepoliaSelected && !sepoliaFt ? sepoliaRoute?.contractId : source.verified?.contractId;
		if (!selectionReady || !contractId || draftAction) return;
		const routeKey = `${contractId}:${sepoliaSelected ? 11_155_111 : 998}`;
		if (draftRequest.current.route !== routeKey) draftRequest.current = { route: routeKey, id: crypto.randomUUID() };
		setDraftAction('Creating saved transfer…'); setDraftError('');
		try {
			const saved = await createBridgeOrderDraft({ idempotencyKey: draftRequest.current.id, contractId, destinationChainId: sepoliaSelected ? 11_155_111 : 998 }, AbortSignal.timeout(30_000));
			navigate(`/create_bridging_order/${saved.id}`);
		} catch (cause) { setDraftError(`${getErrorMessage(cause)} Retry Proceed safely; the same request ID will be reused.`); }
		finally { setDraftAction(''); }
	}
	function changeDirection(next: 'forward' | 'return') {
		setDirection(next);
		if (mode === 'workflow') {
			const url = new URL(window.location.href); url.searchParams.set('direction', next); window.history.replaceState(window.history.state, '', url);
		}
	}
	function openWorkflowStep(step: WorkflowStep) {
		if (step === 3 && !walletsReady || step === 4 && !orderCreated) return;
		setSelectedStep(step);
	}
	function workflowStepClass(step: WorkflowStep, completed: boolean) {
		return selectedStep === step ? 'current' : completed ? 'done' : '';
	}
	function markOrderCreated() {
		setOrderCreated(true);
		setDirection('forward');
		setSelectedStep(4);
	}
	function markOrderAvailable() {
		setOrderCreated(true);
	}
	const routeSelectors = <div className="bridge-route-selectors">
		<label htmlFor="bridge-source-token">What do you want to send?
			<select id="bridge-source-token" value={sepoliaSelected ? sepoliaSourceId : live ? draft?.contractId ?? source.selected?.contractId ?? '' : route.sourceContractId}
				disabled={mode === 'workflow' || !routeLive || !source.ready || source.loading}
				onChange={(event) => { const next = event.target.value; verifiedSource.current = ''; changeDirection('forward'); if (sepoliaSelected) {
					setSepoliaSourceId(next); const url = new URL(window.location.href); url.searchParams.set('source', next); window.history.replaceState(window.history.state, '', url);
				} if (next && next !== 'native-tbc') void source.select(next); }}>
				{sepoliaSelected ? <>
					<option value="native-tbc">Native TBC · TBC Testnet</option>
					{sepoliaFt && !sepoliaSourceListed && <option value={sepoliaSourceId}>{savedDraftAsset ? `${savedDraftAsset.name} (${savedDraftAsset.symbol}) · saved route` : 'Selected TBC token · verification required'}</option>}
					{source.tokens.map((token) => <option key={token.contract_id} value={token.contract_id}>{token.name || 'Unnamed FT'} ({token.symbol || 'FT'}) · TBC Testnet</option>)}
				</> : live ? <>
					<option value="">Choose a TBC Testnet token</option>
					{draft && !source.tokens.some((token) => token.contract_id === draft.contractId) && <option value={draft.contractId}>{draft.name} ({draft.symbol}) · saved route</option>}
					{source.tokens.map((token) => <option key={token.contract_id} value={token.contract_id}>{token.name || 'Unnamed FT'} ({token.symbol || 'FT'}) · TBC Testnet</option>)}
				</> : <option value={route.sourceContractId}>{route.sourceName} ({route.sourceSymbol}) · TBC Testnet</option>}
			</select>
		</label>
		<label htmlFor="bridge-destination-network">Where do you want to receive it?
			<select id="bridge-destination-network" value={selectedRouteId} disabled={mode === 'workflow'} onChange={(event) => {
				const next = event.target.value;
				setSelectedRouteId(next); changeDirection('forward');
				const url = new URL(window.location.href);
				url.searchParams.set('destination', next === SEPOLIA_NATIVE_ROUTE ? 'sepolia' : next);
				window.history.replaceState(window.history.state, '', url);
			}}>
				<option value={SEPOLIA_NATIVE_ROUTE}>Ethereum Sepolia</option>
				{BRIDGE_ROUTE_CATALOG.filter((item) => item.wrappedSymbol !== legacy.wrappedSymbol).map((item) => <option key={item.id} value={item.id}>
					HyperEVM Testnet · {item.status === 'enabled' ? 'Available' : 'View only'}
				</option>)}
			</select>
		</label>
	</div>;
	const routeSummary = <>
		<div className="bridge-route-summary" aria-label="Selected bridge route">
			<div><span>You send</span><strong>{sourceSymbol}</strong><small>TBC Testnet</small></div>
			<span className="bridge-route-arrow" aria-hidden="true">→</span>
			<div><span>You receive</span><strong>{wrappedSymbol}</strong><small>{sepoliaSelected ? 'Ethereum Sepolia' : 'HyperEVM Testnet'}</small></div>
		</div>
		<ul className="bridge-route-facts">
			<li><strong>1:1 conversion</strong><span>1 {sourceSymbol} becomes 1 {wrappedSymbol}</span></li>
			<li><strong>Saved progress</strong><span>You can close the page and continue later</span></li>
			<li><strong>Return supported</strong><span>{sepoliaSelected ? `Burn ${wrappedSymbol} to release ${sourceSymbol}` : `Lock ${wrappedSymbol} to release ${sourceSymbol}`}</span></li>
		</ul>
	</>;
	const verification = <>
		{sepoliaLoading && <p className="history-feedback" role="status">Checking the Ethereum Sepolia route…</p>}
		{sepoliaError && <p className="result error" role="alert">{sepoliaError}</p>}
		{sepoliaRoute && !sepoliaFt && <p className="result success">Route ready: Native TBC → Wrapped TBC on Ethereum Sepolia.</p>}
		{routeLive && source.loading && <p className="history-feedback" role="status">Loading and verifying your selected TBC token…</p>}
		{routeLive && source.error && <><p className="result error" role="alert">{source.error}</p><button type="button" className="history-secondary" disabled={source.loading} onClick={() => {
			if (source.selected) { verifiedSource.current = ''; void source.verify(); }
			else { loadedWallet.current = ''; void source.loadTokens(); }
		}}>Retry token check</button></>}
		{routeLive && (sepoliaFt || !sepoliaSelected) && source.verified && <p className="result success">{sourceName} ({sourceSymbol}) is verified and ready to bridge.</p>}
	</>;

	if (mode === 'selection') return <section className="testnet-bridge bridge-transfer-start" aria-labelledby="testnet-bridge-title">
		<header className="history-titlebar bridge-start-heading">
			<div><p className="eyebrow">NEW TRANSFER</p><h2 id="testnet-bridge-title">Choose what you want to move</h2><p className="intro">Select a token and destination first. Wallet confirmation and payment happen on the next page.</p></div>
			<span className="network-pill">Test networks only</span>
		</header>
		<section className="bridge-selector-card" aria-labelledby="bridge-route-selection-title">
			<div className="bridge-section-heading"><div><span className="bridge-step-badge">ROUTE</span><h3 id="bridge-route-selection-title">Select token and network</h3></div><span className={selectionReady ? 'bridge-ready' : 'bridge-waiting'}>{selectionReady ? 'Ready' : 'Checking'}</span></div>
			{routeSelectors}
			{routeSummary}
			{verification}
			{draftError && <p className="result error" role="alert">{draftError}</p>}
			<div className="bridge-start-actions">
				<button type="button" className="bridge-proceed" disabled={!selectionReady || !!draftAction} onClick={() => { void proceed(); }}>{draftAction || 'Proceed to bridge'}</button>
				<p>{selectionReady ? 'Proceed creates a saved transfer ID, then opens its guided page.' : 'Connect Turing Wallet and wait for route verification before continuing.'}</p>
			</div>
		</section>
		<div className="bridge-start-help"><div><strong>No payment yet</strong><span>Proceed saves the route and transfer ID only.</span></div><div><strong>Already started?</strong><Link to="/bridge-lab?tab=reconciliation">Continue from Reconciliation</Link></div></div>
	</section>;

	if (initialDirection === 'return' && sepoliaSelected) return <section className="testnet-bridge bridge-return-workflow" aria-label="Return wrapped tokens to TBC">
		<BridgeOrders session={session} evm={evm} asset={transferAsset} active={active} direction="return" onReturn={() => undefined} destinationChainId={11_155_111} governanceMode="ethereum-burn-multisig-v1" orderId={draft?.id} stage="transfer" compactReturn />
	</section>;

	return <section className="testnet-bridge bridge-order-workflow" aria-label="Create bridging order">
		<ol className="bridge-workflow-steps" aria-label="Create bridge order steps" role="tablist">
			<li role="presentation" className={workflowStepClass(1, true)}><button type="button" className="bridge-workflow-step" role="tab" aria-selected={selectedStep === 1} aria-controls="bridge-workflow-panel" onClick={() => openWorkflowStep(1)}><span>1</span><div><strong>Route</strong><small>{sourceSymbol} to {wrappedSymbol}</small></div></button></li>
			<li role="presentation" className={workflowStepClass(2, walletsReady)}><button type="button" className="bridge-workflow-step" role="tab" aria-selected={selectedStep === 2} aria-controls="bridge-workflow-panel" onClick={() => openWorkflowStep(2)}><span>2</span><div><strong>Wallets</strong><small>Connect both accounts</small></div></button></li>
			<li role="presentation" className={workflowStepClass(3, orderCreated)}><button type="button" className="bridge-workflow-step" role="tab" aria-selected={selectedStep === 3} aria-controls="bridge-workflow-panel" disabled={!walletsReady} onClick={() => openWorkflowStep(3)}><span>3</span><div><strong>Order</strong><small>Amount and recipient</small></div></button></li>
			<li role="presentation" className={workflowStepClass(4, false)}><button type="button" className="bridge-workflow-step" role="tab" aria-selected={selectedStep === 4} aria-controls="bridge-workflow-panel" disabled={!orderCreated} onClick={() => openWorkflowStep(4)}><span>4</span><div><strong>Transfer</strong><small>Pay and receive</small></div></button></li>
		</ol>
		{selectedStep === 1 && <section id="bridge-workflow-panel" className="bridge-workflow-stage bridge-route-review" role="tabpanel" aria-labelledby="workflow-route-title">
			<div className="bridge-section-heading"><div><span className="bridge-step-badge bridge-step-done">Route saved</span><h2 id="workflow-route-title">Review route</h2></div>{draft && <code className="bridge-order-id">{draft.id}</code>}</div>
			{routeSelectors}
			{routeSummary}
			{verification}
			<div className="bridge-stage-actions"><button type="button" onClick={() => openWorkflowStep(2)}>Continue to wallets</button></div>
		</section>}
		{selectedStep === 2 && (live || sepoliaSelected) && <section id="bridge-workflow-panel" className="bridge-workflow-stage" role="tabpanel" aria-labelledby="workflow-wallets-title">
			<div className="bridge-section-heading"><div><span className="bridge-step-badge">Step 2</span><h2 id="workflow-wallets-title">Connect both wallets</h2><p>Use Turing Wallet to send, and MetaMask to receive.</p></div></div>
			<BridgeWalletConnections session={session} evm={evm} />
			<div className="bridge-stage-actions"><button type="button" disabled={!walletsReady} onClick={() => openWorkflowStep(3)}>Continue to order</button><p>{walletsReady ? 'Both wallets are ready.' : 'Connect both wallets on the required test networks to continue.'}</p></div>
		</section>}
		{selectedStep === 3 && <section id="bridge-workflow-panel" className="bridge-workflow-stage proof-transfer" role="tabpanel" aria-labelledby="bridge-order-step-title">
			<header className="history-titlebar"><div><span className="bridge-step-badge">Step 3</span><h2 id="bridge-order-step-title">Create your order</h2><p>Set the amount and receiving account, review them, then save this transfer.</p></div><span className="network-pill">No payment yet</span></header>
			<BridgeOrders session={session} evm={evm} asset={transferAsset} active={active} direction="forward" onReturn={() => changeDirection('return')} destinationChainId={sepoliaSelected ? 11_155_111 : 998} governanceMode={sepoliaSelected ? 'ethereum-burn-multisig-v1' : 'multisig-relayer-v1.5'} orderId={draft?.id} stage="order" onOrderSaved={markOrderCreated} onContinueTransfer={() => setSelectedStep(4)} />
		</section>}
		{selectedStep === 4 && sepoliaSelected ? <section id="bridge-workflow-panel" className="bridge-workflow-stage proof-transfer" role="tabpanel" aria-labelledby="sepolia-native-transfer-title">
			<header className="history-titlebar"><div><span className="bridge-step-badge">Step 4</span><h2 id="sepolia-native-transfer-title">Complete your transfer</h2><p>Follow the highlighted wallet action. Six confirmations are required on each chain.</p></div><span className="network-pill">Burn-return route</span></header>
			<nav className="bridge-direction" aria-label="Bridge transfer direction">
				<button type="button" aria-pressed={direction === 'forward'} onClick={() => changeDirection('forward')}>Send to Ethereum Sepolia</button>
				<button type="button" aria-pressed={direction === 'return'} onClick={() => changeDirection('return')}>Return to TBC</button>
			</nav>
			<BridgeOrders session={session} evm={evm} asset={transferAsset} active={active} direction={direction} onReturn={() => changeDirection('return')} destinationChainId={11_155_111} governanceMode="ethereum-burn-multisig-v1" orderId={draft?.id} stage="transfer" onOrderAvailable={markOrderAvailable} onBackToOrder={() => setSelectedStep(3)} />
			<p className="history-note">The source wallet pays only the TBC network fee. The limited operator relayer pays Sepolia mint gas. Do not send a deposit until an order displays its unique custody address.</p>
		</section> : selectedStep === 4 && live
			? <section id="bridge-workflow-panel" className="bridge-workflow-stage" role="tabpanel"><nav className="bridge-direction" aria-label="Bridge transfer direction">
				<button type="button" aria-pressed={direction === 'forward'} onClick={() => changeDirection('forward')}>Send to HyperEVM</button>
				<button type="button" aria-pressed={direction === 'return'} onClick={() => changeDirection('return')}>Return to TBC</button>
			</nav><CustodialBridgeV15Transfer session={session} evm={evm} asset={transferAsset} active={active} direction={direction} onReturn={() => changeDirection('return')} orderId={draft?.id} stage="transfer" onOrderAvailable={markOrderAvailable} onBackToOrder={() => setSelectedStep(3)} /></section>
			: selectedStep === 4 ? <ArchivedBridgeRoute route={route} /> : null}
	</section>;
}
