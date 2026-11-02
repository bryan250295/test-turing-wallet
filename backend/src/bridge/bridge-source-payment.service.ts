import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { AuthService, type Principal } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import type { BridgeSourcePayment } from '../../../shared/src/types/learningBridge';

const action = 'bridge.source.payment';
/** Append-only payment request journal. No keys, signatures, raw transactions or broadcast methods. */
@Injectable()
export class BridgeSourcePaymentService {
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService) {}
	private async owned(tx: Prisma.TransactionClient, orderId: string, principal: Principal) {
		this.auth.requireTbc(principal);
		const order = await tx.bridgeOrder.findFirst({ where: { id: orderId, identityId: principal.id }, select: { id: true, status: true, sender: true, contractId: true, decimals: true, amountRaw: true, custody: { select: { address: true } }, settlement: { select: { status: true, deposit: { select: { txid: true } } } } } });
		if (!order) throw new BadRequestException('Order not found for this TBC wallet.');
		return order;
	}
	private async latest(tx: Prisma.TransactionClient, orderId: string, identityId: string) {
		const row = await tx.auditEvent.findFirst({ where: { identityId, action, data: { path: ['orderId'], equals: orderId } }, orderBy: { createdAt: 'desc' } });
		return row ? { value: row.data as unknown as BridgeSourcePayment, createdAt: row.createdAt } : null;
	}
	async get(orderId: string, principal: Principal) {
		return this.db.$transaction(async tx => { await this.owned(tx, orderId, principal); return (await this.latest(tx, orderId, principal.id))?.value ?? null; });
	}
	async change(orderId: string, principal: Principal, operation: 'begin' | 'submit' | 'cancel', attemptId?: string, txid?: string) {
		this.auth.requireTbc(principal);
		return this.db.$transaction(async tx => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-orders:${principal.id}`}, 0))`;
			const order = await this.owned(tx, orderId, principal);
			const prior = await this.latest(tx, orderId, principal.id);
			let value: BridgeSourcePayment;
			if (operation === 'begin') {
				if (order.status !== 'prepared' || order.settlement?.status !== 'awaiting_payment' || order.settlement.deposit || !order.custody) throw new ConflictException('Payment is not available for this order. Refresh saved progress.');
				if (prior && prior.value.status !== 'cancelled') throw new ConflictException('A payment request already exists. Recover its TXID or finish the existing wallet prompt; do not pay again.');
				value = { orderId, attemptId: randomUUID(), status: 'awaiting_wallet', txid: null, sender: order.sender, contractId: order.contractId, amountRaw: order.amountRaw.toFixed(0), decimals: order.decimals, custodyAddress: order.custody.address };
			} else {
				if (!prior || prior.value.attemptId !== attemptId) throw new ConflictException('The payment request changed. Refresh saved progress.');
				if (operation === 'submit') {
					if (!txid || !/^(?!0{64}$)[0-9a-f]{64}$/.test(txid)) throw new BadRequestException('Use a single valid TBC transaction ID.');
					if (prior.value.status === 'submitted' && prior.value.txid === txid) return prior.value;
					if (prior.value.status !== 'awaiting_wallet') throw new ConflictException('This payment request already has a result. Keep its original TXID.');
					value = { ...prior.value, status: 'submitted', txid };
				} else {
					if (prior.value.status === 'cancelled') return prior.value;
					if (order.settlement?.deposit || prior.value.status !== 'awaiting_wallet') throw new ConflictException('A payment transaction is already saved. Check its status; do not pay again.');
					value = { ...prior.value, status: 'cancelled' };
				}
			}
			// Monotonic timestamps preserve journal order even for same-millisecond requests.
			const createdAt = new Date(Math.max(Date.now(), (prior?.createdAt.getTime() ?? 0) + 1));
			await tx.auditEvent.create({ data: { identityId: principal.id, action, createdAt, data: value as unknown as Prisma.InputJsonValue } });
			return value;
		});
	}
}
