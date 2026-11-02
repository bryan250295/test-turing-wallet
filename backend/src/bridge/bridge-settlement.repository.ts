import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, BridgeCallAttempt } from '../../generated/prisma/client';
import type { BridgeCallAttempt as PublicAttempt, BridgeSettlement } from '../../../shared/src/types/learningBridge';
import { PrismaService } from '../database/prisma.service';
import type { DepositObservation } from './bridge-deposit.verifier';
import { assertEscrowSenderIdle } from './redemption-escrow.repository';

const include = { custody: true, deployment: true, settlement: { include: { deposit: true, attempts: { orderBy: { createdAt: 'desc' as const }, take: 20 } } } } as const;
export type SettlementOrder = Prisma.BridgeOrderGetPayload<{ include: typeof include }>;
export const activeCallStates = ['quoted', 'awaiting_wallet', 'submitted', 'confirming'];
export function publicAttempt(row: BridgeCallAttempt): PublicAttempt {
	return { id: row.id, kind: row.kind as PublicAttempt['kind'], status: row.status as PublicAttempt['status'],
		transaction: { from: row.fromAddress, to: row.toAddress, chainId: '0x3e6', value: '0x0', data: row.data, nonce: `0x${row.nonce.toString(16)}`, gas: `0x${row.gasLimit.toString(16)}`, gasPrice: `0x${BigInt(row.gasPriceWei.toFixed(0)).toString(16)}` },
		estimatedFeeWei: row.estimatedFeeWei.toFixed(0), budgetWei: row.budgetWei.toFixed(0), expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
		txHash: row.txHash, confirmations: row.confirmations, actualFeeWei: row.actualFeeWei?.toFixed(0) ?? null, lastError: row.lastError };
}
export function publicSettlement(order: SettlementOrder): BridgeSettlement | null {
	const row = order.settlement;
	if (!row || !order.custody) return null;
	return { orderId: order.id, status: row.status as BridgeSettlement['status'], custodyAddress: order.custody.address, paymentOpenedAt: row.paymentOpenedAt.toISOString(), checkedAt: row.checkedAt?.toISOString() ?? null, lastError: row.lastError,
		deposit: row.deposit ? { txid: row.deposit.txid, vout: row.deposit.vout, amountRaw: row.deposit.amountRaw.toFixed(0), feeRaw: row.deposit.feeRaw.toFixed(0), confirmations: row.deposit.confirmations, blockHash: row.deposit.blockHash, blockHeight: row.deposit.blockHeight, checkedAt: row.deposit.checkedAt.toISOString() } : null,
		attempts: row.attempts.map(publicAttempt) };
}

@Injectable()
export class BridgeSettlementRepository {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	async owned(id: string, identityId: string): Promise<SettlementOrder> {
		const row = await this.db.bridgeOrder.findFirst({ where: { id, identityId }, include });
		if (!row) throw new NotFoundException('Order not found for this signed-in TBC wallet.');
		return row;
	}
	async open(order: SettlementOrder) {
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-orders:${order.identityId}`}, 0))`;
			const current = await tx.bridgeOrder.findUnique({ where: { id: order.id }, include: { settlement: true } });
			if (!current || current.status !== 'prepared') throw new ConflictException('This preparation is closed.');
			if (current.settlement) return;
			await tx.bridgeSettlement.create({ data: { orderId: order.id } });
			await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.payment.opened', data: { orderId: order.id, termsHash: order.termsHash } } });
		});
	}
	async observe(order: SettlementOrder, observation: DepositObservation) {
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-settlement:${order.id}`}, 0))`;
			const current = await tx.bridgeSettlement.findUnique({ where: { orderId: order.id }, include: { deposit: true, attempts: true } });
			if (!current) throw new ConflictException('Open payment details before submitting a deposit.');
			if (current.deposit && (current.deposit.txid !== observation.txid || current.deposit.vout !== observation.vout)) throw new ConflictException('This order already has a deposit. Retain it for reconciliation; another payment cannot replace it.');
			const reserved = await tx.bridgeDeposit.findUnique({ where: { sourceNetwork_txid_vout: { sourceNetwork: 'testnet', txid: observation.txid, vout: observation.vout } } });
			if (reserved && reserved.orderId !== order.id) throw new ConflictException('This source output is already reserved for another order.');
			if (!current.deposit) await tx.bridgeDeposit.create({ data: { orderId: order.id, sourceNetwork: 'testnet', ...observation } });
			else await tx.bridgeDeposit.update({ where: { orderId: order.id }, data: { confirmations: observation.confirmations, blockHash: observation.blockHash, blockHeight: observation.blockHeight, checkedAt: observation.checkedAt } });
			const enough = observation.confirmations >= order.sourceConfirmationsRequired;
			const sent = current.attempts.some((row) => row.kind === 'mint' && ['awaiting_wallet', 'submitted', 'confirming', 'verified'].includes(row.status));
			const changed = !!current.deposit?.blockHash && current.deposit.blockHash !== observation.blockHash;
			const status = sent ? (!enough || changed ? 'needs_review' : current.status) : enough ? 'ready_to_mint' : 'confirming';
			await tx.bridgeSettlement.update({ where: { orderId: order.id }, data: { status, checkedAt: observation.checkedAt, lastError: status === 'needs_review' ? 'Source confirmation or block changed after a mint request. Reconcile before any further transaction.' : null } });
			if (!current.deposit || current.status !== status) await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.deposit.checked', data: { orderId: order.id, txid: observation.txid, vout: observation.vout, confirmations: observation.confirmations, status } } });
		});
	}
	async unavailable(order: SettlementOrder, message: string, mismatch: boolean) {
		if (!order.settlement) return;
		await this.db.bridgeSettlement.update({ where: { orderId: order.id }, data: { lastError: message, checkedAt: new Date(), ...(mismatch && order.settlement.deposit ? { status: 'needs_review' } : {}) } });
	}
	async quote(order: SettlementOrder, data: Prisma.BridgeCallAttemptUncheckedCreateInput) {
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-settlement:${order.id}`}, 0))`;
			const current = await tx.bridgeSettlement.findUnique({ where: { orderId: order.id }, include: { attempts: true } });
			if (!current || current.status !== 'ready_to_mint') throw new ConflictException('Verify the source deposit before preparing a wallet call.');
			if (current.attempts.some((row) => activeCallStates.includes(row.status))) throw new ConflictException('An existing wallet call must be completed or reconciled first.');
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-evm-sender:${data.fromAddress}`}, 0))`;
			await assertEscrowSenderIdle(tx, String(data.fromAddress));
			if (await tx.bridgeDeployment.count({ where: { deployer: { equals: data.fromAddress, mode: 'insensitive' }, status: { in: ['prepared', 'awaiting_wallet', 'submitted', 'confirming'] } } })) throw new ConflictException('Finish the active deployment for this MetaMask account before preparing a bridge call.');
			const row = await tx.bridgeCallAttempt.create({ data });
			await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.call.quoted', data: { orderId: order.id, attemptId: row.id, kind: row.kind } } });
			return row;
		});
	}
	async begin(order: SettlementOrder, attempt: BridgeCallAttempt) {
		await this.db.$transaction(async (tx) => {
			const saved = await tx.bridgeCallAttempt.updateMany({ where: { id: attempt.id, status: 'quoted', updatedAt: attempt.updatedAt, expiresAt: { gt: new Date() } }, data: { status: 'awaiting_wallet' } });
			if (saved.count !== 1) throw new ConflictException('This wallet quote changed or expired. Refresh before continuing.');
			if (attempt.kind === 'mint') await tx.bridgeSettlement.update({ where: { orderId: order.id }, data: { status: 'mint_pending' } });
			await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.call.wallet_requested', data: { orderId: order.id, attemptId: attempt.id, kind: attempt.kind } } });
		});
	}
	async submit(order: SettlementOrder, attempt: BridgeCallAttempt, txHash: string) {
		return this.db.$transaction(async (tx) => {
			const changed = await tx.bridgeCallAttempt.updateMany({ where: { id: attempt.id, txHash: null, status: 'awaiting_wallet', updatedAt: attempt.updatedAt }, data: { txHash, status: 'submitted' } });
			if (!changed.count) throw new ConflictException('The saved wallet call changed. Refresh its transaction before retrying.');
			await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.call.submitted', data: { orderId: order.id, attemptId: attempt.id, txHash } } });
			return tx.bridgeCallAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
		});
	}
	async cancel(order: SettlementOrder, row: BridgeCallAttempt) {
		await this.db.$transaction(async (tx) => {
			const changed = await tx.bridgeCallAttempt.updateMany({ where: { id: row.id, updatedAt: row.updatedAt, txHash: null }, data: { status: 'cancelled' } });
			if (!changed.count) throw new ConflictException('This wallet call changed. Refresh its history before continuing.');
			if (row.kind === 'mint') await tx.bridgeSettlement.update({ where: { orderId: order.id }, data: { status: 'ready_to_mint' } });
			await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.call.cancelled', data: { orderId: order.id, attemptId: row.id } } });
		});
	}
	async observeCall(order: SettlementOrder, row: BridgeCallAttempt, observation: Prisma.BridgeCallAttemptUpdateManyMutationInput) {
		await this.db.$transaction(async (tx) => {
			const updated = await tx.bridgeCallAttempt.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: observation });
			if (!updated.count) throw new ConflictException('The wallet call changed during verification. Refresh saved progress.');
			if (row.kind === 'mint') {
				const status = observation.status === 'verified' ? 'completed' : observation.status === 'invalid' || row.status === 'verified' ? 'needs_review' : observation.status === 'reverted' ? 'ready_to_mint' : 'mint_pending';
				await tx.bridgeSettlement.update({ where: { orderId: order.id }, data: { status, lastError: typeof observation.lastError === 'string' ? observation.lastError : null, checkedAt: new Date() } });
			}
			await tx.auditEvent.create({ data: { identityId: order.identityId, action: 'bridge.call.checked', data: { orderId: order.id, attemptId: row.id, status: String(observation.status) } } });
		});
	}
}
