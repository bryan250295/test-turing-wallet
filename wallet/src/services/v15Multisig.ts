import { encodeDeployData } from 'viem';
import { BRIDGE_ADMIN_MULTISIG_BUILD as build } from '../../../shared/src/contracts/bridgeAdminMultisig';
import type { V15MultisigDeploymentPreview, V15MultisigDeploymentStatus, V15OperatorRoles } from '../types/learningBridge';
import { backendData } from './backendClient';
import { deploymentAddress } from './bridgeDeployment';
import { isObject } from './apiValidation';

const txHashPattern = /^0x(?!0{64}$)[0-9a-f]{64}$/i;
const quantity = /^(0|[1-9]\d{0,77})$/;

function roles(value: unknown): V15OperatorRoles {
	if (!isObject(value) || value.threshold !== 2 || typeof value.signer1 !== 'string' || typeof value.signer2 !== 'string' || typeof value.minter !== 'string') throw new Error('Invalid V1.5 operator configuration.');
	const result = { signer1: deploymentAddress(value.signer1), signer2: deploymentAddress(value.signer2), minter: deploymentAddress(value.minter), threshold: 2 as const };
	if (new Set([result.signer1, result.signer2, result.minter].map((address) => address.toLowerCase())).size !== 3) throw new Error('The two signers and minter must be separate addresses.');
	return result;
}

export async function getV15Roles(signal?: AbortSignal) {
	return roles(await backendData('/api/bridge/deployments/v15/roles', undefined, true, signal));
}

export async function previewV15Multisig(deployer: string, signal?: AbortSignal): Promise<V15MultisigDeploymentPreview> {
	const value: unknown = await backendData('/api/bridge/deployments/v15/multisig/preview', { deployer: deploymentAddress(deployer) }, true, signal);
	if (!isObject(value) || !isObject(value.transaction) || typeof value.deployer !== 'string' || typeof value.predictedAddress !== 'string' || typeof value.initCodeHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.initCodeHash)
		|| !['gasEstimate', 'gasLimit', 'gasPriceWei', 'bufferedFeeWei', 'balanceWei'].every((key) => typeof value[key] === 'string' && quantity.test(value[key] as string))
		|| typeof value.sufficientBalance !== 'boolean' || value.confirmationsRequired !== 6) throw new Error('Invalid multisig deployment preview.');
	const configured = roles(value.roles);
	const expectedData = encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [configured.signer1 as `0x${string}`, configured.signer2 as `0x${string}`] });
	const tx = value.transaction;
	if (tx.from !== value.deployer || tx.chainId !== '0x3e6' || tx.value !== '0x0' || tx.data !== expectedData || 'to' in tx
		|| !['gas', 'gasPrice', 'nonce'].every((key) => typeof tx[key] === 'string' && /^0x[0-9a-f]+$/i.test(tx[key] as string))) throw new Error('The multisig transaction differs from the pinned build or configured signers.');
	deploymentAddress(value.deployer); deploymentAddress(value.predictedAddress);
	return { ...(value as unknown as V15MultisigDeploymentPreview), roles: configured };
}

export async function checkV15Multisig(txHash: string, signal?: AbortSignal): Promise<V15MultisigDeploymentStatus> {
	if (!txHashPattern.test(txHash)) throw new Error('Invalid multisig deployment transaction hash.');
	const value: unknown = await backendData('/api/bridge/deployments/v15/multisig/check', { txHash }, true, signal);
	if (!isObject(value) || value.txHash !== txHash.toLowerCase() || !['pending', 'confirming', 'verified', 'reverted', 'invalid'].includes(String(value.status))
		|| typeof value.confirmations !== 'number' || !Number.isSafeInteger(value.confirmations) || value.confirmations < 0 || value.confirmationsRequired !== 6
		|| value.contractAddress !== null && typeof value.contractAddress !== 'string' || value.actualFeeWei !== null && (typeof value.actualFeeWei !== 'string' || !quantity.test(value.actualFeeWei))
		|| value.lastError !== null && typeof value.lastError !== 'string') throw new Error('Invalid multisig deployment status.');
	if (value.contractAddress) deploymentAddress(value.contractAddress);
	return value as unknown as V15MultisigDeploymentStatus;
}

export function savedV15Multisig(): { txHash: string } | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem('bridge-v15-admin-multisig') ?? 'null');
		return isObject(value) && typeof value.txHash === 'string' && txHashPattern.test(value.txHash) ? { txHash: value.txHash.toLowerCase() } : null;
	} catch { return null; }
}

export function saveV15Multisig(txHash: string) {
	if (!txHashPattern.test(txHash)) throw new Error('Invalid multisig deployment transaction hash.');
	localStorage.setItem('bridge-v15-admin-multisig', JSON.stringify({ txHash: txHash.toLowerCase() }));
}

export function clearSavedV15Multisig() {
	localStorage.removeItem('bridge-v15-admin-multisig');
}
