import type { BridgeOrder, BridgeSettlement, BridgeSourcePayment } from '../../../shared/src/types/learningBridge';
import { backendData, getBackendSession } from './backendClient';
import { isObject } from './apiValidation';
const txidPattern = /^(?!0{64}$)[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function path(order: BridgeOrder, suffix = '') {
 if (!uuid.test(order.id)) throw new Error('Invalid order ID.');
 return `/api/bridge/orders/${order.id}/settlement/payment${suffix}`;
}
function validate(value: unknown, order: BridgeOrder, settlement: BridgeSettlement): BridgeSourcePayment | null {
 if (value === null) return null;
 if (!isObject(value) || value.orderId !== order.id || typeof value.attemptId !== 'string' || !uuid.test(value.attemptId)
  || !['awaiting_wallet', 'submitted', 'cancelled'].includes(String(value.status)) || value.sender !== order.sender || value.contractId !== order.contractId
  || value.amountRaw !== order.amountRaw || value.decimals !== order.decimals || value.custodyAddress !== settlement.custodyAddress
  || (value.status === 'submitted' ? typeof value.txid !== 'string' || !txidPattern.test(value.txid) : value.txid !== null)) throw new Error('The saved payment request differs from this order. Refresh saved progress.');
 return value as unknown as BridgeSourcePayment;
}
export async function loadSourcePayment(order: BridgeOrder, settlement: BridgeSettlement, signal: AbortSignal) {
 return validate(await backendData(path(order), undefined, true, signal), order, settlement);
}
export async function beginSourcePayment(order: BridgeOrder, settlement: BridgeSettlement, signal: AbortSignal) {
 const receipt = validate(await backendData(path(order, '/begin'), { acknowledged: true }, true, signal), order, settlement);
 if (!receipt || receipt.status !== 'awaiting_wallet') throw new Error('The payment request could not be opened. Check saved progress before paying.');
 return receipt;
}
export async function submitSourcePayment(order: BridgeOrder, settlement: BridgeSettlement, attemptId: string, txid: string) {
 if (getBackendSession()?.identity.address !== order.sender) throw new Error('Reconnect the original TBC wallet to save the payment TXID. Do not pay again.');
 const receipt = validate(await backendData(path(order, '/submit'), { attemptId, txid }, true, AbortSignal.timeout(20_000)), order, settlement);
 if (!receipt || receipt.attemptId !== attemptId || receipt.status !== 'submitted' || receipt.txid !== txid) throw new Error('The payment receipt was not acknowledged. Do not pay again.');
 return receipt;
}
export async function cancelSourcePayment(order: BridgeOrder, settlement: BridgeSettlement, attemptId: string) {
 const receipt = validate(await backendData(path(order, '/cancel'), { attemptId, notSent: true }, true, AbortSignal.timeout(20_000)), order, settlement);
 if (!receipt || receipt.attemptId !== attemptId || receipt.status !== 'cancelled') throw new Error('Refresh the saved payment request.');
 return receipt;
}
// Public receipts only. Retain before an API save, including across refreshes.
const memory = new Map<string, { attemptId: string; txid: string }>();
const key = (order: BridgeOrder) => `bridge-source-payment:${order.sender}:${order.id}`;
export function pendingSourcePayment(order: BridgeOrder) {
 const cached = memory.get(key(order));
 if (cached) return cached;
 try {
  const value: unknown = JSON.parse(localStorage.getItem(key(order)) ?? 'null');
  if (isObject(value) && typeof value.attemptId === 'string' && uuid.test(value.attemptId) && typeof value.txid === 'string' && txidPattern.test(value.txid)) return { attemptId: value.attemptId, txid: value.txid };
 } catch { /* Recover from Turing Wallet history when browser storage is unavailable. */ }
 return null;
}
export function rememberSourcePayment(order: BridgeOrder, value: { attemptId: string; txid: string } | null) {
 if (value) memory.set(key(order), value); else memory.delete(key(order));
 try { if (value) localStorage.setItem(key(order), JSON.stringify(value)); else localStorage.removeItem(key(order)); } catch { /* Keep the in-memory receipt. */ }
}
export function walletTokenAmount(raw: string, decimals: number) {
 const digits = raw.padStart(decimals + 1, '0');
 if (!decimals) return digits;
 const fraction = digits.slice(-decimals).replace(/0+$/, '');
 return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
