import { BadRequestException, ConflictException, GatewayTimeoutException, Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Response } from 'express';
import { getAddress, isAddress, type Address } from 'viem';
import { AuthService, type Principal } from '../auth/auth.service';
import { BridgeSettlementRepository, activeCallStates, publicAttempt, publicSettlement, type SettlementOrder } from './bridge-settlement.repository';
import { BridgeCustodyService } from './bridge-custody.service';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { BridgeAssetVerifier } from './bridge-asset.verifier';
import { BridgeDepositVerifier } from './bridge-deposit.verifier';
import { PrismaService } from '../database/prisma.service';
import { BridgeCallVerifier } from './bridge-call.verifier';
import type { BridgeCallKind } from '../../../shared/src/types/learningBridge';

@Injectable()
export class BridgeSettlementService {
	private readonly running = new Set<string>();
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeSettlementRepository) private readonly repository: BridgeSettlementRepository,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService,
		@Inject(BridgeAssetVerifier) private readonly asset: BridgeAssetVerifier,
		@Inject(BridgeDepositVerifier) private readonly deposits: BridgeDepositVerifier,
		@Inject(BridgeCallVerifier) private readonly calls: BridgeCallVerifier,
	) {}
	private async job<T>(id: string, principal: Principal, response: Response, operation: (order: SettlementOrder, signal: AbortSignal) => Promise<T>): Promise<T> {
		this.auth.requireTbc(principal);
		if (this.running.has(id) || this.running.size >= 4) throw new ConflictException('An order operation is running. Wait, then refresh saved progress.');
		this.running.add(id);
		const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 110_000); timer.unref();
		const close = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', close);
		try { return await operation(await this.repository.owned(id, principal.id), controller.signal); }
		catch (cause) {
			if (controller.signal.aborted) throw new GatewayTimeoutException('The order check timed out or was cancelled. Refresh saved progress; do not repeat a payment or wallet transaction.');
			if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'P2002') throw new ConflictException('This source output or wallet call is already reserved. Refresh saved progress before continuing.');
			throw cause;
		} finally { clearTimeout(timer); response.removeListener('close', close); this.running.delete(id); }
	}
	async get(id: string, principal: Principal) { this.auth.requireTbc(principal); return publicSettlement(await this.repository.owned(id, principal.id)); }
	open(id: string, principal: Principal, response: Response) {
		return this.job(id, principal, response, async (order, signal) => {
			if (order.settlement) return publicSettlement(order);
			if (order.status !== 'prepared' || !order.custody) throw new ConflictException('This order is closed or its custody record is missing.');
			await this.custody.assertRecoverable(order, order.custody);
			await this.asset.verify(signal, order.contractId);
			await this.deposits.assertAvailable(signal);
			await this.target.check(order.deployment, response); signal.throwIfAborted();
			await this.repository.open(order);
			return publicSettlement(await this.repository.owned(id, principal.id));
		});
	}
	private async recheck(order: SettlementOrder, txid: string, signal: AbortSignal) {
		if (!order.settlement || !order.custody) throw new ConflictException('Open payment details before attaching a deposit.');
		if (order.settlement.deposit && order.settlement.deposit.txid !== txid) throw new ConflictException('A different deposit is already saved. Reconcile it; do not send another payment.');
		if (order.settlement.status === 'completed' && await this.db.redemptionRelease.count({ where: { redemption: { orderId: order.id }, signed: { isNot: null } } })) throw new ConflictException('This reserve has a signed reverse release. Check its redemption progress; the forward mint remains completed. Do not pay or mint again.');
		await this.custody.assertRecoverable(order, order.custody);
		try {
			const observation = await this.deposits.verify(order, order.custody.address, txid, signal);
			await this.repository.observe(order, observation);
		} catch (cause) {
			const mismatch = cause instanceof UnprocessableEntityException;
			await this.repository.unavailable(order, mismatch ? cause.message : 'Deposit verification is unavailable. Previous records are retained. Do not pay again; refresh later.', mismatch);
			throw cause;
		}
		return this.repository.owned(order.id, order.identityId);
	}
	deposit(id: string, txid: string | undefined, principal: Principal, response: Response) {
		return this.job(id, principal, response, async (order, signal) => {
			const source = txid ?? order.settlement?.deposit?.txid;
			if (!source || !/^(?!0{64}$)[0-9a-f]{64}$/.test(source)) throw new BadRequestException('Paste the TBC transfer TXID from Turing Wallet.');
			return publicSettlement(await this.recheck(order, source, signal));
		});
	}
	private attempt(order: SettlementOrder, id: string) {
		const row = order.settlement?.attempts.find((item) => item.id === id);
		if (!row) throw new BadRequestException('Wallet call not found in this order.');
		return row;
	}
	quote(id: string, kind: BridgeCallKind | 'next', from: string, principal: Principal, response: Response) {
		return this.job(id, principal, response, async (order, signal) => {
			if (!isAddress(from, { strict: true })) throw new BadRequestException('Use a valid MetaMask role address.');
			if (!order.settlement?.deposit || order.settlement.status === 'completed' || order.settlement.status === 'needs_review') throw new ConflictException('A verified, unsettled deposit is required.');
			if (order.settlement.attempts.some((row) => activeCallStates.includes(row.status))) throw new ConflictException('Finish or reconcile the saved wallet call before requesting another quote.');
			order = await this.recheck(order, order.settlement.deposit.txid, signal);
			if (order.settlement!.status !== 'ready_to_mint') throw new ConflictException('Wait for the source confirmation threshold, then verify the deposit again.');
			const target = await this.target.check(order.deployment, response); signal.throwIfAborted();
			const nextKind = kind === 'next' ? target.paused ? 'unpause' : 'mint' : kind;
			const data = await this.calls.quote(order, nextKind, getAddress(from), response); signal.throwIfAborted();
			return publicAttempt(await this.repository.quote(order, data));
		});
	}
	begin(id: string, attemptId: string, principal: Principal, response: Response) {
		return this.job(id, principal, response, async (order, signal) => {
			const attempt = this.attempt(order, attemptId);
			if (attempt.status !== 'quoted' || attempt.expiresAt.getTime() <= Date.now()) throw new ConflictException('This quote has expired or already opened a wallet request. Refresh its history before continuing.');
			if (!order.settlement?.deposit) throw new ConflictException('No source deposit is saved.');
			order = await this.recheck(order, order.settlement.deposit.txid, signal);
			if (order.settlement!.status !== 'ready_to_mint') throw new ConflictException('Source verification must complete before sending a wallet call.');
			await this.target.check(order.deployment, response);
			await this.calls.quote(order, attempt.kind as BridgeCallKind, attempt.fromAddress as Address, response, attempt);
			signal.throwIfAborted();
			await this.repository.begin(order, attempt);
			return publicAttempt({ ...attempt, status: 'awaiting_wallet' });
		});
	}
	submit(id: string, attemptId: string, txHash: string, principal: Principal, response: Response) {
		return this.job(id, principal, response, async (order) => {
			const attempt = this.attempt(order, attemptId);
			if (attempt.txHash) { if (attempt.txHash !== txHash) throw new ConflictException('This call already has a different transaction hash.'); return publicAttempt(attempt); }
			if (attempt.status !== 'awaiting_wallet') throw new ConflictException('This call has not opened a wallet send slot.');
			return publicAttempt(await this.repository.submit(order, attempt, txHash));
		});
	}
	cancel(id: string, attemptId: string, rejected: boolean, principal: Principal, response: Response) {
		return this.job(id, principal, response, async (order) => {
			const row = this.attempt(order, attemptId);
			if (row.txHash || row.status !== 'quoted' && !(row.status === 'awaiting_wallet' && rejected)) throw new ConflictException('An uncertain wallet send must be recovered using its Activity hash. Do not send again.');
			await this.repository.cancel(order, row);
			return publicAttempt({ ...row, status: 'cancelled' });
		});
	}
	check(id: string, attemptId: string, principal: Principal, response: Response) {
		return this.job(id, principal, response, async (order, signal) => {
			const row = this.attempt(order, attemptId);
			if (row.kind === 'mint') {
				if (!order.settlement?.deposit) throw new ConflictException('No deposit is saved for this mint.');
				order = await this.recheck(order, order.settlement.deposit.txid, signal);
				if (order.settlement!.deposit!.confirmations < order.sourceConfirmationsRequired || order.settlement!.lastError) throw new ConflictException('The source deposit needs reconciliation before completing the mint.');
			}
			await this.target.check(order.deployment, response);
			const observation = await this.calls.receipt(order, row, response); signal.throwIfAborted();
			await this.repository.observeCall(order, row, observation);
			return publicSettlement(await this.repository.owned(id, principal.id));
		});
	}
}
