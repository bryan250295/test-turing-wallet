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
	const connected = Boolean(address) && networkIsDevnet;
	const connectionLabel = !connected ? 'Wallet not connected to Devnet'
		: session.backendAuth.pending ? 'Completing your connection…'
			: session.backendAuth.ready ? 'TBC Devnet connected' : 'Wallet connected · login required';
	return (
		<div className="connection">
			<div className="connection-info">
				<strong><span className={`dot ${session.backendAuth.ready ? 'ok' : ''}`} />{connectionLabel}</strong>
				<dl className="wallet-details">
					<div><dt>Wallet</dt><dd>{walletName}</dd></div>
					<div><dt>Network</dt><dd>{networkLabel}</dd></div>
					<div className="account-detail"><dt>Account</dt><dd><code title={address}>{address || 'Not connected'}</code></dd></div>
					{walletVersion !== null && <div><dt>Version</dt><dd>{walletVersion}</dd></div>}
				</dl>
				{session.backendAuth.pending && address && networkIsDevnet && <p role="status">Completing your connection. Confirm the login signature if your wallet asks.</p>}
				{connected && !session.backendAuth.ready && !session.backendAuth.pending && !session.backendAuth.error && <p role="status">Click Reconnect to confirm your wallet login and continue.</p>}
				{session.backendAuth.error && <p className="result error" role="alert">{session.backendAuth.error}</p>}
			</div>
			<button type="button" onClick={connect} disabled={busy}>
				{session.backendAuth.pending ? 'Connecting…' : busy ? 'Working…' : address ? 'Reconnect' : 'Connect wallet'}
			</button>
		</div>
	);
}
