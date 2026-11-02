import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { BridgeDeployment, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { BridgeDeploymentPreview, BridgeDeploymentRecord } from '../../../shared/src/types/learningBridge';
import { LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import { deploymentBuild } from './bridge-build';
import { bridgeRouteId, wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import { assertEscrowSenderIdle } from './redemption-escrow.repository';

export function deploymentRecord(row: BridgeDeployment): BridgeDeploymentRecord {
	return {
		...wrappedMetadata(row.quote), destinationChainId: 998, id: row.id, contractId: row.contractId, deployer: row.deployer, admin: row.admin, minter: row.minter, chainId: 998, decimals: row.decimals,
		status: row.status as BridgeDeploymentRecord['status'], nonce: row.nonce.toString(), quote: row.quote as unknown as BridgeDeploymentPreview,
		txHash: row.txHash, contractAddress: row.contractAddress, confirmations: row.confirmations, requiredConfirmations: LEARNING_BRIDGE_EVM.deploymentConfirmations,
		receiptBlockHash: row.receiptBlockHash, receiptBlockNumber: row.receiptBlockNumber?.toString() ?? null,
		gasUsed: row.gasUsed?.toFixed(0) ?? null, effectiveGasPriceWei: row.effectiveGasPriceWei?.toFixed(0) ?? null, actualFeeWei: row.actualFeeWei?.toFixed(0) ?? null,
		runtimeCodeHash: row.runtimeCodeHash, verifiedAt: row.verifiedAt?.toISOString() ?? null, checkedAt: row.checkedAt?.toISOString() ?? null,
		lastError: row.lastError, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
	};
}

@Injectable()
export class BridgeDeploymentsRepository {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	async owned(id: string, identityId: string) {
		const row = await this.db.bridgeDeployment.findFirst({ where: { id, identityId } });
		if (!row) throw new NotFoundException('Deployment record not found for this signed-in TBC wallet.');
		return row;
	}
	async list(identityId: string, contractId?: string) {
		return (await this.db.bridgeDeployment.findMany({ where: { identityId, ...(contractId ? { contractId } : {}) }, orderBy: { createdAt: 'desc' }, take: 20 })).map(deploymentRecord);
	}
	async create(identityId: string, quote: BridgeDeploymentPreview, nonce: number, transactionData: string) {
		const routeId = bridgeRouteId(quote.contractId);
		const { build, runtime } = deploymentBuild(quote);
		try {
			return await this.db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`deployment:${identityId}:${routeId}`}, 0))`;
				const existing = await tx.bridgeDeployment.findFirst({ where: { identityId, routeId, status: { in: ['prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified'] } } });
				if (existing) throw new ConflictException('An existing deployment needs attention. Refresh saved deployments before preparing another.');
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-evm-sender:${quote.deployer.toLowerCase()}`}, 0))`;
				await assertEscrowSenderIdle(tx, quote.deployer);
				if (await tx.bridgeCallAttempt.count({ where: { fromAddress: quote.deployer.toLowerCase(), status: { in: ['quoted', 'awaiting_wallet', 'submitted', 'confirming'] } } })) throw new ConflictException('Finish the active bridge call for this MetaMask account before preparing a deployment.');
				const row = await tx.bridgeDeployment.create({ data: {
					identityId, routeId, chainId: 998, contractId: quote.contractId, decimals: quote.decimals,
					deployer: quote.deployer, admin: quote.admin, minter: quote.minter, nonce: BigInt(nonce),
					buildInputSha256: build.buildInputSha256, initCodeHash: quote.initCodeHash, transactionData,
					runtimeBytecode: runtime.bytecode, immutableReferences: [...runtime.immutableReferences] as Prisma.InputJsonValue,
					quote: quote as unknown as Prisma.InputJsonValue, expiresAt: new Date(quote.expiresAt),
				} });
				await tx.auditEvent.create({ data: { identityId, action: 'bridge.deployment.prepared', data: { id: row.id, initCodeHash: row.initCodeHash } } });
				return deploymentRecord(row);
			});
		} catch (cause) { this.uniqueConflict(cause); }
	}
	private uniqueConflict(cause: unknown): never {
		if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'P2002') throw new ConflictException('A deployment or transaction is already recorded. Refresh saved deployments.');
		throw cause;
	}
	async begin(row: BridgeDeployment) {
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-evm-sender:${row.deployer.toLowerCase()}`}, 0))`;
			await assertEscrowSenderIdle(tx, row.deployer);
			if (await tx.bridgeCallAttempt.count({ where: { fromAddress: row.deployer.toLowerCase(), status: { in: ['quoted', 'awaiting_wallet', 'submitted', 'confirming'] } } })) throw new ConflictException('Finish the active bridge call for this account first.');
			const changed = await tx.bridgeDeployment.updateMany({ where: { id: row.id, identityId: row.identityId, status: 'prepared', updatedAt: row.updatedAt, expiresAt: { gt: new Date() } }, data: { status: 'awaiting_wallet', lastError: null } });
			if (changed.count !== 1) throw new ConflictException('This preparation expired or was already used. Refresh its saved status before continuing.');
		});
	}
	async cancel(id: string, identityId: string) {
		const changed = await this.db.bridgeDeployment.updateMany({ where: { id, identityId, txHash: null, status: { in: ['prepared', 'awaiting_wallet'] } }, data: { status: 'cancelled' } });
		if (!changed.count) throw new ConflictException('A submitted deployment cannot be cancelled here. Refresh its status.');
		return deploymentRecord(await this.owned(id, identityId));
	}
	async attach(id: string, identityId: string, txHash: string) {
		try {
			return await this.db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`deployment-hash:${id}`}, 0))`;
				const row = await tx.bridgeDeployment.findFirst({ where: { id, identityId } });
				if (!row) throw new NotFoundException('Deployment record not found.');
				if (row.txHash && row.txHash !== txHash) throw new ConflictException('A different transaction is already attached. Its hash cannot be overwritten.');
				if (row.txHash) return deploymentRecord(row);
				const saved = await tx.bridgeDeployment.update({ where: { id }, data: { txHash, status: 'submitted', lastError: null } });
				await tx.auditEvent.create({ data: { identityId, action: 'bridge.deployment.submitted', data: { id, txHash } } });
				return deploymentRecord(saved);
			});
		} catch (cause) { this.uniqueConflict(cause); }
	}
	async observe(row: BridgeDeployment, data: Prisma.BridgeDeploymentUpdateManyMutationInput) {
		try {
			await this.db.$transaction(async (tx) => {
				const result = await tx.bridgeDeployment.updateMany({ where: { id: row.id, identityId: row.identityId, updatedAt: row.updatedAt, txHash: row.txHash }, data });
				if (result.count && data.status === 'verified' && row.status !== 'verified') await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.deployment.verified', data: { id: row.id, txHash: row.txHash } } });
			});
			return deploymentRecord(await this.owned(row.id, row.identityId));
		} catch (cause) { this.uniqueConflict(cause); }
	}
}
