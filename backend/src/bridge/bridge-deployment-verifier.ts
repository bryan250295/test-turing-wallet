import { BadRequestException, GatewayTimeoutException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { createPublicClient, getContractAddress, http, keccak256, parseAbi, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import type { BridgeDeployment, Prisma } from '../../generated/prisma/client';
import { LEARNING_BRIDGE_EVM as network } from '../../../shared/src/config/learningBridge';

const readAbi = parseAbi([
	'function owner() view returns (address)', 'function minter() view returns (address)', 'function paused() view returns (bool)',
	'function sourceContractId() view returns (bytes32)', 'function sourceDecimals() view returns (uint8)', 'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)', 'function name() view returns (string)', 'function symbol() view returns (string)',
	'function TARGET_CHAIN_ID() view returns (uint256)',
]);

export async function withDeploymentRpc<T>(response: Response, operation: (client: ReturnType<typeof deploymentClient>, signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 40_000);
	timer.unref();
	const cancel = () => { if (!response.writableEnded) controller.abort(); };
	response.once('close', cancel);
	try {
		const client = deploymentClient(controller.signal);
		if (await client.getChainId() !== network.chainId) throw new ServiceUnavailableException('The configured RPC is not on HyperEVM Testnet 998.');
		const value = await operation(client, controller.signal);
		controller.signal.throwIfAborted();
		return value;
	} catch (cause) {
		if (controller.signal.aborted) throw new GatewayTimeoutException('The HyperEVM check timed out or was cancelled. Refresh the saved deployment to retry.');
		if (cause instanceof HttpException) throw cause;
		throw new ServiceUnavailableException('The HyperEVM check is unavailable. The saved transaction was retained; refresh its status later.');
	} finally {
		controller.abort(); clearTimeout(timer); response.removeListener('close', cancel);
	}
}
function deploymentClient(signal: AbortSignal) { return createPublicClient({ transport: http(network.rpcUrl, { retryCount: 0, timeout: 12_000, fetchOptions: { signal } }) }); }

export function normalizedRuntime(code: string, references: unknown): string {
	if (!/^0x(?:[0-9a-f]{2})+$/i.test(code) || !Array.isArray(references)) throw new BadRequestException('Unsupported deployed bytecode or immutable references.');
	let result = code.toLowerCase().slice(2);
	for (const reference of references) {
		if (!reference || !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.length) || reference.start < 0 || reference.length !== 32 || (reference.start + reference.length) * 2 > result.length) throw new BadRequestException('Invalid immutable reference in saved build.');
		result = result.slice(0, reference.start * 2) + '0'.repeat(reference.length * 2) + result.slice((reference.start + reference.length) * 2);
	}
	return result;
}

@Injectable()
export class BridgeDeploymentVerifier {
	async check(row: BridgeDeployment, response: Response): Promise<Prisma.BridgeDeploymentUpdateManyMutationInput> {
		if (!row.txHash) throw new BadRequestException('Attach the MetaMask deployment transaction hash first.');
		return withDeploymentRpc(response, async (client) => {
			const checkedAt = new Date();
			const pending = { status: 'submitted', confirmations: 0, verifiedAt: null, contractAddress: null, receiptBlockHash: null, receiptBlockNumber: null, runtimeCodeHash: null, gasUsed: null, effectiveGasPriceWei: null, actualFeeWei: null, checkedAt, lastError: null };
			let transaction;
			try { transaction = await client.getTransaction({ hash: row.txHash as Hex }); }
			catch (cause) { if (cause instanceof TransactionNotFoundError) return { ...pending, lastError: 'Transaction not found on the configured testnet yet. Check MetaMask activity and refresh; do not deploy again.' }; throw cause; }
			const txChainId = transaction.chainId ?? (transaction.v >= 35n ? Number((transaction.v - 35n) / 2n) : 0);
			if (txChainId !== 998 || transaction.from.toLowerCase() !== row.deployer.toLowerCase() || transaction.to !== null || transaction.value !== 0n || BigInt(transaction.nonce) !== row.nonce || transaction.input.toLowerCase() !== row.transactionData.toLowerCase()) {
				return { ...pending, status: 'invalid', lastError: 'The transaction does not match this prepared deployment (network, sender, nonce, value or creation data).' };
			}
			let receipt;
			try { receipt = await client.getTransactionReceipt({ hash: row.txHash as Hex }); }
			catch (cause) { if (cause instanceof TransactionReceiptNotFoundError) return pending; throw cause; }
			const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
			if (block.hash !== receipt.blockHash || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber || head < receipt.blockNumber) return { ...pending, lastError: 'The transaction block changed. Waiting for a canonical receipt before verification.' };
			const confirmations = Number(head - receipt.blockNumber + 1n);
			const fees = { gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(), actualFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
			const observed = { ...fees, checkedAt, confirmations, receiptBlockHash: receipt.blockHash, receiptBlockNumber: receipt.blockNumber, lastError: null, verifiedAt: null, runtimeCodeHash: null };
			if (receipt.status !== 'success') return { ...observed, contractAddress: null, status: confirmations >= network.deploymentConfirmations ? 'reverted' : 'confirming', lastError: 'The deployment transaction reverted. No usable contract was registered; the network may still charge gas. Waiting for the confirmation policy before treating this result as final.' };
			const expectedAddress = getContractAddress({ from: row.deployer as Address, nonce: row.nonce });
			if (!receipt.contractAddress || receipt.contractAddress.toLowerCase() !== expectedAddress.toLowerCase() || receipt.from.toLowerCase() !== row.deployer.toLowerCase() || receipt.to !== null) return { ...observed, contractAddress: null, status: 'invalid', lastError: 'The creation receipt does not match the expected contract address.' };
			if (confirmations < network.deploymentConfirmations) return { ...observed, status: 'confirming', contractAddress: expectedAddress.toLowerCase() };
			const code = await client.getCode({ address: expectedAddress, blockNumber: receipt.blockNumber });
			if (!code || normalizedRuntime(code, row.immutableReferences) !== normalizedRuntime(row.runtimeBytecode, row.immutableReferences)) return { ...observed, status: 'invalid', contractAddress: null, lastError: 'The deployed runtime bytecode differs from the saved Solidity build.' };
			const read = <N extends typeof readAbi[number]['name']>(functionName: N) => client.readContract({ address: expectedAddress, abi: readAbi, functionName, blockNumber: receipt.blockNumber });
			const [owner, minter, paused, sourceId, sourceDecimals, decimals, totalSupply, name, symbol, chain] = await Promise.all([
				read('owner'), read('minter'), read('paused'), read('sourceContractId'), read('sourceDecimals'), read('decimals'), read('totalSupply'), read('name'), read('symbol'), read('TARGET_CHAIN_ID'),
			]);
			if (owner.toLowerCase() !== row.admin.toLowerCase() || minter.toLowerCase() !== row.minter.toLowerCase() || paused !== true || sourceId.toLowerCase() !== `0x${row.contractId}` || sourceDecimals !== row.decimals || decimals !== row.decimals || totalSupply !== 0n || name !== wrappedMetadata(row.quote).wrappedName || symbol !== wrappedMetadata(row.quote).wrappedSymbol || chain !== 998n) {
				return { ...observed, status: 'invalid', contractAddress: null, lastError: 'The deployed owner, minter, source FT, decimals or initial paused/zero-supply state is incorrect.' };
			}
			// Re-read the canonical block after the contract calls. A reorg must not
			// turn a historical code/state result into a verified deployment.
			const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
			if (canonical.hash !== receipt.blockHash || await client.getChainId() !== 998) return { ...pending, lastError: 'The source of the receipt changed during verification. Refresh status.' };
			return { ...observed, status: 'verified', contractAddress: expectedAddress.toLowerCase(), runtimeCodeHash: keccak256(code), verifiedAt: new Date() };
		});
	}
}
