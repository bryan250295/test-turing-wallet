import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, RedemptionEscrowDeployment } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { RedemptionEscrowDeployment as PublicDeployment, RedemptionEscrowPreview } from '../../../shared/src/types/learningBridge';
import { LEARNING_REDEMPTION_ESCROW_BUILD as build, LEARNING_REDEMPTION_ESCROW_RUNTIME as runtime } from '../../../shared/src/contracts/learningRedemptionEscrow';
import type { SettlementOrder } from './bridge-settlement.repository';

export const escrowActiveStates = ['prepared', 'awaiting_wallet', 'submitted', 'confirming'];
export async function assertEscrowSenderIdle(tx: Prisma.TransactionClient, from: string, exceptId?: string) {
	if (await tx.redemptionEscrowDeployment.count({ where: { deployer: from.toLowerCase(), status: { in: escrowActiveStates }, ...(exceptId ? { id: { not: exceptId } } : {}) } })) throw new ConflictException('Finish or reconcile the active escrow deployment for this MetaMask account first.');
	if (await tx.redemptionWalletCall.count({ where: { fromAddress: from.toLowerCase(), status: { in: ['quoted', 'awaiting_wallet', 'submitted', 'confirming'] }, ...(exceptId ? { id: { not: exceptId } } : {}) } })) throw new ConflictException('Finish or reconcile the active redemption wallet request for this MetaMask account first.');
}
export function escrowRecord(row: RedemptionEscrowDeployment): PublicDeployment {
	return { id: row.id, orderId: row.orderId, deploymentId: row.deploymentId, status: row.status as PublicDeployment['status'], quote: row.quote as unknown as RedemptionEscrowPreview,
		txHash: row.txHash, contractAddress: row.contractAddress, confirmations: row.confirmations, requiredConfirmations: 6,
		receiptBlockHash: row.receiptBlockHash, receiptBlockNumber: row.receiptBlockNumber?.toString() ?? null, actualFeeWei: row.actualFeeWei?.toFixed(0) ?? null,
		runtimeCodeHash: row.runtimeCodeHash, verifiedAt: row.verifiedAt?.toISOString() ?? null, checkedAt: row.checkedAt?.toISOString() ?? null, lastError: row.lastError, createdAt: row.createdAt.toISOString() };
}

@Injectable()
export class RedemptionEscrowRepository {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	async owned(id: string, orderId: string, identityId: string) {
		const row = await this.db.redemptionEscrowDeployment.findFirst({ where: { id, orderId, identityId } });
		if (!row) throw new NotFoundException('Escrow deployment not found for this order and TBC identity.');
		return row;
	}
	async list(orderId: string, identityId: string) {
		return (await this.db.redemptionEscrowDeployment.findMany({ where: { orderId, identityId }, orderBy: { createdAt: 'desc' }, take: 20 })).map(escrowRecord);
	}
	private async senderIdle(tx: Prisma.TransactionClient, from: string, exceptId?: string) {
		await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-evm-sender:${from.toLowerCase()}`}, 0))`;
		await assertEscrowSenderIdle(tx, from, exceptId);
		if (await tx.bridgeDeployment.count({ where: { deployer: { equals: from, mode: 'insensitive' }, status: { in: escrowActiveStates } } })
			|| await tx.bridgeCallAttempt.count({ where: { fromAddress: from.toLowerCase(), status: { in: ['quoted', 'awaiting_wallet', 'submitted', 'confirming'] } } })) throw new ConflictException('Finish the active wrapped-token deployment or bridge call for this MetaMask account first.');
	}
	async create(order: SettlementOrder, quote: RedemptionEscrowPreview) {
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-escrow-token:${order.deploymentId}`}, 0))`;
			if (await tx.redemptionEscrowDeployment.count({ where: { deploymentId: order.deploymentId, status: { in: [...escrowActiveStates, 'verified'] } } })) throw new ConflictException('An escrow is already prepared or verified for this wrapped token contract. Refresh its original completed order.');
			await this.senderIdle(tx, quote.admin);
			if (Date.parse(quote.expiresAt) <= Date.now()) throw new ConflictException('The deployment estimate expired. Prepare again.');
			const row = await tx.redemptionEscrowDeployment.create({ data: { orderId: order.id, deploymentId: order.deploymentId, identityId: order.identityId,
				deployer: quote.admin, wrappedToken: quote.wrappedToken, sourceContractId: quote.sourceContractId, decimals: quote.decimals, nonce: BigInt(quote.nonce),
				quote: quote as unknown as Prisma.InputJsonValue, buildInputSha256: build.buildInputSha256, transactionData: quote.transactionData,
				runtimeBytecode: runtime.bytecode, immutableReferences: [...runtime.immutableReferences] as Prisma.InputJsonValue, expiresAt: new Date(quote.expiresAt) } });
			await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.escrow.prepared', data: { orderId: order.id, id: row.id } } });
			return escrowRecord(row);
		});
	}
	async begin(row: RedemptionEscrowDeployment) {
		await this.db.$transaction(async (tx) => {
			await this.senderIdle(tx, row.deployer, row.id);
			const result = await tx.redemptionEscrowDeployment.updateMany({ where: { id: row.id, identityId: row.identityId, status: 'prepared', updatedAt: row.updatedAt, expiresAt: { gt: new Date() } }, data: { status: 'awaiting_wallet', lastError: null } });
			if (result.count !== 1) throw new ConflictException('This escrow quote changed, expired or was already used. Refresh saved deployments.');
			await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.escrow.wallet_requested', data: { id: row.id } } });
		});
	}
	async cancel(row: RedemptionEscrowDeployment, notSent: boolean) {
		if (row.txHash || row.status !== 'prepared' && !(row.status === 'awaiting_wallet' && notSent)) throw new ConflictException('Check MetaMask Activity and recover the transaction hash before retrying an uncertain send.');
		await this.db.$transaction(async (tx) => {
			const result = await tx.redemptionEscrowDeployment.updateMany({ where: { id: row.id, identityId: row.identityId, txHash: null, status: row.status, updatedAt: row.updatedAt }, data: { status: 'cancelled', lastError: null } });
			if (result.count !== 1) throw new ConflictException('The saved escrow request changed. Refresh it first.');
			await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.escrow.cancelled', data: { id: row.id, notSent } } });
		});
		return escrowRecord(await this.owned(row.id, row.orderId, row.identityId));
	}
	async submit(row: RedemptionEscrowDeployment, txHash: string) {
		if (row.txHash) { if (row.txHash !== txHash) throw new ConflictException('This escrow deployment already has a different transaction hash.'); return escrowRecord(row); }
		if (row.status !== 'awaiting_wallet') throw new ConflictException('This escrow deployment has not reserved a wallet send slot.');
		return this.db.$transaction(async (tx) => {
			const result = await tx.redemptionEscrowDeployment.updateMany({ where: { id: row.id, identityId: row.identityId, updatedAt: row.updatedAt, txHash: null, status: 'awaiting_wallet' }, data: { txHash, status: 'submitted', lastError: null } });
			if (result.count !== 1) throw new ConflictException('This escrow request changed. Refresh saved deployments.');
			await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.escrow.submitted', data: { id: row.id, txHash } } });
			return escrowRecord(await tx.redemptionEscrowDeployment.findUniqueOrThrow({ where: { id: row.id } }));
		});
	}
	async observe(row: RedemptionEscrowDeployment, data: Prisma.RedemptionEscrowDeploymentUpdateManyMutationInput) {
		await this.db.$transaction(async (tx) => {
			const result = await tx.redemptionEscrowDeployment.updateMany({ where: { id: row.id, identityId: row.identityId, updatedAt: row.updatedAt, txHash: row.txHash }, data });
			if (result.count && data.status === 'verified' && row.status !== 'verified') await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.escrow.verified', data: { id: row.id, txHash: row.txHash } } });
		});
		return escrowRecord(await this.owned(row.id, row.orderId, row.identityId));
	}
}
