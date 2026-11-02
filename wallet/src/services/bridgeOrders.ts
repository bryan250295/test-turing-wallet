import type { BridgeOrder, BridgeOrderInput, BridgeOrderSetup } from '../types/learningBridge';
import { LEARNING_BRIDGE_ORDERS as rules } from '../../../shared/src/config/learningBridge';
import { validWrappedName, validWrappedSymbol } from '../../../shared/src/config/bridgeRoutes';
import { backendData } from './backendClient';
import { isObject } from './apiValidation';

const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const address = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function order(value: unknown): BridgeOrder {
	if (!isObject(value) || !uuid(value.id) || !uuid(value.deploymentId)
		|| !['prepared', 'cancelled'].includes(String(value.status)) || value.sourceNetwork !== 'testnet'
		|| typeof value.contractId !== 'string' || !/^(?!0{64}$)[0-9a-f]{64}$/.test(value.contractId) || typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255 || typeof value.symbol !== 'string' || !value.symbol || value.symbol.length > 100 || !validWrappedName(value.wrappedName) || !validWrappedSymbol(value.wrappedSymbol)
		|| typeof value.amountRaw !== 'string' || !/^[1-9]\d{0,19}$/.test(value.amountRaw) || BigInt(value.amountRaw) > 18446744073709551615n
		|| typeof value.sender !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value.sender)
		|| !address(value.recipient) || !address(value.destinationContract) || value.destinationChainId !== 998
		|| value.sourceConfirmationsRequired !== rules.sourceConfirmations || value.destinationConfirmationsRequired !== rules.destinationConfirmations
		|| typeof value.termsHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.termsHash) || value.policyVersion !== rules.policyVersion
		|| !isObject(value.custody) || value.custody.allocated !== true || value.custody.encrypted !== true || value.custody.address !== null || typeof value.custody.paymentEnabled !== 'boolean'
		|| value.depositTxHash !== null || value.mintTxHash !== null || value.paymentDeadline !== null || !date(value.createdAt)
		|| typeof value.settlementStarted !== 'boolean' || (value.settlementStatus !== null && !['awaiting_payment', 'confirming', 'ready_to_mint', 'mint_pending', 'completed', 'needs_review'].includes(String(value.settlementStatus)))
		|| value.settlementStarted !== (value.settlementStatus !== null) || (value.status === 'cancelled' ? !date(value.cancelledAt) : value.cancelledAt !== null)) {
		throw new Error('The saved order response is invalid. Refresh saved orders before continuing.');
	}
	return value as unknown as BridgeOrder;
}

export async function loadBridgeOrderSetup(signal: AbortSignal): Promise<BridgeOrderSetup> {
	const value: unknown = await backendData('/api/bridge/orders/setup', undefined, true, signal);
	if (!isObject(value) || typeof value.custodyReady !== 'boolean' || value.paymentEnabled !== value.custodyReady
		|| value.maxOpenOrders !== rules.maxOpenOrders || typeof value.message !== 'string'
		|| !Array.isArray(value.deployments) || value.deployments.length > 200
		|| value.deployments.some((row: unknown) => !isObject(row) || !uuid(row.id) || !address(row.contractAddress) || !address(row.deployer) || !date(row.verifiedAt) || typeof row.contractId !== 'string' || !/^[0-9a-f]{64}$/.test(row.contractId) || typeof row.decimals !== 'number' || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 255 || typeof row.sourceSymbol !== 'string' || !row.sourceSymbol || !validWrappedName(row.wrappedName) || !validWrappedSymbol(row.wrappedSymbol))) {
		throw new Error('The bridge order setup is unavailable. Refresh saved orders.');
	}
	return value as unknown as BridgeOrderSetup;
}
export async function listBridgeOrders(signal: AbortSignal): Promise<BridgeOrder[]> {
	const value: unknown = await backendData('/api/bridge/orders', undefined, true, signal);
	if (!Array.isArray(value) || value.length > 20) throw new Error('The saved order list is invalid.');
	return value.map(order);
}
export async function prepareBridgeOrder(input: BridgeOrderInput, signal: AbortSignal) {
	return order(await backendData('/api/bridge/orders', input, true, signal));
}
export async function cancelBridgeOrder(id: string, signal: AbortSignal) {
	if (!uuid(id)) throw new Error('Invalid order ID.');
	return order(await backendData(`/api/bridge/orders/${id}/cancel`, {}, true, signal));
}
