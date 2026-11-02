import { useEffect, useState, type ReactNode } from 'react';
import { AttemptHistory } from './BridgeFlow';
import ConfirmationUpdates from './ConfirmationUpdates';
import useConfirmationPolling from '../../hooks/useConfirmationPolling';
import type { WalletSession } from '../../types/wallet';
import type { BridgeDeploymentInput } from '../../types/learningBridge';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeDeployments from '../../hooks/useBridgeDeployments';
import { formatDateTime } from '../../utils/dateTime';
import { formatHypeBalance } from '../../services/evmWallet';

export default function BridgeDeploymentActions({ session, evm, active, input, canPrepare, children }: { session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean; input: BridgeDeploymentInput | null; canPrepare: boolean; children?: ReactNode }) {
	const deployment = useBridgeDeployments(session, evm, active, input?.contractId);
	const [reviewed, setReviewed] = useState('');
	const [hashes, setHashes] = useState<Record<string, string>>({});
	const [discard, setDiscard] = useState('');
	const [, tick] = useState(0);
	useEffect(() => { setReviewed(''); setHashes({}); setDiscard(''); }, [active, session.address, evm.address, evm.chainId, input?.contractId, input?.wrappedName, input?.wrappedSymbol, input?.admin, input?.minter]);
	useEffect(() => {
		const times = deployment.rows.filter((row) => row.status === 'prepared').map((row) => Date.parse(row.expiresAt) - Date.now()).filter((time) => time > 0);
		if (!times.length) return;
		const timer = setTimeout(() => tick((value) => value + 1), Math.min(...times) + 20);
		return () => clearTimeout(timer);
	}, [deployment.rows]);
	const rows = deployment.rows.filter(row => !input || row.contractId === input.contractId);
	const unresolved = rows.some((row) => ['prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified'].includes(row.status));
	const existing = rows.find(row => row.status === 'verified' && !row.lastError);
	const busy = !!deployment.action || !!evm.pending || deployment.loading;
	const pending = rows.find((row) => row.txHash && ['submitted', 'confirming'].includes(row.status));
	const updates = useConfirmationPolling({ context: JSON.stringify([deployment.context, evm.address, evm.chainId]), enabled: active && deployment.enabled, waiting: !!pending, busy, error: deployment.error,
		check: async () => { if (pending) await deployment.check(pending); } });
	return <section className="htlc-section" aria-labelledby="bridge-deploy-title">
		<h4 id="bridge-deploy-title">Wrapped contract</h4>
        {existing && <p className="result success">Use your existing {existing.quote.wrappedName ?? 'Learning Wrapped Test FT'} ({existing.quote.wrappedSymbol ?? 'lwFT'}) contract: <code>{existing.contractAddress}</code>. Continue to Review and send below. Its name and symbol cannot be changed.</p>}
        {!unresolved && children}
		{pending && <ConfirmationUpdates automatic={updates.automatic} onChange={updates.setAutomatic} paused={updates.paused} />}
		<p>Prepare setup, review the fee and wallet addresses, then confirm in MetaMask.</p>
		<div className="htlc-actions">
			<button type="button" disabled={!deployment.enabled || !canPrepare || !input || busy || unresolved} onClick={() => { if (input) void deployment.prepare(input); }}>{deployment.action === 'prepare' ? 'Preparing…' : 'Prepare deployment'}</button>
			<button type="button" className="history-secondary" disabled={!deployment.enabled || busy} onClick={deployment.refresh}>Refresh saved deployments</button>
		</div>
		{!deployment.enabled && <p className="history-feedback">Connect your TBC Testnet wallet to load its saved deployment records.</p>}
		{deployment.error && <p className="result error" role="alert">{deployment.error}</p>}
		{deployment.action.startsWith('deploy:') && <p className="history-feedback" role="status">Rechecking deployment parameters, then waiting for your MetaMask confirmation. Keep this request open until you approve or reject it.</p>}
		{Object.entries(deployment.unsaved).map(([id, hash]) => <p className="result error" role="alert" key={id}>Transaction sent: <code>{hash}</code>. Refresh to update its status. Do not submit again.</p>)}
		{<AttemptHistory rows={rows} title="Deployment history" render={(row) => {
			const prepared = row.status === 'prepared';
			const noHash = !row.txHash && ['prepared', 'awaiting_wallet', 'cancelled'].includes(row.status);
			const expired = Date.parse(row.expiresAt) <= Date.now();
			const rolesMatch = input && row.contractId === input.contractId && (row.quote.wrappedName === undefined || row.quote.wrappedName === input.wrappedName && row.quote.wrappedSymbol === input.wrappedSymbol) && [row.deployer, row.admin, row.minter].every((address, index) => address.toLowerCase() === [input.deployer, input.admin, input.minter][index].toLowerCase());
			return <article className="bridge-deployment-record" key={row.id}>
				<h4>{row.lastError?.startsWith('Status unavailable') ? 'Status unavailable' : row.status === 'verified' ? 'Deployment verified' : row.status === 'awaiting_wallet' ? 'Wallet request started · check MetaMask activity' : row.status === 'confirming' ? 'Awaiting confirmations' : row.status === 'submitted' ? 'Transaction submitted · verification pending' : row.status === 'prepared' && expired ? 'Unused preparation expired' : row.status === 'prepared' ? 'Ready for review' : row.status === 'cancelled' ? 'Preparation discarded' : row.status === 'reverted' ? 'Transaction reverted' : 'Deployment did not match'}</h4>
				{row.lastError && <p className="result error" role="alert">{row.lastError}{row.status === 'verified' ? ' Previous result: verified.' : ''}</p>}
				<dl className="history-detail-grid">
					<div><dt>Wallet paying the fee</dt><dd><code>{row.deployer}</code></dd></div>
					<div><dt>Reviewed deployment budget</dt><dd>{formatHypeBalance(row.quote.bufferedFeeWei)} HYPE · Testnet 998</dd></div>
					<div><dt>Wrapped token</dt><dd>{row.quote.wrappedName ?? 'Learning Wrapped Test FT'} ({row.quote.wrappedSymbol ?? 'lwFT'}) · {row.decimals} decimals</dd></div>
					<div><dt>Admin</dt><dd><code>{row.admin}</code></dd></div>
					<div><dt>Minter</dt><dd><code>{row.minter}</code></dd></div>
					<div><dt>Transaction</dt><dd><code>{row.txHash ?? 'Not recorded yet'}</code></dd></div>
					{row.contractAddress && <div><dt>Contract address{row.status !== 'verified' ? ' · verification pending' : ''}</dt><dd><code>{row.contractAddress}</code></dd></div>}
					{row.txHash && <div><dt>Confirmations</dt><dd>{row.confirmations} / {row.requiredConfirmations} required</dd></div>}
					{row.actualFeeWei && <div><dt>Actual deployment fee</dt><dd>{formatHypeBalance(row.actualFeeWei)} HYPE</dd></div>}
				</dl>
				{row.checkedAt && <p className="history-note">Last status check {formatDateTime(row.checkedAt)} MYT.</p>}
				{row.status === 'verified' && !row.lastError && <p className="history-feedback">Setup complete. Continue to your transfer below.</p>}
				{prepared && <>
					<p className="history-note">Preparation expires {formatDateTime(row.expiresAt)} MYT. Prepare again if this quote expires.</p>
					<label className="bridge-role-choice"><input type="checkbox" checked={reviewed === row.id} onChange={(event) => setReviewed(event.target.checked ? row.id : '')} /> I checked the token name, symbol, wallet addresses and HYPE fee.</label>
					<button type="button" disabled={busy || !deployment.enabled || !canPrepare || !evm.networkIsTestnet || !rolesMatch || reviewed !== row.id || expired} onClick={() => { void deployment.deploy(row); }}>Deploy with MetaMask</button>
					{!rolesMatch && <p className="history-feedback">Use the saved deployer and role addresses above, or discard this unused preparation before preparing different parameters.</p>}
				</>}
				{row.txHash && <button type="button" className="history-secondary" disabled={!deployment.enabled || busy} onClick={() => { void deployment.check(row); }}>Check now</button>}
				{noHash && <details><summary>Recover a submitted transaction or discard an unused preparation</summary>
					<p>Check MetaMask Activity first. If a deployment was sent, paste its transaction hash to resume verification. Discarding this record does not cancel a wallet request or a blockchain transaction.</p>
					<label htmlFor={`deployment-hash-${row.id}`}>Deployment transaction hash</label>
					<input id={`deployment-hash-${row.id}`} value={hashes[row.id] ?? ''} maxLength={66} spellCheck={false} autoComplete="off" placeholder="0x…" onChange={(event) => setHashes((values) => ({ ...values, [row.id]: event.target.value }))} />
					<button type="button" disabled={!deployment.enabled || busy || !hashes[row.id]} onClick={() => { void deployment.attach(row, hashes[row.id]); }}>Save hash and track deployment</button>
					{row.status !== 'cancelled' && <>
						<label className="bridge-role-choice"><input type="checkbox" checked={discard === row.id} onChange={(event) => setDiscard(event.target.checked ? row.id : '')} /> I checked MetaMask: no deployment was sent and no approval request remains open.</label>
						<button type="button" className="history-secondary" disabled={!deployment.enabled || busy || discard !== row.id} onClick={() => { void deployment.cancel(row); }}>Discard unused preparation</button>
					</>}
				</details>}
			</article>;
		}} />}

		{deployment.enabled && !deployment.loading && !deployment.rows.length && !deployment.error && <p className="history-note">No deployment is saved for this TBC wallet yet.</p>}
	</section>;
}
