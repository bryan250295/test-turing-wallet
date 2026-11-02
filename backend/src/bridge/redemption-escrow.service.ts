import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { getContractAddress, type Address } from 'viem';
import { AuthService, type Principal } from '../auth/auth.service';
import { BridgeSettlementRepository } from './bridge-settlement.repository';
import { BridgeRedemptionService } from './bridge-redemption.service';
import { RedemptionEscrowRepository, escrowRecord } from './redemption-escrow.repository';
import { RedemptionEscrowVerifier } from './redemption-escrow.verifier';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { LEARNING_REDEMPTION_ESCROW_BUILD as build } from '../../../shared/src/contracts/learningRedemptionEscrow';
import type { RedemptionEscrowPreview } from '../../../shared/src/types/learningBridge';

@Injectable()
export class RedemptionEscrowService {
	private readonly checking = new Set<string>();
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(BridgeSettlementRepository) private readonly orders: BridgeSettlementRepository,
		@Inject(BridgeRedemptionService) private readonly estimates: BridgeRedemptionService,
		@Inject(RedemptionEscrowRepository) private readonly repository: RedemptionEscrowRepository,
		@Inject(RedemptionEscrowVerifier) private readonly verifier: RedemptionEscrowVerifier,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService,
	) {}
	async list(orderId: string, principal: Principal) {
		this.auth.requireTbc(principal); await this.orders.owned(orderId, principal.id);
		return this.repository.list(orderId, principal.id);
	}
	async prepare(orderId: string, from: string, principal: Principal, response: Response) {
		const quote = await this.estimates.preview(orderId, from, principal, response);
		if (!quote.sufficientBalance) throw new BadRequestException('More test HYPE is required for this escrow deployment budget.');
		if (getContractAddress({ from: quote.admin as Address, nonce: BigInt(quote.nonce) }).toLowerCase() === quote.admin) throw new BadRequestException('The escrow owner cannot be its own creation address.');
		return this.repository.create(await this.orders.owned(orderId, principal.id), quote);
	}
	async begin(orderId: string, id: string, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		const row = await this.repository.owned(id, orderId, principal.id);
		if (row.status !== 'prepared' || row.expiresAt.getTime() <= Date.now() || row.buildInputSha256 !== build.buildInputSha256) throw new ConflictException('The escrow preparation expired, was used or has an older build. Refresh its saved state.');
		const quote = row.quote as unknown as RedemptionEscrowPreview;
		const fresh = await this.estimates.preview(orderId, row.deployer, principal, response);
		if (fresh.transactionData !== row.transactionData || BigInt(fresh.nonce) !== row.nonce || !fresh.sufficientBalance
			|| BigInt(fresh.gasEstimate) > BigInt(quote.gasLimit) || BigInt(fresh.gasPriceWei) > BigInt(quote.gasPriceWei)) throw new ConflictException('The escrow nonce, fees, balance or constructor changed. Discard this unused preparation and review a fresh one.');
		await this.repository.begin(row);
		return escrowRecord({ ...row, status: 'awaiting_wallet' });
	}
	async submit(orderId: string, id: string, hash: string, principal: Principal) {
		this.auth.requireTbc(principal);
		return this.repository.submit(await this.repository.owned(id, orderId, principal.id), hash.toLowerCase());
	}
	async cancel(orderId: string, id: string, notSent: boolean, principal: Principal) {
		this.auth.requireTbc(principal);
		return this.repository.cancel(await this.repository.owned(id, orderId, principal.id), notSent);
	}
	async check(orderId: string, id: string, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		const row = await this.repository.owned(id, orderId, principal.id);
		if (!row.txHash) return escrowRecord(row);
		if (this.checking.has(id) || this.checking.size >= 4) throw new ConflictException('An escrow receipt check is running. Wait, then refresh.');
		this.checking.add(id);
		try {
			const order = await this.orders.owned(orderId, principal.id);
			await this.target.check(order.deployment, response);
			return await this.repository.observe(row, await this.verifier.check(row, response));
		} catch {
			return this.repository.observe(row, { checkedAt: new Date(), lastError: 'Status unavailable. Previous escrow verification is retained; check again before relying on it.' });
		} finally { this.checking.delete(id); }
	}
}
