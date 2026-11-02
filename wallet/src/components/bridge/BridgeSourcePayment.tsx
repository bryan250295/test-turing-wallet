import { useEffect, useRef, useState } from 'react';
import type { BridgeOrder, BridgeSettlement, BridgeSourcePayment as Receipt } from '../../../../shared/src/types/learningBridge';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import { DEVNET_DOMAIN } from '../../config/constants';
import { beginSourcePayment, cancelSourcePayment, loadSourcePayment, pendingSourcePayment, rememberSourcePayment, submitSourcePayment, walletTokenAmount } from '../../services/bridgeSourcePayment';
import { formatRawAmount } from '../../utils/tokenAmounts';
import { getErrorMessage } from '../../utils/errors';
import useConfirmationPolling from '../../hooks/useConfirmationPolling';
import ConfirmationUpdates from './ConfirmationUpdates';

interface Props { order: BridgeOrder; settlement: BridgeSettlement; session: WalletSession; enabled: boolean; busy: boolean; error: string; verify: (txid: string) => Promise<unknown> }
export default function BridgeSourcePayment({ order, settlement, session, enabled, busy, error: verificationError, verify }: Props) {
 const context = JSON.stringify([enabled, order.id, session.address, session.networkIsDevnet]);
 const contextRef = useRef(context); contextRef.current = context;
 const mounted = useRef(true), working = useRef(false), verifiedTxid = useRef('');
 const [state, setState] = useState<{ context: string; receipt: Receipt | null; loaded: boolean; error: string }>({ context, receipt: null, loaded: false, error: '' });
 const [action, setAction] = useState(''), [revision, setRevision] = useState(0), [notSent, setNotSent] = useState(false);
 const live = () => mounted.current && contextRef.current === context;
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
 useEffect(() => {
  const controller = new AbortController();
  setState({ context, receipt: null, loaded: false, error: '' }); verifiedTxid.current = ''; setNotSent(false);
  if (enabled) void (async () => {
   try {
    let receipt = await loadSourcePayment(order, settlement, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
    const unsaved = pendingSourcePayment(order);
    if (unsaved) {
     if (receipt?.attemptId !== unsaved.attemptId) throw new Error(`Retained payment TXID: ${unsaved.txid}. Use payment recovery below; do not pay again.`);
     receipt = await submitSourcePayment(order, settlement, unsaved.attemptId, unsaved.txid);
     rememberSourcePayment(order, null);
    }
    if (!controller.signal.aborted && live()) setState({ context, receipt, loaded: true, error: '' });
   } catch (cause) { if (!controller.signal.aborted && live()) setState({ context, receipt: null, loaded: false, error: getErrorMessage(cause) }); }
  })();
  return () => controller.abort();
 }, [context, revision]);
 const visible = state.context === context ? state : { receipt: null, loaded: false, error: '' };
 const receipt = visible.receipt;
 const canPay = enabled && visible.loaded && !busy && !action && !visible.error && !pendingSourcePayment(order) && (!receipt || receipt.status === 'cancelled');
 useEffect(() => {
  if (!receipt?.txid || busy || action || verificationError || visible.error || !enabled || verifiedTxid.current === receipt.txid) return;
  verifiedTxid.current = receipt.txid;
  void verify(receipt.txid);
 }, [receipt?.txid, busy, action, verificationError, visible.error, enabled]);
 const updates = useConfirmationPolling({ context, enabled, waiting: !!receipt?.txid, busy: busy || !!action, error: visible.error || verificationError,
  check: () => receipt?.txid ? verify(receipt.txid) : Promise.resolve() });
 async function verifyWallet() {
  const [network, addresses] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress()]);
  const address = addresses as WalletAddresses | undefined;
  if (!live() || !enabled || network?.network !== 'tbc' || network.type !== 'testnet' || (address?.tbcAddress ?? address?.addresses?.tbcAddress) !== order.sender) throw new Error('Reconnect the original TBC wallet on Testnet. No new wallet prompt was opened.');
 }
 async function pay() {
  if (!canPay || working.current) return;
  working.current = true; setAction('pay'); session.setBusy(true);
  let reserved = false;
  try {
   await verifyWallet();
   const request = await beginSourcePayment(order, settlement, AbortSignal.timeout(20_000)); reserved = true;
   if (live()) setState({ context, receipt: request, loaded: true, error: '' });
   await verifyWallet();
   // Exactly one explicit wallet request. Never retry a send or time out a pending approval.
   const result = await session.wallet.sendTransaction([{ flag: 'FT_TRANSFER', ft_contract_address: order.contractId,
    address: request.custodyAddress, ft_amount: walletTokenAmount(order.amountRaw, order.decimals), broadcastEnabled: true, domain: DEVNET_DOMAIN }]);
   const txid = result?.txid?.trim().toLowerCase();
   if (!txid || !/^(?!0{64}$)[0-9a-f]{64}$/.test(txid)) throw new Error('Turing Wallet did not return a single payment TXID. Check its transaction history before retrying; the payment request remains reserved.');
   rememberSourcePayment(order, { attemptId: request.attemptId, txid });
   const saved = await submitSourcePayment(order, settlement, request.attemptId, txid);
   rememberSourcePayment(order, null);
   if (live()) setState({ context, receipt: saved, loaded: true, error: '' });
  } catch (cause) {
   if (live()) {
    let saved: Receipt | null = null, loaded = !reserved;
    try { saved = await loadSourcePayment(order, settlement, AbortSignal.timeout(20_000)); loaded = true; } catch { loaded = false; }
    if (live()) setState({ context, receipt: saved, loaded, error: `${getErrorMessage(cause)}${pendingSourcePayment(order) ? ` Saved payment TXID: ${pendingSourcePayment(order)!.txid}. Refresh payment status to recover it; do not pay again.` : ''}` });
   }
  } finally { working.current = false; session.setBusy(false); if (live()) setAction(''); }
 }
 async function discard() {
  if (!receipt || !notSent || busy || working.current || pendingSourcePayment(order)) return;
  working.current = true; setAction('cancel');
  try { const saved = await cancelSourcePayment(order, settlement, receipt.attemptId); if (live()) { setState({ context, receipt: saved, loaded: true, error: '' }); setNotSent(false); } }
  catch (cause) { if (live()) setState(old => ({ ...old, error: getErrorMessage(cause) })); }
  finally { working.current = false; if (live()) setAction(''); }
 }
 return <div className="htlc-section" aria-busy={!!action}>
  {(!receipt || receipt.status === 'cancelled') && <>
   <p>Review the payment in Turing Wallet. The token, amount and address are filled in automatically.</p>
   <button type="button" disabled={!canPay} onClick={() => { void pay(); }}>{action === 'pay' ? 'Confirm in Turing Wallet…' : `Pay ${formatRawAmount(order.amountRaw, order.decimals)} ${order.symbol} with Turing Wallet`}</button>
   <p className="history-note">Already paid this order? Use “Already paid or need recovery?” below. Do not send a second payment.</p>
  </>}
  {receipt?.status === 'awaiting_wallet' && <>
   <p role="status">{action === 'pay' ? 'Open Turing Wallet and approve or reject the payment. Keep this page open.' : 'A payment request was started. Check Turing Wallet history and recover its TXID below if it was sent. Do not pay again.'}</p>
   {!action && <details><summary>No payment was sent?</summary><label className="bridge-role-choice"><input type="checkbox" checked={notSent} disabled={busy} onChange={event => setNotSent(event.target.checked)} /> I checked Turing Wallet and confirmed the request was rejected or never sent.</label><button type="button" className="history-secondary" disabled={!notSent || busy || !!pendingSourcePayment(order)} onClick={() => { void discard(); }}>Clear unsent payment request</button></details>}
  </>}
  {receipt?.txid && <><p role="status">Payment submitted. Checking the source transaction—do not pay again.</p><p className="history-note">TBC TXID: <code>{receipt.txid}</code></p><ConfirmationUpdates automatic={updates.automatic} onChange={updates.setAutomatic} paused={updates.paused} /><button type="button" className="history-secondary" disabled={busy || !!action} onClick={() => { if (receipt.txid) void verify(receipt.txid); }}>Check payment now</button></>}
  {visible.error && <p className="result error" role="alert">{visible.error}</p>}
  {!action && <button type="button" className="history-secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh payment status</button>}
 </div>;
}
