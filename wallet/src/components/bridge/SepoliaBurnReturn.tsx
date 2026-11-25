import { useEffect, useRef, useState } from 'react';
import type { BridgeOrder, SepoliaBurnCall, SepoliaBurnRedemption } from '../../types/learningBridge';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import { formatRawAmount } from '../../utils/tokenAmounts';
import { formatHypeBalance } from '../../services/evmWallet';
import { formatDateTime } from '../../utils/dateTime';
import { getErrorMessage } from '../../utils/errors';
import { beginSepoliaBurn, broadcastNativeRelease, cancelSepoliaBurn, checkNativeRelease, checkSepoliaBurn, fundSepoliaFtRelease, getSepoliaRedemption, prepareSepoliaRedemption, quoteSepoliaBurn, submitSepoliaBurn } from '../../services/sepoliaBurnRedemption';
import { BridgeSteps, AttemptHistory, bridgeStatus } from './BridgeFlow';
import { DEVNET_DOMAIN } from '../../config/constants';

interface Props { order: BridgeOrder; session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean }
export default function SepoliaBurnReturn({ order, session, evm, active }: Props) {
	const context = `${active}:${session.address}:${session.backendAuth.ready}:${evm.address}:${evm.chainId}:${order.id}`;
	const current = useRef(context); current.current = context;
	const busyRef = useRef(false);
	const [value, setValue] = useState<SepoliaBurnRedemption | null>(null);
	const [loading, setLoading] = useState(false); const [action, setAction] = useState(''); const [error, setError] = useState('');
	const [reviewed, setReviewed] = useState<Record<string, boolean>>({}); const [releaseReviewed, setReleaseReviewed] = useState(false);
	const [hashes, setHashes] = useState<Record<string, string>>({}); const [notSent, setNotSent] = useState<Record<string, boolean>>({});
	const [funding, setFunding] = useState('');
	const [realtime, setRealtime] = useState<'off' | 'connecting' | 'connected' | 'reconnecting'>('off');
	const eventRefresh = useRef(false);
	const ft = order.sourceAssetKind === 'fungible-token';
	const fundingStorageKey = `sepolia-ft-return-fee:${order.sender}:${order.id}`;
	const enabled = active && session.networkIsDevnet && session.backendAuth.ready && session.address === order.sender && order.destinationChainId === 11_155_111 && order.settlementStatus === 'completed';
	async function load(signal?: AbortSignal) {
		if (!enabled) return;
		const next = await getSepoliaRedemption(order, signal);
		if (current.current === context) {
			setValue(next);
			if (next?.fundingTxid) {
				setFunding(next.fundingTxid);
				try { localStorage.setItem(fundingStorageKey, next.fundingTxid); } catch { /* Server state is authoritative. */ }
			}
		}
	}
	useEffect(() => {
		const controller = new AbortController(); let saved = '';
		try { saved = localStorage.getItem(fundingStorageKey) ?? ''; } catch { /* Manual recovery stays available. */ }
		setFunding(/^[0-9a-f]{64}$/i.test(saved) ? saved.toLowerCase() : ''); setValue(null); setLoading(enabled); setError(''); setReviewed({}); setReleaseReviewed(false); setHashes({}); setNotSent({});
		if (enabled) void load(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(getErrorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [context, enabled]);
	const activeCall = value?.calls.find((row) => ['quoted', 'awaiting_wallet', 'submitted', 'confirming'].includes(row.status));
	const fundingTxid = value?.fundingTxid ?? funding;
	useEffect(() => {
		if (!enabled || value?.status === 'completed') { setRealtime('off'); return; }
		setRealtime('connecting');
		const source = new EventSource(`/api/bridge/orders/${order.id}/settlement/events`, { withCredentials: true });
		const connected = () => { if (current.current === context) setRealtime('connected'); };
		const refresh = () => {
			if (current.current !== context || busyRef.current || eventRefresh.current) return;
			eventRefresh.current = true;
			void load(AbortSignal.timeout(25_000)).catch((cause) => { if (current.current === context) setError(getErrorMessage(cause)); })
				.finally(() => { eventRefresh.current = false; });
		};
		source.onopen = connected;
		source.onerror = () => { if (current.current === context) setRealtime('reconnecting'); };
		source.addEventListener('ready', connected);
		source.addEventListener('heartbeat', connected);
		source.addEventListener('progress', refresh);
		return () => { source.close(); eventRefresh.current = false; setRealtime('off'); };
	}, [context, enabled, order.id, value?.status === 'completed']);
	async function run(label: string, work: (signal: AbortSignal) => Promise<unknown>) {
		if (!enabled || busyRef.current) return;
		busyRef.current = true; setAction(label); setError(''); const controller = new AbortController();
		try { await work(AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])); await load(AbortSignal.timeout(25_000)); }
		catch (cause) { if (current.current === context) { setError(getErrorMessage(cause)); try { await load(AbortSignal.timeout(20_000)); } catch { /* Preserve the actionable error. */ } } }
		finally { controller.abort(); busyRef.current = false; if (current.current === context) setAction(''); }
	}
	const busy = loading || !!action || session.busy || !!evm.pending;
	const walletReady = enabled && evm.detected && evm.networkIsTestnet && evm.address?.toLowerCase() === order.recipient.toLowerCase() && !evm.error;
	const walletIssue = !evm.detected ? 'MetaMask was not detected.'
		: evm.error ? evm.error
		: !evm.address ? 'Connect the receiving MetaMask account.'
		: !evm.networkIsTestnet ? `Select Ethereum Sepolia (chain 11155111); MetaMask currently reports chain ${evm.chainId ?? 'unknown'}.`
		: evm.address.toLowerCase() !== order.recipient.toLowerCase() ? `Select the original receiving account ${order.recipient}.`
		: null;
	const walletRecovery = walletIssue ? <div className="history-feedback"><p>{walletIssue}</p><div className="htlc-actions">
		{evm.detected && !evm.address && <button type="button" className="history-secondary" disabled={busy} onClick={() => { void evm.connect(); }}>Connect MetaMask</button>}
		{evm.address && !evm.networkIsTestnet && <button type="button" className="history-secondary" disabled={busy} onClick={() => { void evm.switchNetwork(); }}>Switch to Sepolia</button>}
		<button type="button" className="history-secondary" disabled={busy} onClick={evm.refresh}>Refresh MetaMask</button>
	</div></div> : null;
	const amount = formatRawAmount(order.amountRaw, order.decimals);
	async function payFee() {
		if (!value?.fundingAddress || !value.fundingRequiredRaw || value.status !== 'awaiting_fee' || busyRef.current || fundingTxid) return;
		busyRef.current = true; setAction('pay-fee'); setError(''); session.setBusy(true);
		try {
			const [network, addresses] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress()]); const walletAddresses = addresses as WalletAddresses | undefined;
			if (network?.network !== 'tbc' || network.type !== 'testnet' || (walletAddresses?.tbcAddress ?? walletAddresses?.addresses?.tbcAddress) !== order.sender) throw new Error('Select the original TBC wallet on Testnet before paying. No payment was sent.');
			const result = await session.wallet.sendTransaction([{ flag: 'P2PKH', address: value.fundingAddress, satoshis: value.fundingRequiredRaw, broadcastEnabled: true, domain: DEVNET_DOMAIN }]);
			const txid = result?.txid?.trim().toLowerCase() ?? ''; if (!/^(?!0{64}$)[0-9a-f]{64}$/.test(txid)) throw new Error('Turing Wallet did not return one fee TXID. Check its history before trying again.');
			try { localStorage.setItem(fundingStorageKey, txid); } catch { /* Component state retains it. */ } setFunding(txid);
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { busyRef.current = false; session.setBusy(false); setAction(''); }
	}
	useEffect(() => { if (value?.status === 'awaiting_fee') return; try { localStorage.removeItem(fundingStorageKey); } catch { /* It can expire naturally. */ } }, [value?.status, fundingStorageKey]);
	if (!enabled) return <p>Reconnect the original TBC wallet to continue this saved Sepolia return.</p>;
	return <section className="htlc-section" aria-label={`Burn ${order.wrappedSymbol} and return ${order.symbol}`} aria-busy={busy}>
		<header className="history-titlebar"><div><h4>Burn-return · Ethereum Sepolia → TBC Testnet</h4><p className="history-note">Full original amount only · burn proof required · {realtime === 'connected' ? 'live updates connected' : realtime === 'off' ? 'live updates off' : 'live updates reconnecting…'}</p></div><button type="button" className="history-secondary" disabled={busy} onClick={() => { void run('refresh', async () => undefined); }}>Refresh saved return</button></header>
		<BridgeSteps steps={ft ? ['Fund TBC fee', `Review ${order.wrappedSymbol} burn`, `Burn ${order.wrappedSymbol}`, 'Verify burn', `Receive ${order.symbol}`] : [`Review ${order.wrappedSymbol} burn`, `Burn ${order.wrappedSymbol}`, 'Verify 6 confirmations', `Receive ${order.symbol}`]} current={!value ? 0 : ft ? value.status === 'awaiting_fee' ? 0 : value.status === 'prepared' ? 1 : value.status === 'burn_pending' ? 2 : ['burn_confirming', 'burn_verified'].includes(value.status) ? 3 : 4 : ['prepared', 'burn_pending'].includes(value.status) ? 1 : ['burn_confirming', 'burn_verified'].includes(value.status) ? 2 : 3} complete={value?.status === 'completed'} />
		{loading && <p role="status">Loading saved burn-return progress…</p>}
		{!value && !loading && <>
			<p>This destroys exactly <strong>{amount} {order.wrappedSymbol}</strong> on Sepolia. After 6 canonical confirmations, the backend signs one {order.symbol} release back to <code>{order.sender}</code>.</p>
			<p className="history-note">{ft ? `The full ${order.symbol} amount is returned; a separate native TBC input pays the source transaction fee.` : 'The native TBC payout deducts only its reviewed network fee.'} The burn is irreversible.</p>
			<button type="button" disabled={busy || !walletReady} onClick={() => { void run('prepare', (signal) => prepareSepoliaRedemption(order, evm.address!, signal)); }}>Prepare full burn return</button>
			{walletRecovery}
		</>}
		{value && <>
			<details className="bridge-flow-history" open={['awaiting_fee', 'prepared'].includes(value.status)}><summary>Frozen burn and payout terms</summary><dl className="history-detail-grid">
				<div><dt>Burn on Sepolia</dt><dd>{formatRawAmount(value.amountRaw, order.decimals)} {order.wrappedSymbol}</dd></div>
				<div><dt>Wrapped-token holder</dt><dd><code>{value.holder}</code></dd></div>
				<div><dt>Receive {order.symbol}</dt><dd>{formatRawAmount(value.payoutRaw ?? value.amountRaw, order.decimals)} {order.symbol} → <code>{value.tbcRecipient}</code></dd></div>
				<div><dt>TBC return network fee</dt><dd>{value.feeRaw ? `${formatRawAmount(value.feeRaw, 6)} TBC` : 'Fixed after fee funding confirms'}</dd></div>
				<div><dt>Redemption replay key</dt><dd><code>{value.redemptionKey}</code></dd></div>
				<div><dt>Saved TBC release plan</dt><dd>{value.releasePlanHash ? <code>{value.releasePlanHash}</code> : 'Awaiting fee input'}</dd></div>
			</dl></details>
			{value.status === 'awaiting_fee' && value.fundingAddress && value.fundingRequiredRaw && value.feeQuote && <div className="htlc-section">
				<h4>Fund the TT release transaction before burning</h4>
				<p>Pay <strong>{formatRawAmount(value.fundingRequiredRaw, 6)} native TBC</strong> to <code>{value.fundingAddress}</code>. This is the TBC network fee input, not TT.</p>
				<p className="history-note">The full {amount} {order.symbol} reserve remains unchanged. Burn stays disabled until this exact funding TXID has 6 confirmations and the TT release is frozen.</p>
				{!fundingTxid && <button type="button" disabled={busy} onClick={() => { void payFee(); }}>Pay fee with Turing Wallet</button>}
				{fundingTxid && <div className="result success" role="status"><p><strong>Fee payment detected.</strong> Do not pay again.</p><p>TXID: <code>{fundingTxid}</code></p><p>Confirmations: {value.fundingConfirmations} / 6. The backend checks this saved payment about once per minute, even after you close this page.</p><button type="button" className="history-secondary" disabled={busy} onClick={() => { void run('funding', (signal) => fundSepoliaFtRelease(order, fundingTxid, signal)); }}>Refresh fee confirmations</button></div>}
				{!value.fundingTxid && <details><summary>Already paid but automatic detection has not found it?</summary><label htmlFor={`sepolia-fee-${order.id}`}>Native TBC fee TXID</label><input id={`sepolia-fee-${order.id}`} value={funding} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => setFunding(event.target.value.trim().toLowerCase())} /><button type="button" className="history-secondary" disabled={busy || !/^[0-9a-f]{64}$/i.test(funding)} onClick={() => { void run('funding', (signal) => fundSepoliaFtRelease(order, funding, signal)); }}>Save and check this TXID</button></details>}
			</div>}
			{value.status === 'prepared' && !activeCall && <div className="htlc-actions"><button type="button" disabled={busy || !walletReady} onClick={() => { void run('quote', (signal) => quoteSepoliaBurn(order, evm.address!, signal)); }}>Review burn fee</button></div>}
			{!walletReady && value.status !== 'completed' && walletRecovery}
			<AttemptHistory rows={value.calls} render={(row: SepoliaBurnCall) => <article className="bridge-deployment-record" key={row.id}>
				<h4>Burn {order.wrappedSymbol} · {bridgeStatus(row.status)}</h4>
				<p>From <code>{row.transaction.from}</code> → <code>{row.transaction.to}</code></p>
				<p>Estimated fee {formatHypeBalance(row.estimatedFeeWei)} ETH · Budget {formatHypeBalance(row.budgetWei)} ETH</p>
				{row.status === 'quoted' && <><p>Quote expires {formatDateTime(row.expiresAt)} MYT.</p><label className="bridge-role-choice"><input type="checkbox" checked={!!reviewed[row.id]} disabled={busy} onChange={(event) => setReviewed((old) => ({ ...old, [row.id]: event.target.checked }))} /> I verified the full burn amount, Sepolia contract, TBC recipient and ETH budget.</label><div className="htlc-actions"><button type="button" disabled={busy || !walletReady || !reviewed[row.id] || Date.now() >= Date.parse(row.expiresAt)} onClick={() => { void run(`send:${row.id}`, async (signal) => {
					const authorized = await beginSepoliaBurn(order, value, row, signal); let hash: string;
					try { hash = await evm.sendBridgeCall(authorized.transaction); }
					catch (cause) { if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001) { await cancelSepoliaBurn(order, value, row); throw new Error('Burn rejected in MetaMask. No tokens were destroyed.'); } throw cause; }
					await submitSepoliaBurn(order, value, row, hash);
				}); }}>Confirm irreversible burn in MetaMask</button><button type="button" className="history-secondary" disabled={busy} onClick={() => { void run(`cancel:${row.id}`, () => cancelSepoliaBurn(order, value, row)); }}>Discard unused quote</button></div></>}
				{row.status === 'awaiting_wallet' && !row.txHash && <><p>Check MetaMask Activity. If the burn was sent, save its existing hash; do not send another burn.</p><label htmlFor={`sepolia-burn-hash-${row.id}`}>Sepolia burn transaction hash</label><input id={`sepolia-burn-hash-${row.id}`} value={hashes[row.id] ?? ''} disabled={busy} onChange={(event) => setHashes((old) => ({ ...old, [row.id]: event.target.value }))} /><button type="button" disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hashes[row.id] ?? '')} onClick={() => { void run(`recover:${row.id}`, () => submitSepoliaBurn(order, value, row, hashes[row.id])); }}>Save existing burn hash</button><details><summary>No burn transaction was sent?</summary><label className="bridge-role-choice"><input type="checkbox" checked={!!notSent[row.id]} onChange={(event) => setNotSent((old) => ({ ...old, [row.id]: event.target.checked }))} /> I checked MetaMask Activity and confirmed it was rejected or never sent.</label><button type="button" className="history-secondary" disabled={busy || !notSent[row.id]} onClick={() => { void run(`cancel:${row.id}`, () => cancelSepoliaBurn(order, value, row)); }}>Discard unsent request</button></details></>}
				{row.txHash && <><p>Burn transaction: <code>{row.txHash}</code></p><p>Confirmations: {row.confirmations} / 6{row.actualFeeWei ? ` · Actual fee ${formatHypeBalance(row.actualFeeWei)} ETH` : ''}</p>{['submitted', 'confirming'].includes(row.status) && <button type="button" className="history-secondary" disabled={busy} onClick={() => { void run(`check:${row.id}`, (signal) => checkSepoliaBurn(order, row, signal)); }}>Check burn confirmations</button>}</>}
				{row.lastError && <p className="result error" role="alert">{row.lastError}</p>}
			</article>} />
			{value.status === 'release_signed' && <div className="htlc-section"><h4>Burn verified · {order.symbol} release ready</h4><p>The backend saved and signed exactly one payout transaction: <code>{value.releaseTxid}</code>.</p><label className="bridge-role-choice"><input type="checkbox" checked={releaseReviewed} disabled={busy} onChange={(event) => setReleaseReviewed(event.target.checked)} /> I reviewed the {order.symbol} recipient, amount, TBC fee and saved release TXID.</label><button type="button" disabled={busy || !releaseReviewed} onClick={() => { void run('broadcast', (signal) => broadcastNativeRelease(order, value, signal)); }}>Broadcast saved {order.symbol} release</button></div>}
			{value.releaseTxid && ['release_broadcasting', 'release_submitted', 'release_confirming'].includes(value.status) && <div className="htlc-section"><h4>{order.symbol} release submitted</h4><p>Release TXID: <code>{value.releaseTxid}</code></p><p>Confirmations: {value.releaseConfirmations} / 6. Never broadcast a second payout.</p><button type="button" className="history-secondary" disabled={busy} onClick={() => { void run('check-release', (signal) => checkNativeRelease(order, signal)); }}>Check TBC confirmations</button></div>}
			{value.status === 'completed' && <div className="result success"><p>Return complete. {formatRawAmount(value.amountRaw, order.decimals)} {order.wrappedSymbol} was burned and {formatRawAmount(value.payoutRaw ?? value.amountRaw, order.decimals)} {order.symbol} was released to <code>{value.tbcRecipient}</code>.</p><p>TBC release TXID: <code>{value.releaseTxid}</code> · {value.releaseConfirmations} confirmations.</p></div>}
			{value.lastError && <p className="result error" role="alert">{value.lastError}</p>}
		</>}
		{action && <p role="status">Updating saved burn-return progress…</p>}
		{error && <p className="result error" role="alert">{error}</p>}
	</section>;
}
