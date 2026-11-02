import { BadRequestException, ConflictException, GatewayTimeoutException, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { encodeDeployData, getAddress, isAddress, keccak256, parseAbi, type Address } from 'viem';
import { AuthService, type Principal } from '../auth/auth.service';
import { BridgeSettlementRepository } from './bridge-settlement.repository';
import { BridgeCustodyService } from './bridge-custody.service';
import { BridgeDepositVerifier } from './bridge-deposit.verifier';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { withDeploymentRpc } from './bridge-deployment-verifier';
import { LEARNING_REDEMPTION_ESCROW_BUILD as build } from '../../../shared/src/contracts/learningRedemptionEscrow';
import type { RedemptionEscrowPreview } from '../../../shared/src/types/learningBridge';

const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

@Injectable()
export class BridgeRedemptionService {
	private readonly running = new Set<string>();
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(BridgeSettlementRepository) private readonly repository: BridgeSettlementRepository,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
		@Inject(BridgeDepositVerifier) private readonly deposits: BridgeDepositVerifier,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService,
	) {}

	async preview(orderId: string, from: string, principal: Principal, response: Response): Promise<RedemptionEscrowPreview> {
		this.auth.requireTbc(principal);
		if (!isAddress(from, { strict: true })) throw new BadRequestException('Use a valid MetaMask address.');
		if (this.running.has(orderId) || this.running.size >= 4) throw new ConflictException('An escrow preview is already running. Wait for it to finish.');
		this.running.add(orderId);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 110_000); timer.unref();
		const close = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', close);
		try {
			const order = await this.repository.owned(orderId, principal.id);
			const mint = order.settlement?.attempts.find((row) => row.kind === 'mint' && row.status === 'verified');
			if (order.settlement?.status !== 'completed' || !mint || mint.confirmations < order.destinationConfirmationsRequired || !order.settlement.deposit || !order.custody) throw new ConflictException('Complete and verify the forward bridge before preparing a reverse-bridge preview.');
			if (from.toLowerCase() !== order.deployment.admin.toLowerCase()) throw new BadRequestException('Select the saved admin account in MetaMask for the paused escrow preview.');
			await this.custody.assertRecoverable(order, order.custody);
			const reserve = await this.deposits.verify(order, order.custody.address, order.settlement.deposit.txid, controller.signal);
			if (reserve.confirmations < order.sourceConfirmationsRequired || reserve.blockHash !== order.settlement.deposit.blockHash) throw new ConflictException('The source reserve block or confirmations changed. Reconcile the original order before proceeding.');
			await this.target.check(order.deployment, response); controller.signal.throwIfAborted();
			return await withDeploymentRpc(response, async (client) => {
				const admin = getAddress(from);
				const token = getAddress(order.destinationContract);
				const transactionData = encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [token, admin, `0x${order.contractId}`, order.decimals] });
				const block = await client.getBlock({ blockTag: 'latest' });
				if (block.number === null || !block.hash) throw new ConflictException('No canonical target block is available.');
				const [balance, code, nonce, gasPrice, wrappedBalance] = await Promise.all([
					client.getBalance({ address: admin, blockNumber: block.number }), client.getCode({ address: admin, blockNumber: block.number }),
					client.getTransactionCount({ address: admin, blockTag: 'pending' }), client.getGasPrice(),
					client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [order.recipient as Address], blockNumber: block.number }),
				]);
				if (code && code !== '0x') throw new BadRequestException('Use an ordinary MetaMask admin account for this preview.');
				if (!Number.isSafeInteger(nonce) || nonce < 0) throw new ConflictException('Unsupported deployment nonce.');
				const estimate = await client.estimateGas({ account: admin, data: transactionData, value: 0n, blockNumber: block.number, prepare: false });
				const gas = (estimate * 120n + 99n) / 100n;
				if (estimate <= 0n || gas > block.gasLimit || gasPrice <= 0n) throw new ConflictException('The escrow deployment fee could not be estimated.');
				if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash || await client.getChainId() !== 998) throw new ConflictException('The target chain changed during this preview.');
				controller.signal.throwIfAborted();
				const now = Date.now();
				return {
					orderId, chainId: 998, wrappedToken: token.toLowerCase(), admin: admin.toLowerCase(), sourceContractId: order.contractId,
					decimals: order.decimals, reserveAmountRaw: reserve.amountRaw, reserveConfirmations: reserve.confirmations,
					reserveCheckedAt: reserve.checkedAt.toISOString(), wrappedBalanceRaw: wrappedBalance.toString(),
					nonce: nonce.toString(), gasEstimate: estimate.toString(), gasLimit: gas.toString(), gasPriceWei: gasPrice.toString(),
					estimatedFeeWei: (estimate * gasPrice).toString(), budgetWei: (gas * gasPrice).toString(), balanceWei: balance.toString(),
					sufficientBalance: balance >= gas * gasPrice, transactionData, initCodeHash: keccak256(transactionData), buildInputSha256: build.buildInputSha256,
					quotedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), lockingEnabled: false, sourceReleaseEnabled: false,
				};
			});
		} catch (cause) {
			if (controller.signal.aborted) throw new GatewayTimeoutException('Escrow preview timed out or was cancelled. No transaction was sent.');
			throw cause;
		} finally { controller.abort(); clearTimeout(timer); response.removeListener('close', close); this.running.delete(orderId); }
	}
}
