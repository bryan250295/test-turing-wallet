import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, ProofBridgeRoute, ProofBridgeTransfer } from '../../generated/prisma/client';
import type { ProofBridgeV3Route, ProofBridgeV3Snapshot, ProofBridgeV3Transfer } from '../../../shared/src/types/proofBridgeV3';
import { PrismaService } from '../database/prisma.service';

export interface SignedTransferEvidence {
	buildId: string;
	sender: string;
	recipient: string;
	amountRaw: string;
	depositId: string;
	sourceTxid: string;
	sourceRaw: string;
	parentTransactions: string[];
	ancestorTransactions: string[][];
	signatureWitnesses: Array<{ signaturePushOffset: number; publicKeyX: string; publicKeyY: string }>;
	signaturePushOffsets: number[];
}

export function routeRecord(row: ProofBridgeRoute): ProofBridgeV3Route {
	return {
		version: 'testnet-v3', chainId: 998, sourceAddress: row.sourceAddress,
		deployer: row.deployer as `0x${string}`, relay: row.relay as `0x${string}`,
		gateway: row.gateway as `0x${string}`, wrappedToken: row.wrappedToken as `0x${string}`,
		relayTxHash: row.relayTxHash as `0x${string}`, gatewayTxHash: row.gatewayTxHash as `0x${string}`,
		reserveController: row.reserveController as `0x${string}`, checkpointHeight: row.checkpointHeight,
		checkpointHash: row.checkpointHash as `0x${string}`, bootstrapRoot: row.bootstrapRoot as `0x${string}`,
		status: row.status as 'verified' | 'paused', verifiedAt: row.verifiedAt.toISOString(),
	};
}

export function transferRecord(row: ProofBridgeTransfer): ProofBridgeV3Transfer {
	return {
		id: row.id, status: row.status as ProofBridgeV3Transfer['status'], sender: row.sender,
		recipient: row.recipient as `0x${string}`, amountRaw: row.amountRaw.toFixed(0),
		depositId: row.depositId as `0x${string}`, sourceTxid: row.sourceTxid,
		blockHash: row.blockHash as `0x${string}` | null, blockHeight: row.blockHeight,
		sourceConfirmations: row.sourceConfirmations, relayHeight: row.relayHeight,
		mintTxHash: row.mintTxHash as `0x${string}` | null,
		mintConfirmations: row.mintConfirmations,
		mintFeeWei: row.mintFeeWei?.toFixed(0) ?? null, lastError: row.lastError,
		checkedAt: row.checkedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

@Injectable()
export class ProofBridgeV3Repository {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

	async route(identityId?: string) {
		return this.db.proofBridgeRoute.findFirst({ where: { version: 'testnet-v3', ...(identityId ? { identityId } : {}) } });
	}

	async register(identityId: string, data: Omit<Prisma.ProofBridgeRouteUncheckedCreateInput, 'id' | 'identityId' | 'version' | 'status' | 'verifiedAt' | 'createdAt' | 'updatedAt'>) {
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('proof-bridge:testnet-v3', 0))`;
			const existing = await tx.proofBridgeRoute.findUnique({ where: { version: 'testnet-v3' } });
			if (existing) {
				if (existing.identityId !== identityId || existing.relay.toLowerCase() !== data.relay.toLowerCase() || existing.gateway.toLowerCase() !== data.gateway.toLowerCase()) throw new ConflictException('A different verified Testnet-v3 route is already registered.');
				return routeRecord(existing);
			}
			const row = await tx.proofBridgeRoute.create({ data: { ...data, identityId, version: 'testnet-v3', status: 'verified', verifiedAt: new Date() } });
			await tx.auditEvent.create({ data: { identityId, action: 'proof_bridge.v3.route_registered', data: { routeId: row.id, relay: row.relay, gateway: row.gateway } } });
			return routeRecord(row);
		});
	}

	async createSigned(identityId: string, evidence: SignedTransferEvidence) {
		const route = await this.route(identityId);
		if (!route || route.status !== 'verified') throw new ConflictException('Register the verified Testnet-v3 route before signing a deposit.');
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`proof-bridge:testnet-v3:${identityId}`}, 0))`;
			const existing = await tx.proofBridgeTransfer.findUnique({ where: { sourceTxid: evidence.sourceTxid } });
			if (existing) return transferRecord(existing);
			const active = await tx.proofBridgeTransfer.findFirst({ where: { identityId, status: { notIn: ['completed', 'needs_review'] } }, select: { id: true } });
			if (active) throw new ConflictException('Wait for the active V3 transfer to complete before signing another deposit.');
			const row = await tx.proofBridgeTransfer.create({ data: {
				identityId, routeId: route.id, buildId: evidence.buildId, status: 'signed', sender: evidence.sender,
				recipient: evidence.recipient, amountRaw: evidence.amountRaw, depositId: evidence.depositId,
				sourceTxid: evidence.sourceTxid, sourceRaw: evidence.sourceRaw,
				parentTransactions: evidence.parentTransactions as Prisma.InputJsonValue,
				ancestorTransactions: evidence.ancestorTransactions as Prisma.InputJsonValue,
				signatureWitnesses: evidence.signatureWitnesses as Prisma.InputJsonValue,
				signaturePushOffsets: evidence.signaturePushOffsets as Prisma.InputJsonValue,
			} });
			await tx.auditEvent.create({ data: { identityId, action: 'proof_bridge.v3.deposit_signed', data: { transferId: row.id, txid: row.sourceTxid } } });
			return transferRecord(row);
		});
	}

	hasActive(identityId: string) {
		return this.db.proofBridgeTransfer.findFirst({ where: { identityId, status: { notIn: ['completed', 'needs_review'] } }, select: { id: true } }).then(Boolean);
	}

	async markSourceSubmitted(identityId: string, buildId: string) {
		const changed = await this.db.proofBridgeTransfer.updateMany({ where: { identityId, buildId, status: { in: ['signed', 'source_submitted'] } }, data: { status: 'source_submitted', checkedAt: null, lastError: null } });
		if (!changed.count) throw new NotFoundException('The signed V3 transfer was not found.');
		return this.db.proofBridgeTransfer.findUniqueOrThrow({ where: { buildId } });
	}

	async markNeedsReview(identityId: string, buildId: string, message: string) {
		const changed = await this.db.proofBridgeTransfer.updateMany({
			where: { identityId, buildId, status: { in: ['signed', 'source_submitted', 'confirming_source'] } },
			data: { status: 'needs_review', checkedAt: new Date(), lastError: message.slice(0, 1000) },
		});
		if (!changed.count) throw new NotFoundException('The V3 transfer requiring review was not found.');
	}

	async snapshot(identityId: string, relayer: ProofBridgeV3Snapshot['relayer']): Promise<ProofBridgeV3Snapshot> {
		const [route, transfers] = await Promise.all([
			this.route(identityId),
			this.db.proofBridgeTransfer.findMany({ where: { identityId }, orderBy: { createdAt: 'desc' }, take: 20 }),
		]);
		return { type: 'proof-bridge-v3', route: route ? routeRecord(route) : null, transfers: transfers.map(transferRecord), relayer, checkedAt: new Date().toISOString() };
	}

	async pending(now: Date) {
		return this.db.proofBridgeTransfer.findMany({
			where: { status: { in: ['source_submitted', 'confirming_source', 'relaying_headers', 'ready_to_mint', 'mint_submitted'] }, OR: [{ checkedAt: null }, { checkedAt: { lte: now } }] },
			include: { route: true }, orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } }, take: 8,
		});
	}

	update(id: string, data: Prisma.ProofBridgeTransferUpdateInput) {
		return this.db.proofBridgeTransfer.update({ where: { id }, data });
	}
}
