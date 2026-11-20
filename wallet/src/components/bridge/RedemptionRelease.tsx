import RedemptionWalletCalls from './RedemptionWalletCalls';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import { useEffect, useRef, useState } from 'react';
import type { BridgeOrder, RedemptionOrder, RedemptionReleaseView, RedemptionEscrowDeployment } from '../../../../shared/src/types/learningBridge';
import { getRelease, releaseAction } from '../../services/redemptionRelease';
import { getErrorMessage } from '../../utils/errors';
import { formatRawAmount } from '../../utils/tokenAmounts';
import { formatDateTime } from '../../utils/dateTime';
import { BridgeSteps, bridgeStatus } from './BridgeFlow';
import ConfirmationUpdates from './ConfirmationUpdates';
import useConfirmationPolling from '../../hooks/useConfirmationPolling';
import { Link } from 'react-router-dom';
import V15EscrowActivation from './V15EscrowActivation';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import { DEVNET_DOMAIN } from '../../config/constants';
interface Props { order: BridgeOrder; row: RedemptionOrder; escrow: RedemptionEscrowDeployment; session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; enabled: boolean; context: string; onOpened: () => void }
export default function RedemptionRelease({ order, row, escrow, session, evm, enabled, context: parentContext, onOpened }: Props) {
	const context = JSON.stringify([parentContext, enabled, row.id]); const current = useRef({ context, epoch: 0 });
	if (current.current.context !== context) current.current = { context, epoch: current.current.epoch + 1 };
	const epoch = current.current.epoch; const live = () => enabled && current.current.context === context && current.current.epoch === epoch;
	const request = useRef<AbortController | null>(null); const working = useRef(false);
	const [state, setState] = useState<{ context: string; epoch: number; value: RedemptionReleaseView | null; busy: boolean; loaded: boolean; error: string }>({ context, epoch, value: null, busy: false, loaded: false, error: '' });
	const [revision, setRevision] = useState(0); const [funding, setFunding] = useState(''); const [lock, setLock] = useState(''); const [reviewed, setReviewed] = useState(false);
	const [activationReady, setActivationReady] = useState(escrow.quote.activationMode !== 'multisig-v1.5');
	const fundingStorageKey = `redemption-fee-payment:${order.sender}:${row.id}`;
	useEffect(() => {
		let saved = '';
		try { saved = localStorage.getItem(fundingStorageKey) ?? ''; } catch { /* Manual recovery remains available. */ }
		setReviewed(false); setFunding(/^[0-9a-f]{64}$/i.test(saved) ? saved.toLowerCase() : ''); setLock(''); setActivationReady(escrow.quote.activationMode !== 'multisig-v1.5');
		return () => request.current?.abort();
	}, [context, fundingStorageKey]);
	useEffect(() => {
		const controller = new AbortController();
		setState({ context, epoch, value: null, busy: enabled, loaded: false, error: '' });
		if (enabled) void getRelease(order, row, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
			.then((value) => { if (!controller.signal.aborted && live()) setState({ context, epoch, value, busy: false, loaded: true, error: '' }); })
			.catch((cause) => { if (!controller.signal.aborted && live()) setState({ context, epoch, value: null, busy: false, loaded: false, error: getErrorMessage(cause) }); });
		return () => controller.abort();
	}, [context, revision]);
	const visible = state.context === context && state.epoch === epoch ? state : { value: null, busy: enabled, loaded: false, error: '' };
	const value = visible.value; const busy = visible.busy;
	async function run(action: 'open' | 'funding' | 'lock' | 'sign' | 'broadcast' | 'check', payload: unknown = {}) {
		if (!live() || working.current || busy) return;
		working.current = true; const controller = new AbortController(); request.current = controller;
		setState((old) => ({ ...old, busy: true, error: '' }));
		try {
			const result = await releaseAction(order, row, action, payload, AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)]));
			if (live()) { setState({ context, epoch, value: result, busy: false, loaded: true, error: '' }); setReviewed(false); if (action === 'open') onOpened(); }
		} catch (cause) {
			if (live()) {
				let saved = value;
				try { saved = await getRelease(order, row, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])); } catch { /* Refresh can recover committed records. */ }
				if (live()) setState({ context, epoch, value: saved, busy: false, loaded: true, error: `${getErrorMessage(cause)} Keep the existing payment TXID and refresh saved progress.` });
			}
		} finally { working.current = false; if (request.current === controller) request.current = null; }
	}
	async function payFeeWithTuringWallet() {
		if (!live() || working.current || busy || value?.status !== 'awaiting_fee' || funding) return;
		working.current = true; session.setBusy(true); setState((old) => ({ ...old, busy: true, error: '' }));
		try {
			const [network, addresses] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress()]);
			const walletAddresses = addresses as WalletAddresses | undefined;
			if (!live() || network?.network !== 'tbc' || network.type !== 'testnet' || (walletAddresses?.tbcAddress ?? walletAddresses?.addresses?.tbcAddress) !== order.sender) throw new Error('Select the original TBC wallet on Testnet before paying. No payment was sent.');
			const result = await session.wallet.sendTransaction([{ flag: 'P2PKH', address: value.fundingAddress, satoshis: value.fundingRequiredRaw, broadcastEnabled: true, domain: DEVNET_DOMAIN }]);
			const txid = result?.txid?.trim().toLowerCase() ?? '';
			if (!/^(?!0{64}$)[0-9a-f]{64}$/.test(txid)) throw new Error('Turing Wallet did not return one payment TXID. Check its history before trying again.');
			try { localStorage.setItem(fundingStorageKey, txid); } catch { /* Keep it in component state. */ }
			if (live()) { setFunding(txid); setState((old) => ({ ...old, busy: false, error: '' })); }
		} catch (cause) {
			if (live()) setState((old) => ({ ...old, busy: false, error: getErrorMessage(cause) }));
		} finally { working.current = false; session.setBusy(false); }
	}
	useEffect(() => {
		if (!enabled || busy || value?.status !== 'awaiting_fee' || !/^[0-9a-f]{64}$/.test(funding)) return;
		const timer = window.setTimeout(() => { void run('funding', { txid: funding }); }, 60_000);
		return () => window.clearTimeout(timer);
	}, [enabled, busy, value?.status, funding]);
	useEffect(() => {
		if (value?.status === 'awaiting_fee') return;
		try { localStorage.removeItem(fundingStorageKey); } catch { /* Public recovery receipt can expire naturally. */ }
	}, [value?.status, fundingStorageKey]);
	const waiting = !!value?.signed && ['submitted', 'confirming'].includes(value.status);
	const updates = useConfirmationPolling({ context, enabled, waiting, busy, error: visible.error || value?.lastError || '', check: () => run('check') });
	const steps = ['Fund TBC fee', `Approve and lock ${order.wrappedSymbol}`, `Confirm ${order.symbol} return`, `Receive ${order.symbol}`];
	const step = !value?.plan ? 0 : value.status === 'funded' ? 1 : value.status === 'completed' ? 3 : 2;
	if (value?.status === 'completed') return <section className="htlc-section" aria-label="Completed token return">
		<BridgeSteps steps={steps} current={3} complete />
		<p className="result success">{order.symbol} return confirmed: {formatRawAmount(row.amountRaw, order.decimals)} {order.symbol} to <code>{row.tbcRecipient}</code>. This return is complete; check the receiving Turing Wallet balance.</p>
		<p>Your returned {order.wrappedSymbol} is permanently locked.</p>
		<Link to="/bridge-lab?tab=reconciliation">View transactions and fees in Reconciliation</Link>
		<details className="bridge-flow-history"><summary>Completed return details</summary>
			<p>{order.symbol} return TXID: <code>{value.signed?.txid}</code> · {value.signed?.confirmations} / 6 confirmations</p>
			<p>Permanent lock: <code>{value.lock?.txHash}</code></p>
			{value.plan && <p>Return fee: {formatRawAmount(value.plan.feeRaw, 6)} TBC · native change retained in custody: {formatRawAmount(value.plan.nativeChangeRaw, 6)} TBC. No automatic refund.</p>}
			<p>Last check {value.checkedAt ? formatDateTime(value.checkedAt) : 'Not recorded'} MYT</p>
		</details>
	</section>;
	return <section className="htlc-section" aria-label="Return fee funding" aria-busy={busy}>
		<h4>Continue your {order.symbol} return</h4>
		<BridgeSteps steps={steps} current={step} />
		{waiting && <ConfirmationUpdates automatic={updates.automatic} onChange={updates.setAutomatic} paused={updates.paused} />}
		{!value && <>
			<p>Open the fee details, pay the displayed TBC amount once and paste its TXID below. You will receive the full {order.symbol} amount.</p>
			<p>After opening payment details, this return cannot be closed as unused.</p>
			<button type="button" disabled={!enabled || busy || !visible.loaded || row.status !== 'prepared'} onClick={() => { void run('open'); }}>Open fee payment details</button>
		</>}
		<button type="button" className="history-secondary" disabled={!enabled || busy || working.current} onClick={() => setRevision((old) => old + 1)}>Refresh return status</button>
		{value && <>
			<p>Return status: <strong>{bridgeStatus(value.status)}</strong></p>
			<details className="bridge-flow-history" open={value.status === 'awaiting_fee'}><summary>TBC fee payment details</summary><dl className="history-detail-grid">
				<div><dt>TBC fee payment</dt><dd>{formatRawAmount(value.fundingRequiredRaw, 6)} TBC</dd></div>
				<div><dt>Send TBC to this address</dt><dd><code>{value.fundingAddress}</code></dd></div>
				<div><dt>Estimated return fee</dt><dd>{formatRawAmount(value.feeQuote.feeRaw, 6)} TBC</dd></div>
				<div><dt>{order.symbol} payout</dt><dd>{formatRawAmount(row.amountRaw, order.decimals)} {order.symbol} → <code>{row.tbcRecipient}</code></dd></div>
			</dl></details>
			{value.status === 'awaiting_fee' && <>
				<p>Pay the displayed amount as <strong>TBC, not {order.symbol}</strong>. The amount, address and TXID are handled automatically; Turing Wallet will ask you to confirm once.</p>
				<p className="history-note">Unused TBC remains at the bridge address and is not automatically refunded. Send once; use the same TXID to check your payment.</p>
				{!funding && <button type="button" disabled={!enabled || busy} onClick={() => { void payFeeWithTuringWallet(); }}>Pay {formatRawAmount(value.fundingRequiredRaw, 6)} TBC with Turing Wallet</button>}
				{funding && <><p role="status">Payment submitted. Waiting for 6 confirmations; this page checks it automatically about once per minute.</p><p className="history-note">TBC TXID: <code>{funding}</code></p><button type="button" disabled={!enabled || busy} onClick={() => { void run('funding', { txid: funding }); }}>Check payment now</button></>}
				<details><summary>Already paid or need manual recovery?</summary><label htmlFor={`release-fund-${row.id}`}>TBC fee payment TXID</label><input id={`release-fund-${row.id}`} value={funding} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setFunding(event.target.value.trim().toLowerCase())} /><button type="button" disabled={!enabled || busy || !/^[0-9a-f]{64}$/i.test(funding)} onClick={() => { void run('funding', { txid: funding }); }}>Check this TXID</button></details>
			</>}
			{value.plan && <>
				<details className="bridge-flow-history" open={['locked', 'signed', 'broadcasting'].includes(value.status)}><summary>Review {order.symbol} return</summary>
				<p>Exact payout: {formatRawAmount(value.plan.amountRaw, order.decimals)} {order.symbol} to <code>{value.plan.recipient}</code>.</p>
				<p>Return fee: {formatRawAmount(value.plan.feeRaw, 6)} TBC · TBC remaining at the bridge: {formatRawAmount(value.plan.nativeChangeRaw, 6)} TBC.</p>
				</details>
				{value.status === 'funded' && <p role="status">Fee payment confirmed. Prepare the next wallet step below and confirm it in MetaMask.</p>}
				{escrow.quote.activationMode === 'multisig-v1.5' && value.status === 'funded' && <V15EscrowActivation order={order} escrow={escrow} evm={evm} active={enabled && !busy} onActive={() => setActivationReady(true)} />}
				{activationReady && <RedemptionWalletCalls order={order} row={row} escrow={escrow} evm={evm} enabled={enabled && !busy} funded={value.status === 'funded'} context={context} onVerified={() => setRevision((old) => old + 1)} />}
				{!value.signed && <details><summary>Recover an existing permanent lock transaction</summary><p>Paste the permanent-lock transaction from MetaMask Activity to continue this return. Do not use an approval transaction or send tokens again.</p><label htmlFor={`release-lock-${row.id}`}>HyperEVM escrow lock transaction hash</label><input id={`release-lock-${row.id}`} value={lock} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setLock(event.target.value)} /><button type="button" disabled={!enabled || busy || !/^0x[0-9a-f]{64}$/i.test(lock.trim())} onClick={() => { void run('lock', { txHash: lock.trim().toLowerCase() }); }}>Verify existing permanent lock</button></details>}
				{value.lock && <p>Permanent lock: <code>{value.lock.txHash}</code> · {value.lock.confirmations} confirmations (saved check).</p>}
				{value.status === 'locked' && !value.signed && <><label className="bridge-role-choice"><input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} /> I authorize this {order.symbol} return for the amount, receiving address and TBC fee shown above.</label><button type="button" disabled={!enabled || busy || !reviewed} onClick={() => { void run('sign', { planHash: value.plan!.planHash, authorize: true }); }}>Authorize {order.symbol} return</button></>}
				{value.signed && <>
					<p>{order.symbol} return TXID: <code>{value.signed.txid}</code></p><p>Source confirmations: {value.signed.confirmations} / 6 required.</p>
					{['signed', 'broadcasting'].includes(value.status) && <><label className="bridge-role-choice"><input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} /> I checked the {order.symbol} amount, receiving address and TBC fee. Submit this return.</label><button type="button" disabled={!enabled || busy || !reviewed} onClick={() => { void run('broadcast', { planHash: value.plan!.planHash, authorize: true }); }}>{value.status === 'signed' ? 'Submit token return' : 'Check / retry this return'}</button></>}
					<button type="button" className="history-secondary" disabled={!enabled || busy} onClick={() => { void run('check'); }}>Check now</button>
				</>}
			</>}
			{value.checkedAt && <p className="history-note">Last saved check {formatDateTime(value.checkedAt)} MYT</p>}
			{value.lastError && <p className="result error" role="alert">{value.lastError}</p>}
		</>}
		{busy && <p role="status">Checking / saving the existing {order.symbol} release…</p>}
		{visible.error && <p className="result error" role="alert">{visible.error}</p>}
	</section>;
}
