import { ConflictException, GatewayTimeoutException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { AuthService, type Principal } from '../auth/auth.service';
import type { Prisma } from '../../generated/prisma/client';
import type { RedemptionReleaseView } from '../../../shared/src/types/learningBridge';
import { API_URLS } from '../../../shared/src/config/constants';
import { ApiError } from '../../../shared/src/services/apiClient';
import { BridgeSettlementRepository } from './bridge-settlement.repository';
import { BridgeCustodyService } from './bridge-custody.service';
import { BridgeDepositVerifier } from './bridge-deposit.verifier';
import { RedemptionOrdersService } from './redemption-orders.service';
import { RedemptionReleaseEngine, type ReleaseInput } from './redemption-release.engine';
import { RedemptionLockVerifier } from './redemption-lock.verifier';

const include = { escrow: true, release: { include: { plan: true, signed: true, lock: true } } } as const;
type Row = Prisma.RedemptionOrderGetPayload<{ include: typeof include }>;
function view(row: Row): RedemptionReleaseView | null {
	const value = row.release; if (!value) return null;
	return { redemptionId: row.id, status: value.status as RedemptionReleaseView['status'], fundingAddress: value.fundingAddress,
		fundingRequiredRaw: value.fundingRequiredRaw.toString(), feeQuote: value.feeQuote as unknown as RedemptionReleaseView['feeQuote'],
		plan: value.plan ? { planHash: value.plan.planHash, feeRaw: value.plan.feeRaw.toString(), fundingTxid: value.plan.fundingTxid,
			fundingVout: value.plan.fundingVout, fundingValueRaw: value.plan.fundingValueRaw.toString(), reserveTxid: value.plan.reserveTxid,
			reserveVout: value.plan.reserveVout, recipient: row.tbcRecipient, amountRaw: row.amountRaw.toFixed(0), nativeChangeRaw: (value.plan.fundingValueRaw - value.plan.feeRaw).toString() } : null,
		lock: value.lock ? { txHash: value.lock.txHash, logIndex: value.lock.logIndex, confirmations: value.lock.confirmations, checkedAt: value.lock.checkedAt.toISOString() } : null,
		signed: value.signed ? { txid: value.signed.txid, feeRaw: value.signed.feeRaw.toString(), confirmations: value.signed.confirmations, blockHash: value.signed.blockHash } : null,
		createdAt: value.createdAt.toISOString(), checkedAt: value.checkedAt?.toISOString() ?? null, lastError: value.lastError,
		walletLockingEnabled: true };
}
@Injectable()
export class RedemptionReleaseService {
	private readonly running = new Set<string>();
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeSettlementRepository) private readonly orders: BridgeSettlementRepository,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
		@Inject(BridgeDepositVerifier) private readonly deposits: BridgeDepositVerifier,
		@Inject(RedemptionOrdersService) private readonly redemptions: RedemptionOrdersService,
		@Inject(RedemptionReleaseEngine) private readonly engine: RedemptionReleaseEngine,
		@Inject(RedemptionLockVerifier) private readonly locks: RedemptionLockVerifier) {}
	private async owned(orderId: string, redemptionId: string, principal: Principal) {
		this.auth.requireTbc(principal);
		const row = await this.db.redemptionOrder.findFirst({ where: { id: redemptionId, orderId, identityId: principal.id }, include });
		if (!row) throw new NotFoundException('Redemption not found for this signed-in TBC wallet.');
		return row;
	}
	async get(orderId: string, redemptionId: string, principal: Principal) { return view(await this.owned(orderId, redemptionId, principal)); }
	private async run<T>(id: string, response: Response, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.running.has(id) || this.running.size >= 4) throw new ConflictException('A release operation is already running. Refresh saved progress after it finishes.');
		this.running.add(id); const controller = new AbortController();
		const close = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', close);
		const timer = setTimeout(() => controller.abort(), 110_000); timer.unref();
		try { return await work(controller.signal); }
		catch (cause) { if (controller.signal.aborted) throw new GatewayTimeoutException('The release operation was interrupted. Refresh saved progress; never send another MT payment.'); throw cause; }
		finally { controller.abort(); clearTimeout(timer); response.removeListener('close', close); this.running.delete(id); }
	}
	private async source(row: Row, signal: AbortSignal) {
		if (row.status !== 'prepared') throw new ConflictException('This redemption preparation is closed.');
		const order = await this.orders.owned(row.orderId, row.identityId);
		if (order.settlement?.status !== 'completed' || !order.settlement.deposit || !order.custody || row.amountRaw.toFixed(0) !== order.amountRaw.toFixed(0)) throw new ConflictException('This first release supports the full completed forward deposit. Close a partial preparation to prepare the full amount.');
		await this.custody.assertRecoverable(order, order.custody);
		const reserve = await this.deposits.verify(order, order.custody.address, order.settlement.deposit.txid, signal);
		if (reserve.confirmations < order.sourceConfirmationsRequired || reserve.blockHash !== order.settlement.deposit.blockHash) throw new ConflictException('The original source token reserve is not confirmed in its saved canonical block.');
		const material = await this.engine.material(reserve.txid, reserve.vout, reserve.amountRaw, order.custody.address, row.tbcRecipient, order.custody.publicKeyHex, signal);
		return { order, material };
	}
	async walletPreflight(orderId: string, id: string, principal: Principal, response: Response) {
		return this.run(id, response, async (signal) => {
			const row = await this.owned(orderId, id, principal);
			if (!row.release?.plan || row.release.status !== 'funded' || row.release.signed || row.release.lock) throw new ConflictException('A funded, unused source token release plan is required for wallet locking. Refresh saved release progress.');
			const { material } = await this.source(row, signal);
			const funding = await this.engine.funding(material, row.release.plan.fundingTxid, signal);
			if (funding.planHash !== row.release.plan.planHash || funding.unsignedRaw !== row.release.plan.unsignedRaw || material.proof !== row.release.plan.proof) throw new ConflictException('The funded release differs from the saved plan. Reconcile before any permanent locking.');
			return row;
		});
	}
	async open(orderId: string, id: string, principal: Principal, response: Response) {
		return this.run(id, response, async (signal) => {
			const row = await this.owned(orderId, id, principal); if (row.release) return view(row);
			const { order, material } = await this.source(row, signal);
			await this.redemptions.checkTarget(order, row.escrow, row.holder, response);
			const quote = this.engine.quote(material); signal.throwIfAborted();
			await this.db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-reserve:${orderId}`}, 0))`;
				const current = await tx.redemptionOrder.findUniqueOrThrow({ where: { id }, include: { release: true } });
				if (current.release) return;
				if (current.status !== 'prepared') throw new ConflictException('The redemption was closed while preparing funding.');
				await tx.redemptionRelease.create({ data: { redemptionId: id, fundingAddress: material.custodyAddress, fundingRequiredRaw: BigInt(quote.fundingRequiredRaw), feeQuote: quote } });
				await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.redemption.fee_opened', data: { id, orderId, fundingRequiredRaw: quote.fundingRequiredRaw } } });
			});
			return view(await this.owned(orderId, id, principal));
		});
	}
	async fund(orderId: string, id: string, txid: string, principal: Principal, response: Response) {
		return this.run(id, response, async (signal) => {
			const row = await this.owned(orderId, id, principal);
			if (!row.release) throw new ConflictException('Open fee funding details first.');
			if (row.release.plan) { if (row.release.plan.fundingTxid !== txid) throw new ConflictException('This release already reserved another fee TXID. Keep the saved plan.'); return view(row); }
			const { order, material } = await this.source(row, signal);
			await this.redemptions.checkTarget(order, row.escrow, row.holder, response);
			const plan = await this.engine.funding(material, txid, signal); signal.throwIfAborted();
			await this.db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-reserve:${orderId}`}, 0))`;
				const current = await tx.redemptionRelease.findUniqueOrThrow({ where: { redemptionId: id }, include: { plan: true } });
				if (current.plan) { if (current.plan.fundingTxid !== txid) throw new ConflictException('Another funding input is already reserved.'); return; }
				if (current.status !== 'awaiting_fee') throw new ConflictException('Refresh the saved release state.');
				await tx.redemptionReleasePlan.create({ data: { redemptionId: id, unsignedRaw: plan.unsignedRaw, planHash: plan.planHash, feeRaw: BigInt(plan.feeRaw),
					inputs: plan.inputs as unknown as Prisma.InputJsonValue, proof: material.proof, fundingTxid: txid, fundingVout: plan.funding.outputIndex,
					fundingValueRaw: BigInt(plan.funding.satoshis), reserveTxid: material.token.txId, reserveVout: material.token.outputIndex,
					reserveRaw: material.reserve.uncheckedSerialize(), fundingRaw: plan.fundingRaw } });
				await tx.redemptionRelease.update({ where: { redemptionId: id }, data: { status: 'funded', checkedAt: new Date(), lastError: null } });
				await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.redemption.plan_reserved', data: { id, planHash: plan.planHash, feeTxid: txid } } });
			});
			return view(await this.owned(orderId, id, principal));
		});
	}
	async attachLock(orderId: string, id: string, txHash: string, principal: Principal, response: Response) {
		return this.run(id, response, async () => {
			const row = await this.owned(orderId, id, principal);
			if (!row.release?.plan || row.release.signed) throw new ConflictException('Reserve a funded release plan before attaching an escrow lock.');
			if (row.release.lock && row.release.lock.txHash !== txHash) throw new ConflictException('A different escrow event is already attached to this redemption.');
			const lock = await this.locks.verify(row, row.escrow, txHash, response);
			await this.db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-release:${id}`}, 0))`;
				const current = await tx.redemptionRelease.findUniqueOrThrow({ where: { redemptionId: id }, include: { signed: true, lock: true } });
				if (current.signed || current.lock && (current.lock.txHash !== txHash || current.lock.logIndex !== lock.logIndex)) throw new ConflictException('The saved lock or release changed. Refresh first.');
				await tx.redemptionLock.upsert({ where: { redemptionId: id }, create: { redemptionId: id, ...lock }, update: { blockHash: lock.blockHash, blockNumber: lock.blockNumber, confirmations: lock.confirmations, checkedAt: lock.checkedAt } });
				await tx.redemptionRelease.update({ where: { redemptionId: id }, data: { status: 'locked', checkedAt: new Date(), lastError: null } });
				await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.redemption.lock_verified', data: { id, txHash, logIndex: lock.logIndex } } });
			});
			return view(await this.owned(orderId, id, principal));
		});
	}
	private async freshLock(row: Row, response: Response) {
		const saved = row.release?.lock;
		if (!saved) throw new ConflictException('A saved permanent lock is required.');
		const proof = await this.locks.verify(row, row.escrow, saved.txHash, response);
		if (proof.logIndex !== saved.logIndex) throw new ConflictException('The lock event index changed after a reorg. Retain both records for reconciliation.');
		await this.db.redemptionLock.update({ where: { redemptionId: row.id }, data: { blockHash: proof.blockHash, blockNumber: proof.blockNumber, confirmations: proof.confirmations, checkedAt: proof.checkedAt } });
		return proof;
	}
	async sign(orderId: string, id: string, planHash: string, principal: Principal, response: Response) {
		return this.run(id, response, async (signal) => {
			const row = await this.owned(orderId, id, principal); const release = row.release;
			if (!release?.plan || !release.lock || release.plan.planHash !== planHash) throw new ConflictException('A funded reviewed plan and verified permanent lock are required before custody signing.');
			if (release.signed) return view(row);
			await this.freshLock(row, response);
			const { order, material } = await this.source(row, signal); const plan = release.plan;
			const funding = await this.engine.funding(material, plan.fundingTxid, signal);
			if (funding.planHash !== planHash || funding.unsignedRaw !== plan.unsignedRaw || material.reserve.uncheckedSerialize() !== plan.reserveRaw || material.proof !== plan.proof) throw new ConflictException('The source release no longer matches its immutable reserved plan. Reconcile it without paying again.');
			signal.throwIfAborted();
			const signed = await this.custody.signRelease(order, order.custody!, planHash, (key) => this.engine.sign(plan.unsignedRaw, material, funding.funding, plan.feeRaw, key));
			await this.db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-release:${id}`}, 0))`;
				const current = await tx.redemptionRelease.findUniqueOrThrow({ where: { redemptionId: id }, include: { signed: true, plan: true, lock: true } });
				if (current.signed) return;
				if (current.status !== 'locked' || current.plan?.planHash !== planHash || current.lock?.txHash !== release.lock!.txHash) throw new ConflictException('The reserved release changed before signing could be saved. Nothing was broadcast.');
				await tx.redemptionSignedRelease.create({ data: { redemptionId: id, raw: signed.raw, txid: signed.txid, feeRaw: plan.feeRaw } });
				await tx.redemptionRelease.update({ where: { redemptionId: id }, data: { status: 'signed', checkedAt: new Date(), lastError: null } });
				await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.redemption.signed', data: { id, txid: signed.txid, planHash } } });
			});
			return view(await this.owned(orderId, id, principal));
		});
	}
	private async visible(row: Row, signal: AbortSignal): Promise<boolean> {
		try {
			const tx = await this.engine.raw(row.release!.signed!.txid, signal);
			if (tx.uncheckedSerialize() !== row.release!.signed!.raw) throw new ConflictException('Source node returned different bytes for the saved release TXID.');
			return true;
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 404) return false;
			throw cause;
		}
	}
	async broadcast(orderId: string, id: string, planHash: string, principal: Principal, response: Response) {
		return this.run(id, response, async (signal) => {
			const row = await this.owned(orderId, id, principal); const release = row.release;
			if (!release?.signed || !release.lock || !release.plan || release.plan.planHash !== planHash) throw new ConflictException('Review and sign the fixed source token release before broadcasting.');
			if (release.status === 'completed') return view(row);
			if (!['signed', 'broadcasting', 'submitted', 'confirming'].includes(release.status)) throw new ConflictException('This release needs reconciliation before broadcasting.');
			// Reconcile first after any uncertain prior send. A transient source error
			// never proves absence and never causes an automatic broadcast retry.
			if (release.status !== 'signed') {
				if (await this.visible(row, signal)) return this.checkUnlocked(row, principal, response, signal);
			}
			await this.freshLock(row, response);
			const { material } = await this.source(row, signal);
			await this.engine.nativeUnspent(release.fundingAddress, release.plan.fundingTxid, release.plan.fundingVout, Number(release.plan.fundingValueRaw), signal);
			const inputs = release.plan.inputs as unknown as ReleaseInput[];
			const signed = this.engine.assertPlan(release.signed.raw, { inputs, recipient: row.tbcRecipient, amountRaw: row.amountRaw.toFixed(0), custodyAddress: release.fundingAddress, feeRaw: release.plan.feeRaw, reserveRaw: release.plan.reserveRaw });
			if (signed.hash !== release.signed.txid || createHash('sha256').update(release.plan.unsignedRaw).digest('hex') !== planHash || material.proof !== release.plan.proof) throw new ConflictException('The saved signed release differs from its fixed TXID or plan.');
			for (let index = 0; index < signed.inputs.length; index++) if (!signed.verifyScript(index).success) throw new ConflictException('A saved release script did not verify. Nothing was broadcast.');
			signal.throwIfAborted();
			const reserved = await this.db.redemptionRelease.updateMany({ where: { redemptionId: id, status: release.status, updatedAt: release.updatedAt }, data: { status: 'broadcasting', checkedAt: new Date(), lastError: 'Submission started. Reconcile this exact saved TXID before retrying.' } });
			if (reserved.count !== 1) throw new ConflictException('Another release operation changed this request. Refresh its saved state.');
			// The raw signed transaction is already durable. Once started, track the
			// same submission independently of a browser disconnect. No POST retries.
			let accepted = false;
			try {
				const result = await fetch(API_URLS.testnetBroadcast, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ txraw: release.signed.raw }), signal: AbortSignal.timeout(25_000) });
				const body = await result.json(); accepted = result.ok && String(body.code) === '200' && body.data?.txid === release.signed.txid;
			} catch { /* The durable broadcasting state is deliberately retained. */ }
			await this.db.redemptionRelease.update({ where: { redemptionId: id }, data: { status: accepted ? 'submitted' : 'broadcasting', checkedAt: new Date(), lastError: accepted ? null : 'Submission is uncertain. Check the saved TXID; do not create or pay another release.' } });
			return view(await this.owned(orderId, id, principal));
		});
	}
	private async checkUnlocked(row: Row, principal: Principal, response: Response, signal: AbortSignal) {
		const release = row.release!;
		if (!release.signed || !release.lock || !release.plan) throw new ConflictException('No signed release is saved.');
		if (!await this.visible(row, signal)) throw new ConflictException('The exact saved release is not yet visible. Absence does not establish rejection. Retain its TXID.');
		const block = await this.engine.confirmed(release.signed.txid, signal, release.signed.blockHash === null && ['submitted', 'confirming', 'broadcasting'].includes(release.status));
		try { await this.freshLock(row, response); }
		catch { await this.db.redemptionRelease.update({ where: { redemptionId: row.id }, data: { status: 'needs_review', checkedAt: new Date(), lastError: 'The permanent lock could not be reverified after source token submission. Preserve both TXIDs for reconciliation.' } }); throw new ServiceUnavailableException('The permanent lock could not be reverified. source token submission is retained for review; do not pay again.'); }
		const signed = this.engine.assertPlan(release.signed.raw, { inputs: release.plan.inputs as unknown as ReleaseInput[], recipient: row.tbcRecipient, amountRaw: row.amountRaw.toFixed(0), custodyAddress: release.fundingAddress, feeRaw: release.plan.feeRaw, reserveRaw: release.plan.reserveRaw });
		if (signed.hash !== release.signed.txid) throw new ConflictException('Saved release TXID mismatch.');
		for (let i = 0; i < signed.inputs.length; i++) if (!signed.verifyScript(i).success) throw new ConflictException('Saved release signature verification failed.');
		await this.db.$transaction(async (tx) => {
			await tx.redemptionSignedRelease.update({ where: { redemptionId: row.id }, data: { confirmations: block.confirmations, blockHash: block.blockHash, blockHeight: block.blockHeight } });
			await tx.redemptionRelease.update({ where: { redemptionId: row.id }, data: { status: block.confirmations >= 6 ? 'completed' : 'confirming', checkedAt: new Date(), lastError: null } });
			if (block.confirmations >= 6 && release.status !== 'completed') await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.redemption.completed', data: { id: row.id, txid: release.signed!.txid } } });
		});
		return view(await this.owned(row.orderId, row.id, principal));
	}
	async check(orderId: string, id: string, principal: Principal, response: Response) {
		return this.run(id, response, async (signal) => this.checkUnlocked(await this.owned(orderId, id, principal), principal, response, signal));
	}
}
