import type { Token } from '../types/api';
import type { BridgeFtAsset, VerifiedBridgeAsset } from '../types/learningBridge';
import { getTokenInfo } from './tbcApi';
import { backendData } from './backendClient';
import { isObject } from './apiValidation';
import { bridgeRouteId } from '../../../shared/src/config/bridgeRoutes';

export function ftContractId(value: string): string {
	const id = value.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(id) || /^0+$/.test(id)) throw new Error('The FT Contract ID must be a nonzero 64-character hex value.');
	return id;
}

function ftDecimals(value: Token['decimal']): number {
	if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,3}$/.test(value)))
		|| !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 255) {
		throw new Error('This FT has missing or invalid decimals. Select another token or refresh its metadata.');
	}
	return Number(value);
}

// Metadata is a preview. The settlement backend must independently validate the FT genesis and deposits.
export async function loadBridgeFtAsset(contractId: string, signal: AbortSignal): Promise<BridgeFtAsset> {
	const id = ftContractId(contractId);
	const token = await getTokenInfo(id, { signal });
	if (ftContractId(token.contract_id) !== id) throw new Error('The returned FT metadata belongs to a different Contract ID.');
	return {
		contractId: id,
		name: token.name || 'Unnamed FT',
		symbol: token.symbol || 'FT',
		decimals: ftDecimals(token.decimal),
	};
}

export async function verifyBridgeFtAsset(asset: BridgeFtAsset, signal: AbortSignal): Promise<VerifiedBridgeAsset> {
	const value: unknown = await backendData('/api/bridge/assets/verify', { contractId: asset.contractId }, true, signal);
	if (!isObject(value) || value.routeId !== bridgeRouteId(asset.contractId) || value.sourceNetwork !== 'testnet'
		|| value.protocol !== 'legacy-ft' || value.destinationChainId !== 998 || value.contractId !== asset.contractId
		|| value.name !== asset.name || value.symbol !== asset.symbol || value.decimals !== asset.decimals
		|| typeof value.legacyVersion !== 'number' || !Number.isInteger(value.legacyVersion) || value.legacyVersion < 1 || value.legacyVersion > 4
		|| typeof value.totalSupplyRaw !== 'string' || !/^[1-9]\d{0,19}$/.test(value.totalSupplyRaw)
		|| typeof value.confirmations !== 'number' || !Number.isSafeInteger(value.confirmations) || value.confirmations < 6
		|| typeof value.genesisBlockHeight !== 'number' || !Number.isSafeInteger(value.genesisBlockHeight) || value.genesisBlockHeight < 0
		|| typeof value.mintSourceVout !== 'number' || !Number.isSafeInteger(value.mintSourceVout) || value.mintSourceVout < 0
		|| typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))
		|| value.verificationMethod !== 'tbc-contract-1.7.3-published-genesis-v1'
		|| ['genesisCodeHash', 'genesisTapeHash', 'mintSourceTxid', 'genesisBlockHash'].some((key) => typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key] as string))) {
		throw new Error('The asset verification response does not match the selected FT. Refresh the token data and try again.');
	}
	return value as unknown as VerifiedBridgeAsset;
}
