import { useEffect, useState, useSyncExternalStore } from 'react';
import type { WalletPageProps } from '../../types/wallet';
import type { HtlcRecoveryTarget } from '../../types/htlc';
import { getHtlcHistorySnapshot, subscribeHtlcHistory } from '../../services/htlcRequestHistory';
import WalletConnection from '../WalletConnection';
import HtlcTokenLock from './HtlcTokenLock';
import TokenHtlcRecovery from './TokenHtlcRecovery';

export default function HtlcTestnet({ session, recoveryTarget, onClearRecoveryTarget, onViewRequests, active }: WalletPageProps & { recoveryTarget?: HtlcRecoveryTarget; onClearRecoveryTarget: () => void; onViewRequests: () => void; active: boolean }) {
	const history = useSyncExternalStore(subscribeHtlcHistory, getHtlcHistorySnapshot);
	const [mode, setMode] = useState<'create' | 'recover'>(() => recoveryTarget ? 'recover' : 'create');
	useEffect(() => { if (recoveryTarget) setMode('recover'); }, [recoveryTarget]);
	const accountKey = `${session.address}:${session.networkIsDevnet}:${session.wallet.isReady}:${session.backendAuth.ready}`;

	return <section className="htlc-lab" aria-labelledby="htlc-title">
		<div className="history-titlebar"><div><h2 id="htlc-title">Token locks</h2><p>Lock FT tokens for a recipient, or manage an existing request on TBC Testnet.</p></div><button type="button" className="history-secondary" onClick={onViewRequests}>My requests</button></div>
		<WalletConnection session={session} />
		{history.error && <p className="result error" role="alert">{history.error}</p>}
		<p className="history-note">Native test TBC is required for transaction fees. Request history is saved automatically.</p>
		<div className="page-tabs htlc-mode-tabs" role="group" aria-label="Token lock actions">
			<button type="button" className={mode === 'create' ? 'selected' : ''} aria-pressed={mode === 'create'} disabled={session.busy} onClick={() => { onClearRecoveryTarget(); setMode('create'); }}>Create lock</button>
			<button type="button" className={mode === 'recover' ? 'selected' : ''} aria-pressed={mode === 'recover'} disabled={session.busy} onClick={() => setMode('recover')}>Claim / Refund</button>
		</div>
		{active && mode === 'create' && <HtlcTokenLock key={accountKey} session={session} onViewRequests={onViewRequests} />}
		{active && mode === 'recover' && <TokenHtlcRecovery key={accountKey} session={session} active recoveryTarget={recoveryTarget} />}
	</section>;
}
