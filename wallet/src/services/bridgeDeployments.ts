import { expectedDeploymentData } from './bridgeDeploymentData';
import { LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import type { BridgeDeploymentInput, BridgeDeploymentRecord, BridgeDeploymentTransaction } from '../types/learningBridge';
import { backendData, getBackendSession } from './backendClient';
import { deploymentAddress, validateDeploymentPreview } from './bridgeDeployment';
import { isObject } from './apiValidation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^0x(?!0{64}$)[0-9a-f]{64}$/i;
function idPath(id: string) { if (!uuid.test(id)) throw new Error('Invalid deployment record ID.'); return `/api/bridge/deployments/${id}`; }
export function deploymentRecord(value: unknown): BridgeDeploymentRecord {
	if (!isObject(value) || typeof value.id !== 'string' || !uuid.test(value.id) || typeof value.contractId !== 'string' || !/^(?!0{64}$)[0-9a-f]{64}$/.test(value.contractId) || value.chainId !== 998 || typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255
		|| ['deployer', 'admin', 'minter'].some((key) => typeof value[key] !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value[key] as string))
		|| !['prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified', 'reverted', 'invalid', 'cancelled'].includes(String(value.status))
		|| typeof value.nonce !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value.nonce) || BigInt(value.nonce) > BigInt(Number.MAX_SAFE_INTEGER)
		|| typeof value.confirmations !== 'number' || !Number.isSafeInteger(value.confirmations) || value.confirmations < 0 || value.requiredConfirmations !== LEARNING_BRIDGE_EVM.deploymentConfirmations
		|| ['txHash', 'receiptBlockHash', 'runtimeCodeHash'].some((key) => value[key] !== null && (typeof value[key] !== 'string' || !hash.test(value[key] as string)))
		|| ['receiptBlockNumber', 'gasUsed', 'effectiveGasPriceWei', 'actualFeeWei'].some((key) => value[key] !== null && (typeof value[key] !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value[key] as string)))
		|| ['createdAt', 'expiresAt'].some((key) => typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key] as string)))
		|| ['verifiedAt', 'checkedAt'].some((key) => value[key] !== null && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key] as string))))
		|| (value.lastError !== null && typeof value.lastError !== 'string')) throw new Error('Invalid saved deployment response. Refresh its records.');
	const row = value as unknown as BridgeDeploymentRecord;
	for (const address of [row.deployer, row.admin, row.minter, ...(row.contractAddress ? [row.contractAddress] : [])]) deploymentAddress(address);
	if (value.contractAddress !== null && typeof value.contractAddress !== 'string') throw new Error('Invalid saved contract address.');
	validateDeploymentPreview(row.quote, row, true);
	if (row.expiresAt !== row.quote.expiresAt || (row.status === 'verified' && (!row.txHash || !row.contractAddress || !row.runtimeCodeHash || !row.verifiedAt || row.confirmations < row.requiredConfirmations))) throw new Error('The deployment verification result is incomplete. Refresh its status.');
	return row;
}

export async function listDeployments(signal: AbortSignal, contractId?: string) {
	const value: unknown = await backendData(`/api/bridge/deployments${contractId ? `?contractId=${encodeURIComponent(contractId)}` : ''}`, undefined, true, signal);
	if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid deployment history response.');
	const records = value.map(deploymentRecord);
    if (contractId && records.some(row => row.contractId !== contractId)) throw new Error('Deployment records do not match the selected token.');
    return records;
}
export async function prepareDeployment(input: BridgeDeploymentInput, signal: AbortSignal) {
	const roles = { ...input, deployer: deploymentAddress(input.deployer), admin: deploymentAddress(input.admin), minter: deploymentAddress(input.minter) };
	return deploymentRecord(await backendData('/api/bridge/deployments/prepare', roles, true, signal));
}
export async function cancelDeployment(id: string) { return deploymentRecord(await backendData(`${idPath(id)}/cancel`, {}, true)); }
export async function checkDeployment(id: string, signal: AbortSignal) { return deploymentRecord(await backendData(`${idPath(id)}/check`, {}, true, signal)); }
export async function attachDeploymentHash(id: string, txHash: string) {
	if (!hash.test(txHash)) throw new Error('Enter the deployment transaction hash from MetaMask activity.');
	return deploymentRecord(await backendData(`${idPath(id)}/submit`, { txHash }, true));
}
export async function beginDeployment(row: BridgeDeploymentRecord, signal: AbortSignal): Promise<BridgeDeploymentTransaction> {
	const value: unknown = await backendData(`${idPath(row.id)}/begin`, {}, true, signal);
	if (!isObject(value) || value.id !== row.id || !isObject(value.transaction)) throw new Error('Invalid deployment authorization response.');
	const tx = value.transaction;
	// Constructor ABI is address,address,bytes32,uint8: compare every byte before
	// asking MetaMask. No address, value, gas or arbitrary call comes from UI input.
	const data = expectedDeploymentData(row.quote);
	if (tx.from !== row.deployer || tx.chainId !== '0x3e6' || tx.value !== '0x0' || tx.data !== data
		|| 'to' in tx || tx.gas !== `0x${BigInt(row.quote.gasLimit).toString(16)}` || tx.gasPrice !== `0x${BigInt(row.quote.gasPriceWei).toString(16)}` || tx.nonce !== `0x${BigInt(row.nonce).toString(16)}`) throw new Error('Deployment data differs from the reviewed build or roles. Check the saved record before proceeding.');
	return { from: row.deployer, chainId: '0x3e6', data, value: '0x0', gas: tx.gas as string, gasPrice: tx.gasPrice as string, nonce: tx.nonce as string };
}

// Temporary, public broadcast receipts only. The database remains authoritative;
// this pointer lets a returned hash survive a failed API save and page refresh.
const memory = new Map<string, Record<string, string>>();
export function pendingDeploymentHashes(owner: string): Record<string, string> {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(`bridge-deployment-receipts:${owner}`) ?? '{}');
		if (isObject(value)) {
			const valid: Record<string, string> = {};
			for (const [id, h] of Object.entries(value).slice(0, 20)) if (uuid.test(id) && typeof h === 'string' && hash.test(h)) valid[id] = h;
			return { ...valid, ...memory.get(owner) };
		}
	} catch { /* storage is optional; MetaMask activity is the final recovery path */ }
	return memory.get(owner) ?? {};
}
export function rememberDeploymentHash(owner: string, id: string, txHash: string | null) {
	const saved = { ...pendingDeploymentHashes(owner) };
	if (txHash) saved[id] = txHash; else delete saved[id];
	memory.set(owner, saved);
	try { sessionStorage.setItem(`bridge-deployment-receipts:${owner}`, JSON.stringify(saved)); } catch { /* keep the in-memory public receipt */ }
}
export async function saveBroadcastHash(owner: string, id: string, txHash: string) {
	rememberDeploymentHash(owner, id, txHash);
	if (getBackendSession()?.identity.address !== owner) throw new Error('Deployment submitted. Reconnect the original TBC wallet to save its transaction hash.');
	const saved = await attachDeploymentHash(id, txHash);
	rememberDeploymentHash(owner, id, null);
	return saved;
}
