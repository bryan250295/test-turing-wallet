import type { WalletPageProps } from '../types/wallet';

export default function WalletConnection({ session }: WalletPageProps) {
	const { address, network, walletInfo, networkIsDevnet, busy, connect } = session;
	const walletName = typeof walletInfo?.walletName === 'string'
		? walletInfo.walletName
		: typeof walletInfo?.name === 'string' ? walletInfo.name : 'Turing Wallet';
	const walletVersion = typeof walletInfo?.version === 'string' || typeof walletInfo?.version === 'number'
		? walletInfo.version
		: null;
	const networkLabel = network
		? [network.network, network.type].filter(Boolean).join(' / ') || 'Connected'
		: 'Not connected';
	return (
		<div className="connection">
			<div className="connection-info">
				<strong><span className={`dot ${networkIsDevnet ? 'ok' : ''}`} />{networkIsDevnet ? 'TBC Devnet connected' : 'Wallet not connected to Devnet'}</strong>
				<dl className="wallet-details">
					<div><dt>Wallet</dt><dd>{walletName}</dd></div>
					<div><dt>Network</dt><dd>{networkLabel}</dd></div>
					<div className="account-detail"><dt>Account</dt><dd><code title={address}>{address || 'Not connected'}</code></dd></div>
					{walletVersion !== null && <div><dt>Version</dt><dd>{walletVersion}</dd></div>}
				</dl>
			</div>
			<button type="button" onClick={connect} disabled={busy}>
				{busy ? 'Working…' : address ? 'Reconnect' : 'Connect wallet'}
			</button>
		</div>
	);
}
