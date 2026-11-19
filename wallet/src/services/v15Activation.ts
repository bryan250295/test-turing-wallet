import { encodeFunctionData, parseAbi } from 'viem';
import type { BridgeDeploymentRecord, V15ActivationKind, V15ActivationPreview, V15ActivationState, V15ActivationStatus } from '../types/learningBridge';
import { backendData } from './backendClient';
import { deploymentAddress } from './bridgeDeployment';
import { isObject } from './apiValidation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^0x(?!0{64}$)[0-9a-f]{64}$/i;
const quantity = /^(0|[1-9]\d{0,77})$/;
const adminAbi = parseAbi([
	'function propose(address target, bytes data) returns (bytes32 actionId)',
	'function approveAndExecute(bytes32 actionId) returns (bytes returnData)',
]);
const wrappedAbi = parseAbi(['function unpause()']);
const unpauseData = encodeFunctionData({ abi: wrappedAbi, functionName: 'unpause' });

function path(id: string) {
	if (!uuid.test(id)) throw new Error('Invalid V1.5 deployment ID.');
	return `/api/bridge/deployments/${id}/v15/activation`;
}
function actionId(value: unknown) {
	if (typeof value !== 'string' || !hash.test(value)) throw new Error('Invalid multisig activation action ID.');
	return value.toLowerCase();
}

export async function getV15ActivationState(row: BridgeDeploymentRecord, signal?: AbortSignal): Promise<V15ActivationState> {
	const value: unknown = await backendData(path(row.id), undefined, true, signal);
	if (!isObject(value) || value.deploymentId !== row.id || value.contractAddress !== row.contractAddress || value.admin !== row.admin || value.minter !== row.minter
		|| typeof value.paused !== 'boolean' || value.active !== !value.paused || typeof value.signer1 !== 'string' || typeof value.signer2 !== 'string') throw new Error('Invalid V1.5 activation state.');
	for (const address of [value.contractAddress, value.admin, value.minter, value.signer1, value.signer2]) deploymentAddress(address as string);
	return value as unknown as V15ActivationState;
}

export async function previewV15Activation(row: BridgeDeploymentRecord, state: V15ActivationState, kind: V15ActivationKind, savedActionId?: string, signal?: AbortSignal): Promise<V15ActivationPreview> {
	const body = { kind, ...(savedActionId ? { actionId: actionId(savedActionId) } : {}) };
	const value: unknown = await backendData(`${path(row.id)}/preview`, body, true, signal);
	if (!isObject(value) || !isObject(value.transaction) || value.deploymentId !== row.id || value.kind !== kind || value.confirmationsRequired !== 6
		|| !['gasEstimate', 'gasLimit', 'gasPriceWei', 'bufferedFeeWei', 'balanceWei'].every((key) => typeof value[key] === 'string' && quantity.test(value[key] as string))
		|| typeof value.sufficientBalance !== 'boolean') throw new Error('Invalid V1.5 activation preview.');
	const id = actionId(value.actionId);
	if (kind === 'approve' && id !== savedActionId?.toLowerCase()) throw new Error('The approval action differs from the verified proposal.');
	const tx = value.transaction;
	const expectedFrom = kind === 'propose' ? state.signer1 : state.signer2;
	const expectedData = kind === 'propose'
		? encodeFunctionData({ abi: adminAbi, functionName: 'propose', args: [state.contractAddress as `0x${string}`, unpauseData] })
		: encodeFunctionData({ abi: adminAbi, functionName: 'approveAndExecute', args: [id as `0x${string}`] });
	if (tx.from !== expectedFrom || tx.to !== state.admin || tx.chainId !== '0x3e6' || tx.value !== '0x0' || tx.data !== expectedData
		|| !['gas', 'gasPrice', 'nonce'].every((key) => typeof tx[key] === 'string' && /^0x[0-9a-f]+$/i.test(tx[key] as string))) throw new Error('The activation transaction differs from the reviewed multisig action.');
	return value as unknown as V15ActivationPreview;
}

export async function checkV15Activation(row: BridgeDeploymentRecord, kind: V15ActivationKind, savedActionId: string, txHash: string, signal?: AbortSignal): Promise<V15ActivationStatus> {
	const id = actionId(savedActionId);
	if (!hash.test(txHash)) throw new Error('Invalid activation transaction hash.');
	const value: unknown = await backendData(`${path(row.id)}/check`, { kind, actionId: id, txHash: txHash.toLowerCase() }, true, signal);
	if (!isObject(value) || value.deploymentId !== row.id || value.kind !== kind || value.actionId !== id || value.txHash !== txHash.toLowerCase()
		|| !['pending', 'confirming', 'verified', 'reverted', 'invalid'].includes(String(value.status)) || typeof value.confirmations !== 'number' || !Number.isSafeInteger(value.confirmations) || value.confirmations < 0 || value.confirmationsRequired !== 6
		|| value.actualFeeWei !== null && (typeof value.actualFeeWei !== 'string' || !quantity.test(value.actualFeeWei)) || typeof value.paused !== 'boolean' || value.lastError !== null && typeof value.lastError !== 'string') throw new Error('Invalid V1.5 activation status.');
	return value as unknown as V15ActivationStatus;
}

export interface SavedV15Activation { actionId: string; proposalHash: string; approvalHash?: string }
const storageKey = (id: string) => `bridge-v15-route-activation:${id}`;
export function savedV15Activation(id: string): SavedV15Activation | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(storageKey(id)) ?? 'null');
		return isObject(value) && typeof value.actionId === 'string' && hash.test(value.actionId) && typeof value.proposalHash === 'string' && hash.test(value.proposalHash)
			&& (value.approvalHash === undefined || typeof value.approvalHash === 'string' && hash.test(value.approvalHash))
			? { actionId: value.actionId.toLowerCase(), proposalHash: value.proposalHash.toLowerCase(), ...(value.approvalHash ? { approvalHash: value.approvalHash.toLowerCase() } : {}) } : null;
	} catch { return null; }
}
export function saveV15Activation(id: string, saved: SavedV15Activation | null) {
	if (!uuid.test(id)) throw new Error('Invalid V1.5 deployment ID.');
	if (saved) localStorage.setItem(storageKey(id), JSON.stringify(saved)); else localStorage.removeItem(storageKey(id));
}
