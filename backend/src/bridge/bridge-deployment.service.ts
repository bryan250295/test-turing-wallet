import { BadRequestException, ConflictException, GatewayTimeoutException, HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { createPublicClient, getAddress, http, isAddress, keccak256, zeroAddress } from 'viem';
import { LEARNING_BRIDGE_EVM as network } from '../../../shared/src/config/learningBridge';
import { bridgeRouteId, validWrappedName, validWrappedSymbol } from '../../../shared/src/config/bridgeRoutes';
import { deploymentBuild, deploymentData } from './bridge-build';
import type { BridgeDeploymentInput, BridgeDeploymentPreview } from '../../../shared/src/types/learningBridge';
import { AuthService, type Principal } from '../auth/auth.service';
import { BRIDGE_ASSET_POLICY as policy } from './bridge.config';
import { BridgeRepository } from './bridge.repository';

function roleAddress(value: string) {
	if (!isAddress(value, { strict: true }) || value.toLowerCase() === zeroAddress) throw new BadRequestException('Use valid, nonzero public EVM addresses. Check mixed-case checksums.');
	return getAddress(value);
}

@Injectable()
export class BridgeDeploymentService {
	private readonly running = new Set<string>();
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(BridgeRepository) private readonly repository: BridgeRepository,
	) {}
	async preview(input: BridgeDeploymentInput, principal: Principal, response: Response): Promise<BridgeDeploymentPreview> {
		this.auth.requireTbc(principal);
		let routeId: string;
		try { routeId = bridgeRouteId(input.contractId.toLowerCase(), input.destinationChainId ?? 998); }
		catch { throw new BadRequestException('Select a valid token and an enabled destination.'); }
		const configurable = input.wrappedName !== undefined || input.wrappedSymbol !== undefined;
		if (configurable && (!validWrappedName(input.wrappedName) || !validWrappedSymbol(input.wrappedSymbol))) throw new BadRequestException('Use a name of 1–64 printable characters and an alphanumeric symbol of 1–11 characters starting with a letter.');
		if (!configurable && input.contractId.toLowerCase() !== policy.contractId) throw new BadRequestException('Enter a wrapped token name and symbol.');
		const contractName = configurable ? 'BridgeWrappedFT' as const : 'LearningWrappedFT' as const;
		const { build } = deploymentBuild({ contractName });
		const deployer = roleAddress(input.deployer);
		const admin = roleAddress(input.admin);
		const minter = roleAddress(input.minter);
		if (this.running.has(principal.id) || this.running.size >= 4) throw new HttpException('Deployment estimates are busy. Wait for the current request to finish.', 429);
		this.running.add(principal.id);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 40_000);
		timer.unref();
		const cancel = () => { if (!response.writableEnded) controller.abort(); };
		response.once('close', cancel);
		try {
			const asset = await this.repository.get(routeId);
			const age = asset ? Date.now() - Date.parse(asset.verifiedAt) : Infinity;
			if (!asset || asset.contractId !== input.contractId.toLowerCase() || asset.destinationChainId !== 998 || asset.confirmations < policy.minimumConfirmations || !Number.isFinite(age) || age < -30_000 || age > network.assetVerificationLifetimeMs) {
				throw new ConflictException('Verify the selected token again before preparing deployment. Verification must be less than 10 minutes old.');
			}
			// Only the server build and fixed official testnet RPC are used. No private
			// key, wallet client, signing, state overrides or send method exists here.
			const client = createPublicClient({ transport: http(network.rpcUrl, { timeout: 12_000, retryCount: 0, fetchOptions: { signal: controller.signal } }) });
			if (await client.getChainId() !== network.chainId) throw new ServiceUnavailableException('The configured HyperEVM RPC is not on Testnet 998.');
			const block = await client.getBlock({ blockTag: 'latest' });
			if (block.number === null) throw new ServiceUnavailableException('HyperEVM did not return a confirmed block.');
			const data = deploymentData({ contractName, admin, minter, contractId: asset.contractId, decimals: asset.decimals, wrappedName: input.wrappedName, wrappedSymbol: input.wrappedSymbol });
			const [balance, gasPrice, code, gas] = await Promise.all([
				client.getBalance({ address: deployer, blockNumber: block.number }),
				client.getGasPrice(),
				client.getCode({ address: deployer, blockNumber: block.number }),
				client.estimateGas({ account: deployer, data, value: 0n, blockNumber: block.number, prepare: false }),
			]);
			controller.signal.throwIfAborted();
			if (code && code !== '0x') throw new BadRequestException('This preview supports an ordinary MetaMask account as deployer. Smart-account deployment is not configured.');
			const gasLimit = (gas * BigInt(100 + network.gasBufferPercent) + 99n) / 100n;
			if (gas <= 0n || gasPrice <= 0n || gasLimit > block.gasLimit) throw new ServiceUnavailableException('The estimated deployment does not fit the current block gas limit. No transaction was submitted.');
			if (await client.getChainId() !== network.chainId) throw new ServiceUnavailableException('The HyperEVM RPC network changed during estimation.');
			controller.signal.throwIfAborted();
			const estimatedFee = gas * gasPrice;
			const bufferedFee = gasLimit * gasPrice;
			const quotedAt = Date.now();
			return {
				contractId: asset.contractId, deployer, admin, minter, chainId: network.chainId,
				contractName, ...(configurable ? { wrappedName: input.wrappedName, wrappedSymbol: input.wrappedSymbol } : {}), destinationChainId: 998, decimals: asset.decimals, initiallyPaused: true, initialSupplyRaw: '0',
				buildInputSha256: build.buildInputSha256, sourceSha256: build.sourceSha256, initCodeHash: keccak256(data),
				gasEstimate: gas.toString(), gasLimit: gasLimit.toString(), gasBufferPercent: network.gasBufferPercent,
				gasPriceWei: gasPrice.toString(), estimatedFeeWei: estimatedFee.toString(), bufferedFeeWei: bufferedFee.toString(),
				balanceWei: balance.toString(), shortfallWei: (balance < bufferedFee ? bufferedFee - balance : 0n).toString(), sufficientBalance: balance >= bufferedFee,
				blockNumber: block.number.toString(), assetVerifiedAt: asset.verifiedAt,
				quotedAt: new Date(quotedAt).toISOString(), expiresAt: new Date(quotedAt + network.previewLifetimeMs).toISOString(),
			};
		} catch (cause) {
			if (controller.signal.aborted) throw new GatewayTimeoutException('Deployment estimation timed out or was cancelled. Try again when ready.');
			if (cause instanceof HttpException) throw cause;
			// Viem error messages can contain the full creation bytecode and RPC
			// request. Expose a concise failure rather than leaking internals to UI.
			throw new ServiceUnavailableException('Unable to estimate deployment on HyperEVM Testnet. Check the deployer HYPE balance and retry; no transaction was submitted.');
		} finally {
			controller.abort();
			clearTimeout(timer);
			response.removeListener('close', cancel);
			this.running.delete(principal.id);
		}
	}
}
