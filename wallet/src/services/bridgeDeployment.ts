import { LEARNING_BRIDGE_EVM as network } from '../../../shared/src/config/learningBridge';
import type { BridgeDeploymentInput, BridgeDeploymentPreview } from '../types/learningBridge';
import { validWrappedName, validWrappedSymbol } from '../../../shared/src/config/bridgeRoutes';
import { expectedDeploymentData } from './bridgeDeploymentData';
import { isObject } from './apiValidation';

export function deploymentAddress(value: string): string {
	const address = value.trim();
	if (!/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) throw new Error('Enter a nonzero public 0x wallet address for each role.');
	return address;
}

export function validateDeploymentPreview(value: unknown, input: BridgeDeploymentInput, allowExpired = false): BridgeDeploymentPreview {
	const quantities = ['gasEstimate', 'gasLimit', 'gasPriceWei', 'estimatedFeeWei', 'bufferedFeeWei', 'balanceWei', 'shortfallWei', 'blockNumber'];
	if (!isObject(value) || value.contractId !== input.contractId || value.chainId !== network.chainId || !['LearningWrappedFT', 'BridgeWrappedFT'].includes(String(value.contractName))
		|| ['deployer', 'admin', 'minter'].some((key) => typeof value[key] !== 'string' || (value[key] as string).toLowerCase() !== input[key as 'deployer' | 'admin' | 'minter'].toLowerCase())
		|| typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255 || value.initiallyPaused !== true || value.initialSupplyRaw !== '0' || value.gasBufferPercent !== network.gasBufferPercent
		|| ['buildInputSha256', 'sourceSha256'].some((key) => typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key] as string))
		|| typeof value.initCodeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.initCodeHash)
		|| quantities.some((key) => typeof value[key] !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value[key] as string) || BigInt(value[key] as string) >= 2n ** 256n)
		|| typeof value.sufficientBalance !== 'boolean'
		|| ['assetVerifiedAt', 'quotedAt', 'expiresAt'].some((key) => typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key] as string)))) {
		throw new Error('The deployment preview does not match the requested asset and roles. Estimate again.');
	}
	const quote = value as unknown as BridgeDeploymentPreview;
    if (quote.contractName === 'BridgeWrappedFT' && (!validWrappedName(quote.wrappedName) || !validWrappedSymbol(quote.wrappedSymbol)
        || quote.wrappedName !== input.wrappedName || quote.wrappedSymbol !== input.wrappedSymbol)) throw new Error('Wrapped token details differ from the reviewed name and symbol.');
    if (!allowExpired && (input.wrappedName !== undefined || input.wrappedSymbol !== undefined) && quote.contractName !== 'BridgeWrappedFT') throw new Error('The requested configurable wrapped token build was not returned.');
    expectedDeploymentData(quote);
	const gas = BigInt(quote.gasEstimate);
	const limit = (gas * BigInt(100 + network.gasBufferPercent) + 99n) / 100n;
	const fee = limit * BigInt(quote.gasPriceWei);
	const balance = BigInt(quote.balanceWei);
	const shortfall = balance < fee ? fee - balance : 0n;
	const lifetime = Date.parse(quote.expiresAt) - Date.parse(quote.quotedAt);
	if (gas <= 0n || BigInt(quote.gasPriceWei) <= 0n || BigInt(quote.gasLimit) !== limit || BigInt(quote.estimatedFeeWei) !== gas * BigInt(quote.gasPriceWei)
		|| BigInt(quote.bufferedFeeWei) !== fee || BigInt(quote.shortfallWei) !== shortfall || quote.sufficientBalance !== (balance >= fee)
		|| lifetime !== network.previewLifetimeMs || (!allowExpired && Date.parse(quote.expiresAt) <= Date.now()) || Date.parse(quote.quotedAt) > Date.now() + 30_000) {
		throw new Error('The fee preview is invalid or expired. Estimate again.');
	}
	return quote;
}
