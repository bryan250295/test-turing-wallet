import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletSession } from '../../types/wallet';
import { HYPEREVM_TESTNET } from '../../config/hyperevm';
import { formatHypeBalance } from '../../services/evmWallet';
import { formatDateTime } from '../../utils/dateTime';
import WalletConnection from '../WalletConnection';

type EvmWallet = ReturnType<typeof useHyperEvmWallet>;

export default function BridgeWalletConnections({ session, evm }: { session: WalletSession; evm: EvmWallet }) {
	const connected = Boolean(evm.address);
	const correctNetwork = connected && evm.networkIsTestnet;
	const busy = evm.loading || evm.pending !== null;
	const status = evm.loading ? 'Reading wallet…'
		: !evm.detected ? 'MetaMask not detected'
			: evm.error && evm.chainId == null ? 'Wallet details unavailable'
				: !connected ? 'MetaMask not connected'
					: correctNetwork ? 'HyperEVM Testnet connected' : 'Switch to HyperEVM Testnet';

	return <div className="testnet-bridge-wallets">
		<section className="testnet-bridge-wallet" aria-labelledby="bridge-source-wallet-title">
			<p className="eyebrow">SOURCE WALLET</p>
			<h3 id="bridge-source-wallet-title">TBC Testnet</h3>
			<WalletConnection session={session} />
			{!session.networkIsDevnet && <p className="history-feedback">Connect Turing Wallet and select TBC Testnet.</p>}
			{!session.networkIsDevnet && /failed|not detected|did not return/i.test(session.status) && <p className="result error" role="alert">{session.status}</p>}
		</section>
		<section className="testnet-bridge-wallet" aria-labelledby="bridge-destination-wallet-title" aria-busy={busy}>
			<p className="eyebrow">DESTINATION WALLET</p>
			<h3 id="bridge-destination-wallet-title">HyperEVM Testnet</h3>
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
			{evm.balanceWei === '0' && <p className="history-feedback">This wallet has no Testnet HYPE. User deposits do not deploy contracts; the operator relayer pays destination-chain mint gas.</p>}
		</section>
	</div>;
}
