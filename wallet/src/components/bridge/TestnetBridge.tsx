import type { WalletPageProps } from '../../types/wallet';
import WalletConnection from '../WalletConnection';
import useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import { HYPEREVM_TESTNET } from '../../config/hyperevm';
import { formatHypeBalance } from '../../services/evmWallet';
import { formatDateTime } from '../../utils/dateTime';

export default function TestnetBridge({ session, active }: WalletPageProps & { active: boolean }) {
	const evm = useHyperEvmWallet(active);
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
				<h2 id="testnet-bridge-title">Testnet Bridge</h2>
				<p className="intro">Connect both wallets to prepare your TBC → HyperEVM learning bridge.</p>
			</div>
			<span className="network-pill">Test networks only</span>
		</header>
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
		<aside className="testnet-bridge-summary" aria-labelledby="bridge-setup-title">
			<h3 id="bridge-setup-title">{ready ? 'Both wallets are connected' : 'Wallet setup'}</h3>
			<ul>
				<li>TBC Testnet: {session.networkIsDevnet && session.address ? 'connected' : 'connection required'}</li>
				<li>HyperEVM Testnet (998): {correctNetwork ? 'connected' : 'connection required'}</li>
			</ul>
			<p>Wallet setup only. Cross-chain transfers are not available yet. The next step is to define the bridge asset and settlement flow.</p>
			<p>HYPE pays HyperEVM transaction fees. Available balance does not confirm that a future deployment or transfer is affordable; its fee must be estimated first.</p>
		</aside>
	</section>;
}
