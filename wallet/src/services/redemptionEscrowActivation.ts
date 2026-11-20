import type { BridgeOrder, RedemptionEscrowActivationPreview, RedemptionEscrowActivationState, RedemptionEscrowActivationStatus, RedemptionEscrowDeployment, V15ActivationKind } from '../../../shared/src/types/learningBridge';
import { backendData } from './backendClient';
import { isObject } from './apiValidation';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/i.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x(?!0{40}$)[0-9a-f]{40}$/i.test(value);
const sameAddress = (left: unknown, right: unknown) => address(left) && address(right) && left.toLowerCase() === right.toLowerCase();
function path(order: BridgeOrder, escrow: RedemptionEscrowDeployment, suffix = '') {
	if (!uuid(order.id) || !uuid(escrow.id)) throw new Error('Invalid return escrow activation identifiers.');
	return `/api/bridge/orders/${order.id}/redemption/deployments/${escrow.id}/activation${suffix}`;
}
export async function getEscrowActivation(order: BridgeOrder, escrow: RedemptionEscrowDeployment, signal?: AbortSignal): Promise<RedemptionEscrowActivationState> {
	const value: unknown = await backendData(path(order, escrow), undefined, true, signal);
	if (!isObject(value) || value.escrowId !== escrow.id || !sameAddress(value.contractAddress, escrow.contractAddress) || !address(value.admin)
		|| !address(value.signer1) || !address(value.signer2) || typeof value.paused !== 'boolean' || value.active !== !value.paused) throw new Error('Invalid return escrow activation state.');
	return value as unknown as RedemptionEscrowActivationState;
}
export async function previewEscrowActivation(order: BridgeOrder, escrow: RedemptionEscrowDeployment, kind: V15ActivationKind, actionId?: string, signal?: AbortSignal): Promise<RedemptionEscrowActivationPreview> {
	const value: unknown = await backendData(path(order, escrow, '/preview'), { kind, ...(actionId ? { actionId } : {}) }, true, signal);
	if (!isObject(value) || value.escrowId !== escrow.id || value.kind !== kind || !hash(value.actionId) || !isObject(value.transaction)
		|| !address(value.transaction.from) || !sameAddress(value.transaction.to, escrow.quote.admin) || value.transaction.chainId !== '0x3e6'
		|| typeof value.sufficientBalance !== 'boolean' || value.confirmationsRequired !== 6) throw new Error('Invalid return escrow activation preview.');
	return value as unknown as RedemptionEscrowActivationPreview;
}
export async function checkEscrowActivation(order: BridgeOrder, escrow: RedemptionEscrowDeployment, kind: V15ActivationKind, actionId: string, txHash: string, signal?: AbortSignal): Promise<RedemptionEscrowActivationStatus> {
	const value: unknown = await backendData(path(order, escrow, '/check'), { kind, actionId, txHash }, true, signal);
	if (!isObject(value) || value.escrowId !== escrow.id || value.kind !== kind || value.actionId !== actionId || value.txHash !== txHash
		|| !['pending', 'confirming', 'verified', 'reverted', 'invalid'].includes(String(value.status)) || typeof value.paused !== 'boolean') throw new Error('Invalid return escrow activation status.');
	return value as unknown as RedemptionEscrowActivationStatus;
}
export interface SavedEscrowActivation { actionId: string; proposalHash: string; approvalHash?: string }
export function savedEscrowActivation(id: string): SavedEscrowActivation | null {
	try { const value: unknown = JSON.parse(sessionStorage.getItem(`redemption-escrow-activation:${id}`) ?? 'null');
		if (isObject(value) && hash(value.actionId) && hash(value.proposalHash) && (value.approvalHash === undefined || hash(value.approvalHash))) return value as unknown as SavedEscrowActivation;
	} catch { /* Recovery remains available from MetaMask Activity. */ }
	return null;
}
export function saveEscrowActivation(id: string, value: SavedEscrowActivation | null) {
	try { if (value) sessionStorage.setItem(`redemption-escrow-activation:${id}`, JSON.stringify(value)); else sessionStorage.removeItem(`redemption-escrow-activation:${id}`); } catch { /* Keep the current component state. */ }
}
