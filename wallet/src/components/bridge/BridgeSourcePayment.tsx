import { useEffect, useRef, useState } from 'react';
import type { BridgeOrder, BridgeSettlement, BridgeSourcePayment as Receipt } from '../../../../shared/src/types/learningBridge';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import { DEVNET_DOMAIN } from '../../config/constants';
import { beginSourcePayment, cancelSourcePayment, loadSourcePayment, pendingSourcePayment, rememberSourcePayment, submitSourcePayment, walletTokenAmount } from '../../services/bridgeSourcePayment';
import { formatRawAmount } from '../../utils/tokenAmounts';
import { getErrorMessage } from '../../utils/errors';

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
 const canPrepare = enabled && visible.loaded && !busy && !action && !visible.error && !pendingSourcePayment(order) && (!receipt || receipt.status === 'cancelled');
 const canOpenWallet = enabled && visible.loaded && !busy && !action && !pendingSourcePayment(order) && receipt?.status === 'awaiting_wallet';
 useEffect(() => {
  if (!receipt?.txid || busy || action || verificationError || visible.error || !enabled || verifiedTxid.current === receipt.txid) return;
  verifiedTxid.current = receipt.txid;
  void verify(receipt.txid);
 }, [receipt?.txid, busy, action, verificationError, visible.error, enabled]);
 async function verifyWallet() {
  const [network, addresses] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress()]);
  const address = addresses as WalletAddresses | undefined;
  if (!live() || !enabled || network?.network !== 'tbc' || network.type !== 'testnet' || (address?.tbcAddress ?? address?.addresses?.tbcAddress) !== order.sender) throw new Error('Reconnect the original TBC wallet on Testnet. No new wallet prompt was opened.');
 }
 async function prepare() {
  if (!canPrepare || working.current) return;
  working.current = true; setAction('prepare'); session.setBusy(true);
  try {
   await verifyWallet();
   const request = await beginSourcePayment(order, settlement, AbortSignal.timeout(20_000));
   if (live()) setState({ context, receipt: request, loaded: true, error: '' });
  } catch (cause) {
   if (live()) setState(old => ({ ...old, loaded: true, error: getErrorMessage(cause) }));
  } finally { working.current = false; session.setBusy(false); if (live()) setAction(''); }
 }
 async function pay() {
  if (!canOpenWallet || !receipt || working.current) return;
  working.current = true;
  // Call the wallet immediately in the click event. Awaiting a backend request first
  // can consume the browser's user activation and prevent the wallet from opening.
  let walletRequest: ReturnType<typeof session.wallet.sendTransaction>;
  try {
   if (session.address !== order.sender || !session.networkIsDevnet) throw new Error('Reconnect the original TBC wallet on Testnet before opening this payment.');
   walletRequest = order.sourceAssetKind === 'native-tbc'
    ? session.wallet.sendTransaction([{ flag: 'P2PKH', address: receipt.custodyAddress, satoshis: order.amountRaw, broadcastEnabled: true, domain: DEVNET_DOMAIN }])
    : session.wallet.sendTransaction([{ flag: 'FT_TRANSFER', ft_contract_address: order.contractId, address: receipt.custodyAddress,
     ft_amount: walletTokenAmount(order.amountRaw, order.decimals), broadcastEnabled: true, domain: DEVNET_DOMAIN }]);
  } catch (cause) {
   working.current = false;
   if (live()) setState(old => ({ ...old, error: getErrorMessage(cause) }));
   return;
  }
  setAction('pay'); session.setBusy(true);
  try {
   const result = await walletRequest;
   const txid = result?.txid?.trim().toLowerCase();
   if (!txid || !/^(?!0{64}$)[0-9a-f]{64}$/.test(txid)) throw new Error(result?.error || 'Turing Wallet did not return a payment TXID. Check its transaction history before retrying; the prepared payment remains reserved.');
   rememberSourcePayment(order, { attemptId: receipt.attemptId, txid });
   const saved = await submitSourcePayment(order, settlement, receipt.attemptId, txid);
   rememberSourcePayment(order, null);
   if (live()) setState({ context, receipt: saved, loaded: true, error: '' });
  } catch (cause) {
   if (live()) {
    let saved: Receipt | null = receipt, loaded = true;
    try { saved = await loadSourcePayment(order, settlement, AbortSignal.timeout(20_000)); } catch { /* Keep the prepared request visible. */ }
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
   <p>Prepare the exact token amount and unique custody address. This step does not open the wallet or send a transaction.</p>
   <button type="button" disabled={!canPrepare} onClick={() => { void prepare(); }}>{action === 'prepare' ? 'Preparing payment…' : 'Prepare Turing Wallet payment'}</button>
  </>}
  {receipt?.status === 'awaiting_wallet' && <>
   <p role="status">{action === 'pay' ? 'Review and approve or reject the payment in Turing Wallet. Keep this page open.' : 'Payment details are prepared. The next button opens exactly one Turing Wallet request.'}</p>
   <button type="button" disabled={!canOpenWallet} onClick={() => { void pay(); }}>{action === 'pay' ? 'Waiting for Turing Wallet…' : `Open Turing Wallet · Pay ${formatRawAmount(order.amountRaw, order.decimals)} ${order.symbol}`}</button>
   <p className="history-note">Already paid this order? Use “Already paid or need recovery?” below. Do not send a second payment.</p>
   {!action && <details><summary>No payment was sent?</summary><label className="bridge-role-choice"><input type="checkbox" checked={notSent} disabled={busy} onChange={event => setNotSent(event.target.checked)} /> I checked Turing Wallet and confirmed the request was rejected or never sent.</label><button type="button" className="history-secondary" disabled={!notSent || busy || !!pendingSourcePayment(order)} onClick={() => { void discard(); }}>Clear unsent payment request</button></details>}
  </>}
  {receipt?.txid && <><p role="status">Payment submitted. The backend checks it about once per minute—do not pay again.</p><p className="history-note">TBC TXID: <code>{receipt.txid}</code></p></>}
  {visible.error && <p className="result error" role="alert">{visible.error}</p>}
  {!action && <button type="button" className="history-secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh payment status</button>}
 </div>;
}
