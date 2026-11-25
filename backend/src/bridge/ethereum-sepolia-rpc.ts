import { GatewayTimeoutException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { createPublicClient, defineChain, http } from 'viem';
import { environment } from '../config/environment';

export const ETHEREUM_SEPOLIA_CHAIN_ID = 11_155_111 as const;

function client(signal: AbortSignal) {
	const rpcUrl = environment().sepoliaRpcUrl;
	const chain = defineChain({
		id: ETHEREUM_SEPOLIA_CHAIN_ID,
		name: 'Ethereum Sepolia',
		nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } },
	});
	return createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 2, retryDelay: 500, timeout: 12_000, fetchOptions: { signal } }) });
}

export async function withSepoliaRpc<T>(response: Response | undefined, operation: (rpc: ReturnType<typeof client>, signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 40_000); timer.unref();
	const cancel = () => { if (response && !response.writableEnded) controller.abort(); };
	response?.once('close', cancel);
	try {
		const rpc = client(controller.signal);
		if (await rpc.getChainId() !== ETHEREUM_SEPOLIA_CHAIN_ID) throw new ServiceUnavailableException('The configured RPC is not Ethereum Sepolia.');
		const result = await operation(rpc, controller.signal);
		controller.signal.throwIfAborted();
		return result;
	} catch (cause) {
		if (controller.signal.aborted) throw new GatewayTimeoutException('The Ethereum Sepolia check timed out or was cancelled. Refresh saved progress; do not repeat a transaction.');
		if (cause instanceof HttpException) throw cause;
		throw new ServiceUnavailableException('Ethereum Sepolia is temporarily unavailable. No transaction was submitted; refresh the saved status later.');
	} finally {
		controller.abort(); clearTimeout(timer); response?.removeListener('close', cancel);
	}
}
