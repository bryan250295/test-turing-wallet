import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import tbc from 'tbc-lib-js';
import { createPublicClient, getAddress, http, keccak256, type Hex } from 'viem';
import { PHASE3_TESTNET_V3 } from '../../../shared/src/config/phase3TestnetV3';
import type { Principal } from '../auth/auth.service';
import { ProofBridgeV3Repository } from './proof-bridge-v3.repository';

const RPC = 'https://rpc.hyperliquid-testnet.xyz/evm';
const relayAbi = [
	{ type: 'function', name: 'CHECKPOINT_HEIGHT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
	{ type: 'function', name: 'CHECKPOINT_HASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
	{ type: 'function', name: 'BOOTSTRAP_COMMITMENT_ROOT', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;
const gatewayAbi = [
	{ type: 'function', name: 'relay', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'finalizedVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'transitionVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'signatureVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'prefixVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'wrappedToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'reserveController', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes20' }] },
] as const;
const tokenAbi = [
	{ type: 'function', name: 'gateway', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export interface RouteRegistration {
	deployer: string; relay: string; gateway: string; wrappedToken: string; relayTxHash: string; gatewayTxHash: string;
}

@Injectable()
export class ProofBridgeV3RouteService {
	constructor(@Inject(ProofBridgeV3Repository) private readonly repository: ProofBridgeV3Repository) {}

	async register(principal: Principal, input: RouteRegistration) {
		const client = createPublicClient({ transport: http(RPC, { retryCount: 1, timeout: 15_000 }) });
		try {
			const sourceController = `0x${tbc.Address.fromString(principal.address).hashBuffer.toString('hex')}`;
			if (sourceController.toLowerCase() !== PHASE3_TESTNET_V3.reserveController) throw new BadRequestException('The signed-in TBC account is not the pinned V3 reserve controller.');
			const deployer = getAddress(input.deployer); const relay = getAddress(input.relay);
			const gateway = getAddress(input.gateway); const wrappedToken = getAddress(input.wrappedToken);
			const [chainId, relayCode, gatewayCode, tokenCode, relayReceipt, gatewayReceipt, relayTransaction, gatewayTransaction, height, hash, root,
				boundRelay, finalized, transition, signature, prefix, reserve, boundToken, tokenGateway, tokenSupply] = await Promise.all([
				client.getChainId(), client.getCode({ address: relay }), client.getCode({ address: gateway }), client.getCode({ address: wrappedToken }),
				client.getTransactionReceipt({ hash: input.relayTxHash as Hex }), client.getTransactionReceipt({ hash: input.gatewayTxHash as Hex }),
				client.getTransaction({ hash: input.relayTxHash as Hex }), client.getTransaction({ hash: input.gatewayTxHash as Hex }),
				client.readContract({ address: relay, abi: relayAbi, functionName: 'CHECKPOINT_HEIGHT' }),
				client.readContract({ address: relay, abi: relayAbi, functionName: 'CHECKPOINT_HASH' }),
				client.readContract({ address: relay, abi: relayAbi, functionName: 'BOOTSTRAP_COMMITMENT_ROOT' }),
				client.readContract({ address: gateway, abi: gatewayAbi, functionName: 'relay' }),
				client.readContract({ address: gateway, abi: gatewayAbi, functionName: 'finalizedVerifier' }),
				client.readContract({ address: gateway, abi: gatewayAbi, functionName: 'transitionVerifier' }),
				client.readContract({ address: gateway, abi: gatewayAbi, functionName: 'signatureVerifier' }),
				client.readContract({ address: gateway, abi: gatewayAbi, functionName: 'prefixVerifier' }),
				client.readContract({ address: gateway, abi: gatewayAbi, functionName: 'reserveController' }),
				client.readContract({ address: gateway, abi: gatewayAbi, functionName: 'wrappedToken' }),
				client.readContract({ address: wrappedToken, abi: tokenAbi, functionName: 'gateway' }),
				client.readContract({ address: wrappedToken, abi: tokenAbi, functionName: 'totalSupply' }),
			]);
			if (chainId !== 998 || !relayCode || !gatewayCode || !tokenCode) throw new BadRequestException('V3 contracts are not deployed on HyperEVM Testnet.');
			if (keccak256(relayCode).toLowerCase() !== PHASE3_TESTNET_V3.relayRuntimeCodeHash) throw new BadRequestException('V3 Relay runtime differs from the pinned build.');
			if (relayReceipt.status !== 'success' || gatewayReceipt.status !== 'success' || relayReceipt.contractAddress?.toLowerCase() !== relay.toLowerCase() || gatewayReceipt.contractAddress?.toLowerCase() !== gateway.toLowerCase() || relayReceipt.from.toLowerCase() !== deployer.toLowerCase() || gatewayReceipt.from.toLowerCase() !== deployer.toLowerCase()) throw new BadRequestException('Deployment receipts do not match the reviewed V3 route.');
			const gatewayCreationEnd = 2 + PHASE3_TESTNET_V3.gatewayCreationCodeBytes * 2;
			const gatewayCreationCode = gatewayTransaction.input.slice(0, gatewayCreationEnd) as Hex;
			if (relayTransaction.to !== null || gatewayTransaction.to !== null || relayTransaction.from.toLowerCase() !== deployer.toLowerCase() || gatewayTransaction.from.toLowerCase() !== deployer.toLowerCase() || gatewayTransaction.input.length !== gatewayCreationEnd + 6 * 64 || keccak256(gatewayCreationCode).toLowerCase() !== PHASE3_TESTNET_V3.gatewayCreationCodeHash) throw new BadRequestException('V3 deployment transactions differ from the pinned creation build.');
			if (Number(height) !== PHASE3_TESTNET_V3.checkpoint.height || hash.toLowerCase() !== PHASE3_TESTNET_V3.checkpoint.hash || root.toLowerCase() !== PHASE3_TESTNET_V3.checkpoint.bootstrapRoot) throw new BadRequestException('V3 Relay checkpoint constants differ from the frozen candidate.');
			const expected = PHASE3_TESTNET_V3.modules;
			if (boundRelay.toLowerCase() !== relay.toLowerCase() || finalized.toLowerCase() !== expected.finalized.toLowerCase() || transition.toLowerCase() !== expected.transition.toLowerCase() || signature.toLowerCase() !== expected.signature.toLowerCase() || prefix.toLowerCase() !== expected.prefix.toLowerCase() || reserve.toLowerCase() !== PHASE3_TESTNET_V3.reserveController || boundToken.toLowerCase() !== wrappedToken.toLowerCase() || tokenGateway.toLowerCase() !== gateway.toLowerCase()) throw new BadRequestException('V3 Gateway bindings differ from the pinned route.');
			if (tokenSupply !== 0n) throw new BadRequestException('The wrapped token is not empty at initial V3 route registration.');
			return this.repository.register(principal.id, {
				chainId: 998, sourceAddress: principal.address, deployer: deployer.toLowerCase(), relay: relay.toLowerCase(), gateway: gateway.toLowerCase(), wrappedToken: wrappedToken.toLowerCase(), relayTxHash: input.relayTxHash.toLowerCase(), gatewayTxHash: input.gatewayTxHash.toLowerCase(), reserveController: PHASE3_TESTNET_V3.reserveController, checkpointHeight: PHASE3_TESTNET_V3.checkpoint.height, checkpointHash: PHASE3_TESTNET_V3.checkpoint.hash, bootstrapRoot: PHASE3_TESTNET_V3.checkpoint.bootstrapRoot,
			});
		} catch (cause) {
			if (cause instanceof BadRequestException || cause instanceof ConflictException) throw cause;
			throw new ServiceUnavailableException('Unable to verify the V3 route on HyperEVM Testnet. Nothing was submitted.');
		}
	}
}
