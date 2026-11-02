import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { LEARNING_BRIDGE_ORDERS as rules, LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import type { BridgeOrderInput, BridgeOrderSetup } from '../../../shared/src/types/learningBridge';
import { tokenAmountToRaw } from '../../../shared/src/utils/tokenAmounts';
import { PrismaService } from '../database/prisma.service';
import { AuthService, type Principal } from '../auth/auth.service';
import { BRIDGE_ASSET_POLICY as policy } from './bridge.config';
import { bridgeRouteId, wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import { BridgeOrdersRepository } from './bridge-orders.repository';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { BridgeCustodyService } from './bridge-custody.service';

@Injectable()
export class BridgeOrdersService {
	private readonly preparing = new Set<string>();
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeOrdersRepository) private readonly repository: BridgeOrdersRepository,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
	) {}
	async setup(principal: Principal): Promise<BridgeOrderSetup> {
		this.auth.requireTbc(principal);
		const [custodyReady, deployments] = await Promise.all([
			this.custody.ready(),
			this.db.bridgeDeployment.findMany({ where: { identityId: principal.id, status: 'verified', lastError: null }, orderBy: { createdAt: 'desc' }, take: 201, include: { asset: true } }),
		]);
		if (deployments.length > 200) throw new ConflictException('Too many registered routes to load. No partial route list was returned.');
		return { custodyReady, paymentEnabled: custodyReady, maxOpenOrders: rules.maxOpenOrders,
			message: custodyReady ? 'Prepare an order, then explicitly open payment details. Deposits are verified before wallet-confirmed minting.' : 'Custody setup is unavailable. Run local setup or restore the configured custody encryption key.',
			deployments: deployments.filter((row) => row.contractAddress && row.verifiedAt).map((row) => ({ contractId: row.contractId, decimals: row.decimals, sourceSymbol: row.asset.symbol, ...wrappedMetadata(row.quote), id: row.id, contractAddress: row.contractAddress!, deployer: row.deployer, verifiedAt: row.verifiedAt!.toISOString() })),
		};
	}
	async list(principal: Principal) { this.auth.requireTbc(principal); return this.repository.list(principal.id); }
	async prepare(input: BridgeOrderInput, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		const chosen = await this.db.bridgeDeployment.findFirst({ where: { id: input.deploymentId, identityId: principal.id }, include: { asset: true } });
		if (!chosen) throw new NotFoundException('Choose a deployment registered to your TBC wallet.');
		let amount: bigint;
		try { amount = tokenAmountToRaw(input.amount, chosen.decimals); } catch { throw new BadRequestException(`Enter a positive amount with at most ${chosen.decimals} decimal places.`); }
		if (amount > 18446744073709551615n) throw new BadRequestException('This amount exceeds the legacy FT quantity range.');
		if (!isAddress(input.recipient, { strict: true }) || input.recipient.toLowerCase() === zeroAddress) throw new BadRequestException('Use a valid, nonzero HyperEVM recipient address. Check mixed-case checksums.');
		const recipient = getAddress(input.recipient).toLowerCase();
		const retry = await this.repository.existing(principal.id, input.idempotencyKey);
		if (retry) return this.repository.assertRetry(retry, { deploymentId: input.deploymentId, recipient, amountRaw: amount.toString() });
		if (this.preparing.has(principal.id) || this.preparing.size >= 4) throw new ConflictException('An order preparation is running. Wait, then refresh saved orders.');
		this.preparing.add(principal.id);
		try {
			const [deployment, asset, custodyReady] = await Promise.all([
				this.db.bridgeDeployment.findFirst({ where: { id: input.deploymentId, identityId: principal.id, status: 'verified', lastError: null } }),
				this.db.bridgeAsset.findUnique({ where: { routeId: chosen.routeId } }),
				this.custody.ready(),
			]);
			if (!deployment?.contractAddress) throw new NotFoundException('Choose a verified deployment saved by your current TBC wallet.');
			if (!asset || asset.contractId !== deployment.contractId || asset.decimals !== deployment.decimals || asset.routeId !== bridgeRouteId(deployment.contractId) || asset.destinationChainId !== 998
				|| asset.confirmations < policy.minimumConfirmations || Date.now() - asset.verifiedAt.getTime() > LEARNING_BRIDGE_EVM.assetVerificationLifetimeMs || asset.verifiedAt.getTime() > Date.now() + 30_000)
				throw new ConflictException('Verify this token again before preparing the transfer. Verification must be less than 10 minutes old.');
			if (amount > BigInt(asset.totalSupplyRaw.toFixed(0))) throw new BadRequestException('The order amount exceeds the verified token total supply.');
			if (!custodyReady) throw new ServiceUnavailableException('Custody setup is unavailable. Restore the configured custody encryption key before preparing orders.');
			if (recipient === deployment.contractAddress.toLowerCase()) throw new BadRequestException('The wrapped token contract cannot be the recipient. Choose a receiving wallet address.');
			const target = await this.target.check(deployment, response);
			return await this.repository.create({ identityId: principal.id, idempotencyKey: input.idempotencyKey, deployment, sender: principal.address, recipient, amountRaw: amount.toString(), sourceSymbol: asset.symbol, targetBlockNumber: target.blockNumber, targetBlockHash: target.blockHash });
		} finally { this.preparing.delete(principal.id); }
	}
	async cancel(id: string, principal: Principal) { this.auth.requireTbc(principal); return this.repository.cancel(id, principal.id); }
}
