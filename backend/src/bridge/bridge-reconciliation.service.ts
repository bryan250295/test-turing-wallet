import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { BridgeReconciliation, ReconciliationRoute, ReconciliationTransaction as Transaction } from '../../../shared/src/types/bridgeReconciliation';
import { AuthService, type Principal } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import { wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';

// Explicit selects: no key material, calldata, unsigned/signed raw or proof enters this report.
const callSelect = { id: true, kind: true, status: true, txHash: true, confirmations: true, actualFeeWei: true, updatedAt: true } as const;
const select = {
	id: true, deploymentId: true, status: true, amountRaw: true, recipient: true, createdAt: true,
	destinationContract: true, contractId: true, decimals: true, symbol: true,
	sourceConfirmationsRequired: true, destinationConfirmationsRequired: true,
	settlement: { select: { status: true, checkedAt: true, lastError: true,
		deposit: { select: { txid: true, vout: true, amountRaw: true, feeRaw: true, confirmations: true, blockHash: true, checkedAt: true } },
		attempts: { select: callSelect, orderBy: { createdAt: 'asc' }, take: 201 },
	} },
	redemptionOrders: { select: { id: true, createdAt: true, status: true, amountRaw: true, tbcRecipient: true, escrowAddress: true,
		release: { select: { status: true, lastError: true, checkedAt: true,
			plan: { select: { fundingTxid: true, fundingValueRaw: true, feeRaw: true, reserveTxid: true, reserveVout: true, createdAt: true } },
			lock: { select: { txHash: true, confirmations: true, checkedAt: true } },
			signed: { select: { txid: true, feeRaw: true, confirmations: true, blockHash: true } },
			walletCalls: { select: callSelect, orderBy: { createdAt: 'asc' }, take: 201 },
		} },
	}, orderBy: { createdAt: 'asc' }, take: 201 },
} satisfies Prisma.BridgeOrderSelect;
type Order = Prisma.BridgeOrderGetPayload<{ select: typeof select }>;
type Call = { id: string; kind: string; status: string; txHash: string | null; confirmations: number; actualFeeWei: { toFixed: (digits: number) => string } | null; updatedAt: Date };
function callTransaction(call: Call, prefix: string, required: number): Transaction {
	const labels: Record<string, string> = { mint: 'Mint wrapped token', unpause: `${prefix} unpause`, approve: 'Approve exact wrapped token', reset: 'Clear allowance', lock: 'Permanently lock wrapped token' };
	return { id: call.id, label: labels[call.kind] ?? call.kind, network: 'hyperevm', hash: call.txHash, status: call.status,
		confirmations: call.confirmations, required, actualFeeRaw: call.txHash ? call.actualFeeWei?.toFixed(0) ?? null : null, checkedAt: call.updatedAt.toISOString() };
}
function sourceTransaction(id: string, label: string, hash: string, status: string, confirmations: number | null, required: number, fee: string | null, checkedAt: Date | null): Transaction {
	return { id, label, network: 'tbc', hash, status, confirmations, required, actualFeeRaw: fee, checkedAt: checkedAt?.toISOString() ?? null };
}
function limited(values: unknown[]) { if (values.length > 200) throw new ConflictException('This reconciliation exceeds the 200-record report limit. No partial totals are displayed.'); }

@Injectable()
export class BridgeReconciliationService {
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService) {}
	async report(principal: Principal): Promise<BridgeReconciliation> {
		this.auth.requireTbc(principal);
		return this.db.$transaction(async (tx) => {
			// Bound the whole report before fetching nested collections. Never report partial totals.
			const counts = await Promise.all([
				tx.bridgeOrder.count({ where: { identityId: principal.id } }),
				tx.bridgeCallAttempt.count({ where: { settlement: { order: { identityId: principal.id } } } }),
				tx.redemptionOrder.count({ where: { identityId: principal.id } }),
				tx.redemptionWalletCall.count({ where: { release: { redemption: { identityId: principal.id } } } }),
			]);
			if (counts.some((count) => count > 200)) throw new ConflictException('This reconciliation exceeds the 200-record limit for a record category. No partial totals are displayed.');
			const orders = await tx.bridgeOrder.findMany({ where: { identityId: principal.id }, select, orderBy: { createdAt: 'desc' }, take: 201 });
			limited(orders);
			const ids = [...new Set(orders.map((order) => order.deploymentId))];
			const deployments = await tx.bridgeDeployment.findMany({ where: { id: { in: ids }, identityId: principal.id }, select: {
				id: true, quote: true, contractAddress: true, txHash: true, status: true, confirmations: true, actualFeeWei: true, checkedAt: true, lastError: true,
			} });
			const escrows = await tx.redemptionEscrowDeployment.findMany({ where: { identityId: principal.id, deploymentId: { in: ids } }, select: {
				id: true, deploymentId: true, txHash: true, status: true, confirmations: true, actualFeeWei: true, checkedAt: true,
			}, take: 201 });
			limited(escrows);
			const routes: ReconciliationRoute[] = [];
			for (const deployment of deployments) {
				const group = orders.filter((order) => order.deploymentId === deployment.id);
				const first = group[0];
				if (!first) continue;
				const setup: Transaction[] = [{ id: deployment.id, label: 'Deploy wrapped token', network: 'hyperevm', hash: deployment.txHash,
					status: deployment.status, confirmations: deployment.confirmations, required: 6, actualFeeRaw: deployment.actualFeeWei?.toFixed(0) ?? null, checkedAt: deployment.checkedAt?.toISOString() ?? null },
					...escrows.filter((escrow) => escrow.deploymentId === deployment.id).map((escrow): Transaction => ({ id: escrow.id, label: 'Deploy redemption escrow', network: 'hyperevm', hash: escrow.txHash,
						status: escrow.status, confirmations: escrow.confirmations, required: 6, actualFeeRaw: escrow.actualFeeWei?.toFixed(0) ?? null, checkedAt: escrow.checkedAt?.toISOString() ?? null }))];
				routes.push({ ...this.route(group, setup, deployment.status !== 'verified' || !!deployment.lastError), ...wrappedMetadata(deployment.quote) });
			}
			if (deployments.length !== ids.length) throw new NotFoundException('A deployment record is missing from this wallet report.');
			return { identityAddress: principal.address, generatedAt: new Date().toISOString(), basis: 'saved_verification', routes };
		}, { isolationLevel: 'RepeatableRead', timeout: 15_000 });
	}
	private route(rows: Order[], setupTransactions: Transaction[], deploymentIssue: boolean): Omit<ReconciliationRoute, 'wrappedName' | 'wrappedSymbol'> {
		const first = rows[0];
		const issues = new Set<string>();
		if (deploymentIssue) issues.add('The wrapped deployment needs review.');
		let deposited = 0n, minted = 0n, locked = 0n, returned = 0n, pending = false;
		const orders = rows.map((row) => {
			const settlement = row.settlement;
			const deposit = settlement?.deposit;
			const amount = BigInt(row.amountRaw.toFixed(0));
			if (row.contractId !== first.contractId || row.decimals !== first.decimals || row.destinationContract !== first.destinationContract) issues.add('Asset bindings differ within this route.');
			limited(row.redemptionOrders); limited(settlement?.attempts ?? []);
			const depositVerified = !!deposit?.blockHash && deposit.confirmations >= row.sourceConfirmationsRequired && deposit.amountRaw.toFixed(0) === amount.toString();
			if (depositVerified) deposited += amount;
			const mints = (settlement?.attempts ?? []).filter((attempt) => attempt.kind === 'mint' && attempt.status === 'verified' && attempt.txHash && attempt.confirmations >= row.destinationConfirmationsRequired);
			minted += amount * BigInt(new Set(mints.map((mint) => mint.txHash)).size);
			if (mints.length > 1 || mints.length && !depositVerified) issues.add('Mint and deposit evidence need review.');
			if (settlement?.status === 'needs_review' || settlement?.lastError) issues.add('A forward order has a saved verification error.');
			if (row.status !== 'cancelled' && settlement?.status !== 'completed') pending = true;
			const transactions = deposit ? [sourceTransaction(`${row.id}:deposit`, 'source token deposit', deposit.txid,
				depositVerified ? 'verified' : 'confirming', deposit.confirmations, row.sourceConfirmationsRequired, deposit.feeRaw.toFixed(0), deposit.checkedAt)] : [];
			transactions.push(...(settlement?.attempts ?? []).map((call) => callTransaction(call, 'Token', row.destinationConfirmationsRequired)));
			const redemptions = row.redemptionOrders.map((redemption) => {
				const release = redemption.release, plan = release?.plan, savedLock = release?.lock, signed = release?.signed;
				limited(release?.walletCalls ?? []);
				const raw = BigInt(redemption.amountRaw.toFixed(0));
				const lockVerified = !!savedLock && savedLock.confirmations >= row.destinationConfirmationsRequired;
				if (lockVerified) locked += raw;
				const completed = release?.status === 'completed' && !!signed?.blockHash && signed.confirmations >= row.sourceConfirmationsRequired && lockVerified
					&& plan?.reserveTxid === deposit?.txid && plan?.reserveVout === deposit?.vout && raw === amount;
				if (completed) returned += raw;
				if (release?.status === 'completed' && !completed) issues.add('A completed return is missing matching confirmation or reserve evidence.');
				if (release?.status === 'needs_review' || release?.lastError) issues.add('A redemption has a saved verification error.');
				if (redemption.status !== 'cancelled' && !completed) pending = true;
				const calls = (release?.walletCalls ?? []).map((call) => callTransaction(call, 'Escrow', row.destinationConfirmationsRequired));
				// The lock can also be attached by hash, so show it even without a wallet-call row.
				if (savedLock && !calls.some((call) => call.hash === savedLock.txHash)) calls.push({ id: `${redemption.id}:lock`, label: 'Permanently lock wrapped token', network: 'hyperevm', hash: savedLock.txHash,
					status: lockVerified ? 'verified' : 'confirming', confirmations: savedLock.confirmations, required: row.destinationConfirmationsRequired, actualFeeRaw: null, checkedAt: savedLock.checkedAt.toISOString() });
				if (plan) calls.unshift(sourceTransaction(`${redemption.id}:funding`, 'Native TBC fee funding', plan.fundingTxid, 'verified when plan saved', null, row.sourceConfirmationsRequired, null, plan.createdAt));
				if (signed) calls.push(sourceTransaction(`${redemption.id}:return`, 'source token return', signed.txid, release!.status, signed.confirmations,
					row.sourceConfirmationsRequired, signed.blockHash && signed.confirmations > 0 ? signed.feeRaw.toString() : null, release!.checkedAt));
				return { id: redemption.id, createdAt: redemption.createdAt.toISOString(), checkedAt: release?.checkedAt?.toISOString() ?? null, amountRaw: raw.toString(), recipient: redemption.tbcRecipient, escrowAddress: redemption.escrowAddress,
					status: redemption.status === 'cancelled' ? 'cancelled' : release?.status ?? 'prepared', fundingRaw: plan?.fundingValueRaw.toString() ?? null,
					plannedReleaseFeeRaw: plan?.feeRaw.toString() ?? null, plannedNativeChangeRaw: plan ? (plan.fundingValueRaw - plan.feeRaw).toString() : null, transactions: calls };
			});
			return { id: row.id, amountRaw: amount.toString(), recipient: row.recipient, createdAt: row.createdAt.toISOString(),
				status: row.status === 'cancelled' ? 'cancelled' : settlement?.status ?? 'prepared', checkedAt: settlement?.checkedAt?.toISOString() ?? null, transactions, redemptions };
		});
		const reserve = deposited - returned, circulating = minted - locked, difference = reserve - circulating;
		if (reserve < 0n || circulating < 0n) issues.add('Recorded returns or locks exceed recorded deposits or mints.');
		if (!pending && difference !== 0n) issues.add('Recorded source token reserves and circulating wrapped token differ.');
		let tbc = 0n, hype = 0n;
		const fees = new Map<string, string>();
		for (const item of [...setupTransactions, ...orders.flatMap((order) => [...order.transactions, ...order.redemptions.flatMap((redemption) => redemption.transactions)])]) {
			if (!item.hash || item.actualFeeRaw === null) continue;
			const key = `${item.network}:${item.hash.toLowerCase()}`;
			if (fees.has(key)) { if (fees.get(key) !== item.actualFeeRaw) issues.add('The same transaction has inconsistent saved fees.'); continue; }
			fees.set(key, item.actualFeeRaw);
			if (item.network === 'tbc') tbc += BigInt(item.actualFeeRaw); else hype += BigInt(item.actualFeeRaw);
		}
		return { deploymentId: first.deploymentId, wrappedToken: first.destinationContract, contractId: first.contractId, decimals: first.decimals, symbol: first.symbol,
			status: issues.size ? 'needs_review' : pending ? 'pending' : deposited === 0n && minted === 0n ? 'empty' : 'balanced', issues: [...issues],
			totals: { depositedRaw: deposited.toString(), mintedRaw: minted.toString(), lockedRaw: locked.toString(), returnedRaw: returned.toString(),
				reserveRaw: reserve.toString(), circulatingRaw: circulating.toString(), differenceRaw: difference.toString(), tbcFeesRaw: tbc.toString(), hypeFeesWei: hype.toString() }, setupTransactions, orders };
	}
}
