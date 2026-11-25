import { backendData } from './backendClient';
import { isObject } from './apiValidation';

export interface EthereumSepoliaNativeRoute {
	id: string;
	chainId: 11_155_111;
	contractId: string;
	decimals: 6;
	sourceName: 'TBC';
	sourceSymbol: 'TBC';
	sourceAssetKind: 'native-tbc';
	wrappedName: 'Wrapped TBC';
	wrappedSymbol: 'wTBC';
	contractAddress: string;
	admin: string;
	minter: string;
	verifiedAt: string;
	active: true;
}

export interface EthereumSepoliaFtRoute {
	id: string;
	chainId: 11_155_111;
	contractId: string;
	decimals: number;
	sourceName: string;
	sourceSymbol: string;
	sourceAssetKind: 'fungible-token';
	wrappedName: string;
	wrappedSymbol: string;
	contractAddress: string;
	admin: string;
	minter: string;
	verifiedAt: string;
	active: true;
}

function ftRoute(value: unknown, contractId: string, wrappedToken: string): EthereumSepoliaFtRoute {
	if (!isObject(value) || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)
		|| value.chainId !== 11_155_111 || value.contractId !== contractId || typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255
		|| typeof value.sourceName !== 'string' || !value.sourceName || typeof value.sourceSymbol !== 'string' || !value.sourceSymbol || value.sourceAssetKind !== 'fungible-token'
		|| typeof value.wrappedName !== 'string' || !value.wrappedName || typeof value.wrappedSymbol !== 'string' || !value.wrappedSymbol
		|| typeof value.contractAddress !== 'string' || value.contractAddress.toLowerCase() !== wrappedToken.toLowerCase()
		|| typeof value.admin !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value.admin)
		|| typeof value.minter !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value.minter)
		|| typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt)) || value.active !== true) {
		throw new Error('The registered Ethereum Sepolia FT route response is invalid.');
	}
	return value as unknown as EthereumSepoliaFtRoute;
}

export async function loadEthereumSepoliaNativeRoute(signal: AbortSignal): Promise<EthereumSepoliaNativeRoute> {
	const value: unknown = await backendData('/api/bridge/ethereum-sepolia/route', undefined, true, signal);
	if (!isObject(value) || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)
		|| value.chainId !== 11_155_111 || typeof value.contractId !== 'string' || !/^[0-9a-f]{64}$/.test(value.contractId)
		|| value.decimals !== 6 || value.sourceName !== 'TBC' || value.sourceSymbol !== 'TBC' || value.sourceAssetKind !== 'native-tbc'
		|| value.wrappedName !== 'Wrapped TBC' || value.wrappedSymbol !== 'wTBC'
		|| typeof value.contractAddress !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value.contractAddress)
		|| typeof value.admin !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value.admin)
		|| typeof value.minter !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value.minter)
		|| typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt)) || value.active !== true) {
		throw new Error('The verified Ethereum Sepolia native TBC route response is invalid.');
	}
	return value as unknown as EthereumSepoliaNativeRoute;
}

export async function registerEthereumSepoliaFtRoute(contractId: string, wrappedToken: string, txHash: string, signal: AbortSignal): Promise<EthereumSepoliaFtRoute> {
	const value: unknown = await backendData('/api/bridge/ethereum-sepolia/route/ft', { contractId, wrappedToken, txHash }, true, signal);
	return ftRoute(value, contractId, wrappedToken);
}
