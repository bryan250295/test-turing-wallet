import { useSearchParams } from 'react-router-dom';
import type { WalletPageProps } from '../../types/wallet';
import WalletConnection from '../WalletConnection';
import BridgeDeploymentPreview from './BridgeDeploymentPreview';
import BridgeOrders from './BridgeOrders';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeFtAsset from '../../hooks/useBridgeFtAsset';
import { HYPEREVM_TESTNET } from '../../config/hyperevm';
import { BRIDGE_DESTINATIONS } from '../../../../shared/src/config/bridgeRoutes';
import { formatHypeBalance } from '../../services/evmWallet';
import { formatDateTime } from '../../utils/dateTime';
import { formatTokenBalance } from '../../utils/tokenAmounts';

export default function TestnetBridge({ session, active }: WalletPageProps & { active: boolean }) {
	const [params, setParams] = useSearchParams();
	const direction = params.get('direction') === 'return' ? 'return' : 'forward';
	const chooseDirection = (value: 'forward' | 'return') => setParams((previous) => { const next = new URLSearchParams(previous); next.set('direction', value); return next; });
	const evm = useHyperEvmWallet(active);
	const ft = useBridgeFtAsset(session, active);
	const asset = ft.selected;
	const connected = Boolean(evm.address);
	const correctNetwork = connected && evm.networkIsTestnet;
	const ready = session.networkIsDevnet && Boolean(session.address) && correctNetwork && evm.balanceWei != null && !evm.loading;
	const busy = evm.loading || evm.pending !== null;
	const status = evm.loading ? 'Reading wallet…'
		: !evm.detected ? 'MetaMask not detected'
			: evm.error && evm.chainId == null ? 'Wallet details unavailable'
			: !connected ? 'MetaMask not connected'
				: correctNetwork ? 'HyperEVM Testnet connected' : 'Switch to HyperEVM Testnet';

	return <section className="testnet-bridge" aria-labelledby="testnet-bridge-title">
		<header className="history-titlebar">
			<div>
				<h2 id="testnet-bridge-title">Transfer tokens</h2>
				<p className="intro">Send a TBC token to HyperEVM or return wrapped tokens to TBC. Follow one step at a time.</p>
			</div>
			<span className="network-pill">Test networks only</span>
		</header>
		<div className="bridge-direction" role="group" aria-label="Bridge direction">
			<button type="button" aria-pressed={direction === 'forward'} onClick={() => chooseDirection('forward')}>TBC → HyperEVM</button>
			<button type="button" aria-pressed={direction === 'return'} onClick={() => chooseDirection('return')}>HyperEVM → TBC</button>
		</div>
		<details className="bridge-flow-history bridge-wallet-setup" open={!ready || direction === 'forward' && !ft.verified}>
			<summary>1. Connect wallets and choose a token{ready ? ' · wallets connected' : ' · connect both wallets'}</summary>
		<div className="testnet-bridge-wallets">
			<section className="testnet-bridge-wallet" aria-labelledby="bridge-source-title">
				<p className="eyebrow">SOURCE</p>
				<h3 id="bridge-source-title">TBC Testnet</h3>
				<WalletConnection session={session} />
				{!session.networkIsDevnet && <p className="history-feedback">Connect Turing Wallet and select TBC Testnet.</p>}
				{!session.networkIsDevnet && /failed|not detected|did not return/i.test(session.status) && <p className="result error" role="alert">{session.status}</p>}
			</section>
			<section className="testnet-bridge-wallet" aria-labelledby="bridge-destination-title" aria-busy={busy}>
				<p className="eyebrow">DESTINATION</p>
				<h3 id="bridge-destination-title">HyperEVM Testnet</h3>
				<p className="testnet-bridge-status" role="status"><span className={`dot ${correctNetwork ? 'ok' : ''}`} />{status}</p>
				<dl className="wallet-details">
					<div><dt>Wallet</dt><dd>MetaMask</dd></div>
					<div><dt>Network / Chain ID</dt><dd>{evm.chainId == null ? 'Not verified' : `${evm.networkIsTestnet ? HYPEREVM_TESTNET.chainName : 'Different network'} / ${evm.chainId}`}</dd></div>
					<div className="account-detail"><dt>Account</dt><dd><code>{evm.address || 'Not connected'}</code></dd></div>
					<div className="account-detail"><dt>Test HYPE balance</dt><dd>{evm.loading ? 'Loading…' : evm.balanceWei != null ? `${formatHypeBalance(evm.balanceWei)} HYPE` : correctNetwork ? 'Unavailable' : 'Connect on Chain ID 998 to read balance'}</dd></div>
				</dl>
				<div className="htlc-actions">
						<button type="button" disabled={busy} onClick={() => { void evm.connect(); }}>{evm.pending === 'connect' ? 'Check MetaMask…' : connected ? 'Reconnect MetaMask' : 'Connect MetaMask'}</button>
					{evm.detected && evm.chainId != null && !evm.networkIsTestnet && <button type="button" disabled={busy} onClick={() => { void evm.switchNetwork(); }}>{evm.pending === 'switch' ? 'Confirm in MetaMask…' : 'Switch to HyperEVM Testnet'}</button>}
					{evm.detected && <button className="history-secondary" type="button" disabled={busy} onClick={evm.refresh}>Refresh wallet</button>}
				</div>
				{!evm.detected && <p className="history-feedback">Use a browser with the <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">MetaMask extension</a> enabled, then reload this page.</p>}
				{evm.pending && <p className="history-feedback" role="status">Open MetaMask to approve or cancel the request.</p>}
				{evm.error && <p className="result error" role="alert">{evm.error}</p>}
				{evm.checkedAt && <p className="history-feedback">Last read {formatDateTime(new Date(evm.checkedAt))} MYT. Use Refresh wallet to update your balance.</p>}
				{evm.balanceWei === '0' && <p className="history-feedback">Your test HYPE balance is zero. You will need test HYPE for future HyperEVM transaction fees.</p>}
			</section>
		</div>
		<section className="testnet-bridge-route" aria-labelledby="bridge-route-title" aria-busy={ft.loading}>
			<h3 id="bridge-route-title">Select your token</h3>
			<div className="htlc-actions"><button type="button" disabled={!ft.ready || ft.loading || session.busy || busy} onClick={() => { void ft.loadTokens(); }}>{ft.loading ? 'Loading tokens…' : 'Load tokens'}</button></div>
			<label htmlFor="bridge-ft-token">Token to send</label>
			<select id="bridge-ft-token" value={asset?.contractId ?? ''} disabled={!ft.ready || ft.loading || session.busy || busy || !ft.tokens.length} onChange={(event) => { if (event.target.value) void ft.select(event.target.value); }}>
				<option value="" disabled>{ft.loading ? 'Loading tokens…' : 'Choose a token'}</option>
				{ft.tokens.map((token) => <option value={token.contract_id} key={token.contract_id}>{token.name || 'Unnamed FT'} · {formatTokenBalance(token)} {token.symbol || 'FT'} · {token.contract_id}</option>)}
			</select>
			{!ft.ready && <p>Connect Turing Wallet on TBC Testnet, then load your tokens.</p>}
			{ft.ready && !ft.loading && ft.owner && !ft.tokens.length && !ft.error && <p>No tokens found in this wallet.</p>}
			{ft.error && <p className="result error" role="alert">{ft.error}</p>}
			<dl className="history-detail-grid">
				<div><dt>Source asset</dt><dd>{asset ? `${asset.name} (${asset.symbol})` : 'Select a token'} · TBC Testnet</dd></div>
				<div><dt>Token contract</dt><dd><code>{asset?.contractId ?? 'Not selected'}</code></dd></div>
				<div><dt>Destination</dt><dd>HyperEVM Testnet</dd></div>
				<div><dt>Conversion</dt><dd>{asset ? `1 ${asset.symbol} = 1 wrapped token` : '1 source token = 1 wrapped token'}</dd></div>
			</dl>
			{asset && <section className="htlc-section" aria-labelledby="bridge-asset-verification-title">
				<h4 id="bridge-asset-verification-title">Confirm token</h4>
				<button type="button" disabled={!ft.ready || !session.backendAuth.ready || ft.loading || session.busy || busy} onClick={() => { void ft.verify(); }}>{ft.loading ? 'Checking token…' : ft.verified ? 'Verify again' : 'Verify token'}</button>
				{!session.backendAuth.ready && <p className="history-feedback">Click Reconnect and confirm your Turing Wallet login to continue.</p>}

				{ft.verified && <div role="status">
					<p className="history-feedback">Token verified. Continue to your transfer below.</p>
					<p className="history-note">Last verified {formatDateTime(ft.verified.verifiedAt)} MYT.</p>
				</div>}
			</section>}
		</section>
		</details>
		{direction === 'forward' && <section className="htlc-section"><h3>2. Choose destination</h3><label htmlFor="bridge-destination">Receive on</label><select id="bridge-destination" value={998} onChange={() => undefined}>{BRIDGE_DESTINATIONS.map(destination => <option key={destination.id} value={destination.chainId}>{destination.name}</option>)}</select></section>}
        {direction === 'forward' && <details className="bridge-flow-history" open={!!ft.verified}><summary>3. Create or reuse wrapped token</summary>
		<BridgeDeploymentPreview key={ft.verified?.contractId ?? 'no-token'} session={session} evm={evm} asset={ft.verified} active={active && !ft.loading} />
		</details>}
		<BridgeOrders session={session} evm={evm} asset={ft.verified} active={active} direction={direction} onReturn={() => chooseDirection('return')} />
	</section>;
}
