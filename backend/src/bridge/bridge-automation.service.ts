import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BridgeCustodyService } from './bridge-custody.service';
import { BridgeDepositVerifier } from './bridge-deposit.verifier';
import { BridgeCallVerifier } from './bridge-call.verifier';
import { BridgeProgressService } from './bridge-progress.service';
import { BridgeSettlementRepository } from './bridge-settlement.repository';

const TBC_POLL_MS = 60_000;
const EVM_POLL_MS = 12_000;
const SCHEDULER_MS = 5_000;

@Injectable()
export class BridgeAutomationService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(BridgeAutomationService.name);
	private readonly running = new Set<string>();
	private timer?: NodeJS.Timeout;
	private ticking = false;
	constructor(
		@Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeSettlementRepository) private readonly repository: BridgeSettlementRepository,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
		@Inject(BridgeDepositVerifier) private readonly deposits: BridgeDepositVerifier,
		@Inject(BridgeCallVerifier) private readonly calls: BridgeCallVerifier,
		@Inject(BridgeProgressService) private readonly progress: BridgeProgressService,
	) {}

	onModuleInit() {
		this.logger.log(`Background observers enabled: TBC ${TBC_POLL_MS / 1000}s, HyperEVM ${EVM_POLL_MS / 1000}s; observation only, no transaction signing or broadcast.`);
		this.timer = setInterval(() => { void this.tick(); }, SCHEDULER_MS);
		this.timer.unref();
		void this.tick();
	}
	onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

	private async guarded(key: string, operation: () => Promise<void>) {
		if (this.running.has(key) || this.running.size >= 4) return;
		this.running.add(key);
		try { await operation(); }
		catch (cause) {
			this.logger.warn({ key, error: cause instanceof Error ? cause.message : 'Unknown background observation error' });
		} finally { this.running.delete(key); }
	}

	private async observeDeposit(orderId: string) {
		await this.guarded(`tbc:${orderId}`, async () => {
			const order = await this.repository.find(orderId);
			const txid = order.settlement?.sourceTxid ?? order.settlement?.deposit?.txid;
			if (!order.settlement || !order.custody || !txid || order.settlement.status === 'completed' || order.settlement.status === 'needs_review') return;
			const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 50_000); timeout.unref();
			try {
				await this.custody.assertRecoverable(order, order.custody);
				const observation = await this.deposits.verify(order, order.custody.address, txid, controller.signal);
				await this.repository.observe(order, observation);
			} catch (cause) {
				await this.repository.unavailable(order, cause instanceof Error ? cause.message : 'Automatic TBC verification is temporarily unavailable.', false);
				throw cause;
			} finally {
				clearTimeout(timeout);
				this.progress.publish(order.identityId, order.id, 'tbc-confirmations');
			}
		});
	}

	private async observeCall(attemptId: string, orderId: string) {
		await this.guarded(`evm:${attemptId}`, async () => {
			const order = await this.repository.find(orderId);
			const row = order.settlement?.attempts.find((attempt) => attempt.id === attemptId);
			if (!row?.txHash || !['submitted', 'confirming'].includes(row.status)) return;
			const observation = await this.calls.receipt(order, row);
			await this.repository.observeCall(order, row, observation);
			this.progress.publish(order.identityId, order.id, 'hyperevm-confirmations');
		});
	}

	private async tick() {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = Date.now();
			const [settlements, calls] = await Promise.all([
				this.db.bridgeSettlement.findMany({
					where: { sourceTxid: { not: null }, status: { in: ['awaiting_payment', 'confirming', 'ready_to_mint', 'mint_pending'] },
						OR: [{ checkedAt: null }, { checkedAt: { lte: new Date(now - TBC_POLL_MS) } }] },
					select: { orderId: true }, orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } }, take: 8,
				}),
				this.db.bridgeCallAttempt.findMany({
					where: { txHash: { not: null }, status: { in: ['submitted', 'confirming'] }, updatedAt: { lte: new Date(now - EVM_POLL_MS) } },
					select: { id: true, orderId: true }, orderBy: { updatedAt: 'asc' }, take: 8,
				}),
			]);
			await Promise.all([
				...settlements.map((row) => this.observeDeposit(row.orderId)),
				...calls.map((row) => this.observeCall(row.id, row.orderId)),
			]);
		} catch (cause) {
			this.logger.warn({ error: cause instanceof Error ? cause.message : 'Background scheduler failed' });
		} finally { this.ticking = false; }
	}
}
