import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { BridgeDeployment, BridgeOrder as OrderRow } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { BridgeOrder } from '../../../shared/src/types/learningBridge';
import { LEARNING_BRIDGE_ORDERS as limits } from '../../../shared/src/config/learningBridge';
import { wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import { BridgeCustodyService } from './bridge-custody.service';

export function publicOrder(row: OrderRow & { settlement?: { orderId: string; status: string } | null; deployment?: { quote: unknown } }): BridgeOrder {
	return {
		id: row.id, deploymentId: row.deploymentId, status: row.status as BridgeOrder['status'], sourceNetwork: 'testnet', contractId: row.contractId,
		decimals: row.decimals, symbol: row.symbol, ...wrappedMetadata(row.deployment?.quote), amountRaw: row.amountRaw.toFixed(0), sender: row.sender, recipient: row.recipient,
		destinationChainId: 998, destinationContract: row.destinationContract, sourceConfirmationsRequired: row.sourceConfirmationsRequired,
		destinationConfirmationsRequired: row.destinationConfirmationsRequired, termsHash: row.termsHash, policyVersion: row.policyVersion,
		custody: { allocated: true, encrypted: true, address: null, paymentEnabled: row.settlement?.status === 'awaiting_payment' },
		depositTxHash: null, mintTxHash: null, paymentDeadline: null,
		createdAt: row.createdAt.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null,
		settlementStarted: !!row.settlement,
		settlementStatus: row.settlement?.status as BridgeOrder['settlementStatus'] ?? null,
	};
}

export interface PrepareOrderTerms {
	identityId: string; idempotencyKey: string; deployment: BridgeDeployment;
	sender: string; recipient: string; amountRaw: string; sourceSymbol: string;
	targetBlockNumber: bigint; targetBlockHash: string;
}

@Injectable()
export class BridgeOrdersRepository {
	constructor(@Inject(PrismaService) private readonly db: PrismaService, @Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService) {}
	async existing(identityId: string, idempotencyKey: string) { return this.db.bridgeOrder.findUnique({ where: { identityId_idempotencyKey: { identityId, idempotencyKey } }, include: { deployment: { select: { quote: true } }, settlement: { select: { orderId: true, status: true } } } }); }
	assertRetry(row: OrderRow & { deployment?: { quote: unknown } }, terms: { deploymentId: string; recipient: string; amountRaw: string }) {
		if (row.deploymentId !== terms.deploymentId || row.recipient !== terms.recipient || row.amountRaw.toFixed(0) !== terms.amountRaw) throw new ConflictException('This order request was already used with different terms. Refresh saved orders before starting a new request.');
		return publicOrder(row);
	}
	async list(identityId: string) {
		// Show all open drafts first so an old draft cannot disappear behind many
		// recent cancelled records and strand the per-user limit.
		const pending = await this.db.bridgeOrder.findMany({ where: { identityId, status: 'prepared', OR: [{ settlement: null }, { settlement: { status: { not: 'completed' } } }] }, include: { deployment: { select: { quote: true } }, settlement: { select: { orderId: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 3 });
		const recent = await this.db.bridgeOrder.findMany({ where: { identityId, id: { notIn: pending.map((row) => row.id) } }, include: { deployment: { select: { quote: true } }, settlement: { select: { orderId: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 20 - pending.length });
		return [...pending, ...recent].map(publicOrder);
	}
	async create(terms: PrepareOrderTerms): Promise<BridgeOrder> {
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-orders:${terms.identityId}`}, 0))`;
			const previous = await tx.bridgeOrder.findUnique({ where: { identityId_idempotencyKey: { identityId: terms.identityId, idempotencyKey: terms.idempotencyKey } }, include: { deployment: { select: { quote: true } }, settlement: { select: { orderId: true, status: true } } } });
			if (previous) return this.assertRetry(previous, { deploymentId: terms.deployment.id, recipient: terms.recipient, amountRaw: terms.amountRaw });
			if (await tx.bridgeOrder.count({ where: { identityId: terms.identityId, status: 'prepared', OR: [{ settlement: null }, { settlement: { status: { not: 'completed' } } }] } }) >= limits.maxOpenOrders) throw new ConflictException(`You already have ${limits.maxOpenOrders} unfinished orders. Complete one or close an unused preparation before creating another.`);
			const deployment = await tx.bridgeDeployment.findFirst({ where: { id: terms.deployment.id, identityId: terms.identityId, status: 'verified', lastError: null } });
			if (!deployment || deployment.contractAddress !== terms.deployment.contractAddress || deployment.runtimeCodeHash !== terms.deployment.runtimeCodeHash) throw new ConflictException('Deployment verification changed. Refresh its saved status before preparing an order.');
			const id = randomUUID();
			const destinationContract = deployment.contractAddress!;
			const termsHash = createHash('sha256').update(JSON.stringify([
				'learning-bridge-order-v1', id, terms.identityId, terms.idempotencyKey, 'testnet', deployment.contractId,
				deployment.decimals, terms.amountRaw, terms.sender, terms.recipient, 998, deployment.id, destinationContract,
				limits.sourceConfirmations, limits.destinationConfirmations, limits.policyVersion,
			])).digest('hex');
			const custody = await this.custody.allocate(terms.identityId, id, termsHash);
			const row = await tx.bridgeOrder.create({ data: {
				id, identityId: terms.identityId, idempotencyKey: terms.idempotencyKey, deploymentId: deployment.id,
				sourceNetwork: 'testnet', contractId: deployment.contractId, decimals: deployment.decimals, symbol: terms.sourceSymbol,
				amountRaw: terms.amountRaw, sender: terms.sender, recipient: terms.recipient,
				destinationChainId: 998, destinationContract,
				sourceConfirmationsRequired: limits.sourceConfirmations, destinationConfirmationsRequired: limits.destinationConfirmations,
				termsHash, policyVersion: limits.policyVersion,
				targetCheckedBlockNumber: terms.targetBlockNumber, targetCheckedBlockHash: terms.targetBlockHash,
				custody: { create: custody },
			} });
			await tx.auditEvent.create({ data: { identityId: terms.identityId, action: 'bridge.order.prepared', data: { id, deploymentId: deployment.id, termsHash, paymentEnabled: false } } });
			return publicOrder({ ...row, deployment });
		}, { timeout: 10_000 });
	}
	async cancel(id: string, identityId: string) {
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-orders:${identityId}`}, 0))`;
			const row = await tx.bridgeOrder.findFirst({ where: { id, identityId }, include: { deployment: { select: { quote: true } }, settlement: { select: { orderId: true, status: true } } } });
			if (!row) throw new NotFoundException('Order not found for this signed-in TBC wallet.');
			if (row.status === 'cancelled') return publicOrder(row);
			if (row.settlement) throw new ConflictException('Payment details were opened for this order. It cannot be closed as an unused preparation; retain the address and reconcile any payments.');
			if (row.status !== 'prepared') throw new ConflictException('This order cannot be closed as an unused preparation.');
			const updated = await tx.bridgeOrder.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date() } });
			await tx.auditEvent.create({ data: { identityId, action: 'bridge.order.cancelled', data: { id } } });
			// Keep the encrypted custody record forever; its address must not be reused.
			return publicOrder({ ...updated, deployment: row.deployment });
		});
	}
}
