import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import type { WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeFtAsset from '../../hooks/useBridgeFtAsset';
import BridgeDeploymentPreview from './BridgeDeploymentPreview';
import V15MultisigSetup from './V15MultisigSetup';

type EvmWallet = ReturnType<typeof useHyperEvmWallet>;

export default function V15AdminSetup({ session, evm, active }: { session: WalletSession; evm: EvmWallet; active: boolean }) {
	const source = useBridgeFtAsset(session, active);
	const selectedId = source.selected?.contractId ?? '';
	const loadedWallet = useRef('');
	const autoSelected = useRef('');
	const verifiedSource = useRef('');
	const [fixedRoles, setFixedRoles] = useState<{ admin: string; minter: string } | null>(null);

	useEffect(() => {
		const wallet = active && source.ready ? `${session.address}:${session.backendAuth.ready ? 'authenticated' : 'connecting'}` : '';
		if (!wallet || loadedWallet.current === wallet) return;
		loadedWallet.current = wallet;
		autoSelected.current = '';
		verifiedSource.current = '';
		void source.loadTokens();
	}, [active, session.address, session.backendAuth.ready, source.ready]);

	useEffect(() => {
		if (source.loading || source.selected || source.tokens.length !== 1) return;
		const contractId = source.tokens[0].contract_id;
		if (autoSelected.current === contractId) return;
		autoSelected.current = contractId;
		void source.select(contractId);
	}, [source.loading, source.selected, source.tokens]);

	useEffect(() => {
		const contractId = source.selected?.contractId ?? '';
		if (!contractId || source.loading || source.verified || source.error || !session.backendAuth.ready || verifiedSource.current === contractId) return;
		verifiedSource.current = contractId;
		void source.verify();
	}, [session.backendAuth.ready, source.error, source.loading, source.selected, source.verified]);

	return <section className="htlc-section" aria-labelledby="v15-admin-setup-title" aria-busy={source.loading}>
		<header className="history-titlebar"><div><h3 id="v15-admin-setup-title">V1.5 multisig deployments</h3><p>Select a TBC FT and deploy one wrapped contract for that route. Repeat this setup to support additional source tokens.</p></div><span className="network-pill">Operator routes</span></header>
		<ol>
			<li>Choose one source token from the automatically loaded Turing Wallet FT list.</li>
			<li>Verify its genesis, current canonical chain and at least six confirmations.</li>
			<li>Deploy the configured 2-of-2 multisig once; the fixed Admin and Minter roles are then applied automatically.</li>
		</ol>
		<p className="history-note">Multiple sources are supported as separate routes. A source token never shares the same wrapped ERC-20 or reserve accounting with another source token.</p>

		<label htmlFor="v15-source-token">Source token for this route</label>
		<select id="v15-source-token" value={selectedId} disabled={!source.ready || source.loading || session.busy || !source.tokens.length} onChange={(event) => { if (event.target.value) void source.select(event.target.value); }}>
			<option value="">Choose a TBC Testnet FT</option>
			{source.tokens.map((token) => <option key={token.contract_id} value={token.contract_id}>{token.name || 'Unnamed FT'} ({token.symbol || 'FT'}) · {token.contract_id.slice(0, 8)}…{token.contract_id.slice(-6)}</option>)}
		</select>
		{source.loading && !source.tokens.length && <p className="history-feedback" role="status">Loading current-wallet source tokens…</p>}
		{source.ready && source.owner && !source.loading && !source.tokens.length && !source.error && <p className="history-feedback">This wallet has no current-chain FT. <Link to="/wallet">Mint or receive a TBC Testnet token</Link> first.</p>}
		{source.selected && <dl className="history-detail-grid">
			<div><dt>Selected source</dt><dd>{source.selected.name} ({source.selected.symbol}) · <code>{source.selected.contractId}</code></dd></div>
			<div><dt>Destination template</dt><dd>Wrapped {source.selected.name} (w{source.selected.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}) · HyperEVM Testnet 998</dd></div>
		</dl>}
		{source.selected && !source.verified && !source.error && <p className="history-feedback" role="status">Verifying source genesis, canonical chain and confirmations…</p>}
		{source.verified && <p className="result success">{source.verified.name} verified at block {source.verified.genesisBlockHeight.toLocaleString()} with {source.verified.confirmations.toLocaleString()} confirmations. Continue with its V1.5 role review below.</p>}
		{source.error && <><p className="result error" role="alert">{source.error}</p><button type="button" className="history-secondary" disabled={source.loading || session.busy} onClick={() => {
			if (source.selected) { verifiedSource.current = ''; void source.verify(); }
			else { loadedWallet.current = ''; void source.loadTokens(); }
		}}>Retry source check</button></>}
		<V15MultisigSetup session={session} evm={evm} active={active} onReady={(admin, minter) => setFixedRoles(admin && minter ? { admin, minter } : null)} />
		{source.verified && fixedRoles && <BridgeDeploymentPreview key={source.verified.contractId} session={session} evm={evm} asset={source.verified} active={active} v15 fixedRoles={fixedRoles} />}
		{source.verified && !fixedRoles && <p className="history-feedback">Deploy and verify the configured Admin multisig above before preparing the wrapped token.</p>}
	</section>;
}
