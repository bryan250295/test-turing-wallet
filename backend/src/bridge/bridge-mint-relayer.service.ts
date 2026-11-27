import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { BridgeCallAttempt } from '../../generated/prisma/client';
import { LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import { environment } from '../config/environment';
import { BridgeCallVerifier } from './bridge-call.verifier';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { BridgeProgressService } from './bridge-progress.service';
import { BridgeSettlementRepository, activeCallStates, type SettlementOrder } from './bridge-settlement.repository';
import { ETHEREUM_SEPOLIA_CHAIN_ID } from './ethereum-sepolia-rpc';
import { v15OperatorRoles } from './bridge.config';
import { BridgeAdminRelayerService } from './bridge-admin-relayer.service';

const hyperEvm = defineChain({
	id: 998, name: 'HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
	rpcUrls: { default: { http: [LEARNING_BRIDGE_EVM.rpcUrl] } }, testnet: true,
});

function sepoliaChain() {
	const rpcUrl = environment().sepoliaRpcUrl;
	return defineChain({
		id: ETHEREUM_SEPOLIA_CHAIN_ID, name: 'Ethereum Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } }, testnet: true,
	});
}

@Injectable()
export class BridgeMintRelayerService implements OnModuleInit {
	private readonly logger = new Logger(BridgeMintRelayerService.name);
	private account: PrivateKeyAccount | null = null;

	constructor(
		@Inject(BridgeSettlementRepository) private readonly repository: BridgeSettlementRepository,
		@Inject(BridgeCallVerifier) private readonly calls: BridgeCallVerifier,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService,
		@Inject(BridgeProgressService) private readonly progress: BridgeProgressService,
		@Inject(BridgeAdminRelayerService) private readonly adminRelayer: BridgeAdminRelayerService,
	) {}

	async onModuleInit() {
		const path = environment().v15MinterKeyFile;
		if (!path) {
			this.logger.warn('Automatic custody-route minting is disabled: V15_MINTER_KEY_FILE is unset. MetaMask mint remains available.');
			return;
		}
		const metadata = await stat(path);
		// Compose mounts /dev/null at the fixed container path when the optional
		// host key file is not configured. Treat that sentinel as "disabled".
		if (metadata.isCharacterDevice()) {
			this.logger.warn('Automatic custody-route minting is disabled: V15_MINTER_KEY_FILE is unset. MetaMask mint remains available.');
			return;
		}
		if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error('V15_MINTER_KEY_FILE must be an owner-only regular file (chmod 600).');
		const value = (await readFile(path, 'utf8')).trim();
		if (!/^(?:0x)?[0-9a-f]{64}$/i.test(value)) throw new Error('V15_MINTER_KEY_FILE does not contain one 32-byte private key.');
		this.account = privateKeyToAccount(`0x${value.replace(/^0x/i, '')}`);
		if (this.account.address.toLowerCase() !== v15OperatorRoles().minter.toLowerCase()) throw new Error('V15_MINTER_KEY_FILE does not belong to V15_MINTER_ADDRESS.');
		this.logger.log(`Automatic custody-route mint relayer enabled at ${this.account.address}. Private key material was not logged.`);
	}

	mintMode(order: SettlementOrder): 'automatic' | 'manual' {
		return this.account && this.account.address.toLowerCase() === order.deployment.minter.toLowerCase() ? 'automatic' : 'manual';
	}
	isConfigured() { return this.account !== null; }

	private transport(order: SettlementOrder) {
		return order.destinationChainId === ETHEREUM_SEPOLIA_CHAIN_ID
			? { chain: sepoliaChain(), rpcUrl: environment().sepoliaRpcUrl }
			: { chain: hyperEvm, rpcUrl: LEARNING_BRIDGE_EVM.rpcUrl };
	}

	private async sign(order: SettlementOrder, row: BridgeCallAttempt) {
		const account = this.account!;
		const nonce = Number(row.nonce);
		if (!Number.isSafeInteger(nonce) || BigInt(nonce) !== row.nonce) throw new Error('Automatic mint nonce is outside the supported safe integer range.');
		const { chain, rpcUrl } = this.transport(order);
		const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		const serialized = await wallet.signTransaction({
			account, chain, to: getAddress(row.toAddress), data: row.data as Hex, value: 0n,
			gas: row.gasLimit, gasPrice: BigInt(row.gasPriceWei.toFixed(0)), nonce,
		});
		const txHash = keccak256(serialized);
		const saved = await this.repository.submitRelayer(order, row, serialized, txHash);
		this.progress.publish(order.identityId, order.id, 'automatic-mint-submitted');
		await this.broadcast(order, saved);
	}

	async broadcast(order: SettlementOrder, row: BridgeCallAttempt) {
		if (row.submissionMode !== 'relayer' || !row.rawTransaction || !row.txHash || !['submitted', 'confirming'].includes(row.status)) return;
		const { chain, rpcUrl } = this.transport(order);
		const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		let submitted: Hex;
		try { submitted = await client.sendRawTransaction({ serializedTransaction: row.rawTransaction as Hex }); }
		catch (cause) {
			this.logger.warn({ orderId: order.id, attemptId: row.id, error: cause instanceof Error ? cause.message : 'Automatic mint broadcast is temporarily unavailable' });
			return;
		}
		if (submitted.toLowerCase() !== row.txHash.toLowerCase()) {
			const message = 'The destination RPC returned a different automatic mint transaction hash. Automation stopped before any replacement transaction.';
			await this.repository.failRelayer(order, row, message);
			this.progress.publish(order.identityId, order.id, 'automatic-mint-needs-review');
		}
	}

	async advance(order: SettlementOrder) {
		if (this.mintMode(order) !== 'automatic' || order.settlement?.status !== 'ready_to_mint' || !order.settlement.deposit) return;
		const active = order.settlement.attempts.find((row) => activeCallStates.includes(row.status));
		if (active) {
			if (active.submissionMode !== 'relayer' || active.kind !== 'mint') return;
			if (active.status !== 'quoted') return;
			if (active.expiresAt.getTime() <= Date.now()) {
				await this.repository.cancel(order, active);
				this.progress.publish(order.identityId, order.id, 'automatic-mint-quote-expired');
				return;
			}
			await this.sign(order, active);
			return;
		}
		const target = await this.target.check(order.deployment);
		if (target.paused) {
			if (!this.adminRelayer.isConfigured()) throw new Error('The wrapped-token route is paused. Complete its one-time Admin activation or configure both backend Admin signer key files.');
			const activated = await this.adminRelayer.advance(order.deployment);
			if (!activated) {
				this.progress.publish(order.identityId, order.id, 'automatic-admin-activation');
				return;
			}
		}
		const quote = await this.calls.quote(order, 'mint', this.account!.address);
		const row = await this.repository.quote(order, { ...quote, submissionMode: 'relayer' });
		this.progress.publish(order.identityId, order.id, 'automatic-mint-quoted');
		await this.sign(order, row);
	}
}
