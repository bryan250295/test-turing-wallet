import { BadRequestException, ConflictException, GatewayTimeoutException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import tbc from 'tbc-lib-js';
import { isAddress, keccak256, parseAbi, stringToHex, type Address } from 'viem';
import type { Prisma, RedemptionEscrowDeployment } from '../../generated/prisma/client';
import type { RedemptionOrder, RedemptionOrderInput } from '../../../shared/src/types/learningBridge';
import { tokenAmountToRaw } from '../../../shared/src/utils/tokenAmounts';
import { AuthService, type Principal } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import { BridgeSettlementRepository, type SettlementOrder } from './bridge-settlement.repository';
import { BridgeCustodyService } from './bridge-custody.service';
import { BridgeDepositVerifier } from './bridge-deposit.verifier';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { withDeploymentRpc } from './bridge-deployment-verifier';

const policyVersion = 'permanent-escrow-preparation-v1' as const;
const escrowAbi = parseAbi(['function wrappedToken() view returns (address)', 'function owner() view returns (address)',
	'function pendingOwner() view returns (address)', 'function sourceContractId() view returns (bytes32)', 'function sourceDecimals() view returns (uint8)',
	'function TARGET_CHAIN_ID() view returns (uint256)', 'function paused() view returns (bool)', 'function totalLocked() view returns (uint256)']);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const include = { release: { select: { redemptionId: true } }, escrow: { select: { contractAddress: true, wrappedToken: true, sourceContractId: true, decimals: true } } } as const;
type PublicRow = Prisma.RedemptionOrderGetPayload<{ include: typeof include }>;
function publicRow(row: PublicRow): RedemptionOrder {
	return { id: row.id, orderId: row.orderId, escrowId: row.escrowId, idempotencyKey: row.idempotencyKey, redemptionId: row.redemptionId,
		chainId: 998, escrowAddress: row.escrowAddress, wrappedToken: row.escrow.wrappedToken, sourceContractId: row.escrow.sourceContractId,
		decimals: row.escrow.decimals, holder: row.holder, tbcRecipient: row.tbcRecipient, amountRaw: row.amountRaw.toFixed(0), termsHash: row.termsHash,
		policyVersion, status: row.status as RedemptionOrder['status'], evidence: row.evidence as unknown as RedemptionOrder['evidence'],
		createdAt: row.createdAt.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null, lockingEnabled: false, sourceReleaseEnabled: false, releaseStarted: !!row.release };
}
function retry(row: PublicRow, orderId: string, input: RedemptionOrderInput, amountRaw: string) {
	if (row.orderId !== orderId || row.escrowId !== input.escrowId || row.holder !== input.holder.toLowerCase() || row.tbcRecipient !== input.tbcRecipient || row.amountRaw.toFixed(0) !== amountRaw) throw new ConflictException('This request key already saved different redemption terms. Refresh saved redemptions.');
	return publicRow(row);
}

@Injectable()
export class RedemptionOrdersService {
	private readonly running = new Set<string>();
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeSettlementRepository) private readonly orders: BridgeSettlementRepository,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
		@Inject(BridgeDepositVerifier) private readonly deposits: BridgeDepositVerifier,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService) {}

	async list(orderId: string, principal: Principal) {
		this.auth.requireTbc(principal); await this.orders.owned(orderId, principal.id);
		const where = { orderId, identityId: principal.id };
		const pending = await this.db.redemptionOrder.findMany({ where: { ...where, status: 'prepared' }, include, orderBy: { createdAt: 'desc' }, take: 3 });
		const recent = await this.db.redemptionOrder.findMany({ where: { ...where, id: { notIn: pending.map((row) => row.id) } }, include, orderBy: { createdAt: 'desc' }, take: 20 - pending.length });
		return [...pending, ...recent].map(publicRow);
	}
	private completed(order: SettlementOrder) {
		const mint = order.settlement?.attempts.find((row) => row.kind === 'mint' && row.status === 'verified');
		if (order.settlement?.status !== 'completed' || !mint || mint.confirmations < order.destinationConfirmationsRequired || !order.custody || !order.settlement.deposit) throw new ConflictException('Complete and verify the forward order before preparing a redemption.');
	}
	async checkTarget(order: SettlementOrder, escrow: RedemptionEscrowDeployment, holder: string, response: Response) {
		if (escrow.status !== 'verified' || escrow.lastError || !escrow.verifiedAt || !escrow.contractAddress || !escrow.runtimeCodeHash || !escrow.receiptBlockHash || escrow.receiptBlockNumber === null || escrow.confirmations < 6
			|| escrow.wrappedToken !== order.destinationContract || escrow.sourceContractId !== order.contractId || escrow.decimals !== order.decimals) throw new ConflictException('Check escrow deployment status before preparing a redemption.');
		await this.target.check(order.deployment, response);
		return withDeploymentRpc(response, async (client) => {
			const address = escrow.contractAddress as Address;
			const [head, birth] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockNumber: escrow.receiptBlockNumber! })]);
			if (head.number === null || !head.hash || birth.hash !== escrow.receiptBlockHash || head.number < escrow.receiptBlockNumber! + 5n) throw new ConflictException('The escrow creation block changed. Recheck its deployment.');
			const read = <N extends typeof escrowAbi[number]['name']>(functionName: N) => client.readContract({ address, abi: escrowAbi, functionName, blockNumber: head.number! });
			const [code, token, owner, pending, source, decimals, chain, paused, locked, balance, escrowBalance] = await Promise.all([
				client.getCode({ address, blockNumber: head.number }), read('wrappedToken'), read('owner'), read('pendingOwner'), read('sourceContractId'), read('sourceDecimals'), read('TARGET_CHAIN_ID'), read('paused'), read('totalLocked'),
				client.readContract({ address: order.destinationContract as Address, abi: tokenAbi, functionName: 'balanceOf', args: [holder as Address], blockNumber: head.number }),
				client.readContract({ address: order.destinationContract as Address, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: head.number }),
			]);
			if (!code || keccak256(code) !== escrow.runtimeCodeHash || token.toLowerCase() !== order.destinationContract || owner.toLowerCase() !== escrow.deployer
				|| pending !== '0x0000000000000000000000000000000000000000' || source.toLowerCase() !== `0x${order.contractId}` || decimals !== order.decimals || chain !== 998n) throw new ConflictException('Current escrow code, owner or token binding differs from the verified deployment.');
			if (!paused || locked !== 0n || escrowBalance !== 0n) throw new ConflictException('This preparation stage requires an unused, paused escrow. Reconcile its current state before proceeding.');
			if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash || await client.getChainId() !== 998) throw new ConflictException('The target chain changed during preparation.');
			return { targetBlockHash: head.hash, targetBlockNumber: head.number.toString(), wrappedBalanceRaw: balance.toString() };
		});
	}
	async prepare(orderId: string, input: RedemptionOrderInput, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		let amount: bigint;
		const order = await this.orders.owned(orderId, principal.id);
		try { amount = tokenAmountToRaw(input.amount, order.decimals); } catch { throw new BadRequestException(`Enter a positive wrapped token amount with at most ${order.decimals} decimal places.`); }
		if (amount > BigInt(order.amountRaw.toFixed(0)) || amount > 18446744073709551615n) throw new BadRequestException('The redemption exceeds this forward order reserve.');
		if (!isAddress(input.holder, { strict: true }) || input.holder.toLowerCase() !== order.recipient.toLowerCase()) throw new BadRequestException('Use the original wrapped token receiving account. Transferred-token redemptions are not supported by this preparation stage.');
		try {
			const address = tbc.Address.fromString(input.tbcRecipient, 'livenet');
			if (address.type !== 'pubkeyhash' || address.toString() !== input.tbcRecipient || !input.tbcRecipient.startsWith('1')) throw new Error();
		} catch { throw new BadRequestException('Use a valid Base58Check TBC P2PKH receiving address.'); }
		if (input.tbcRecipient === order.custody?.address) throw new BadRequestException('The custody reserve cannot be the source token receiving address.');
		const existing = await this.db.redemptionOrder.findUnique({ where: { identityId_idempotencyKey: { identityId: principal.id, idempotencyKey: input.idempotencyKey } }, include });
		if (existing) return retry(existing, orderId, input, amount.toString());
		this.completed(order);
		if (this.running.has(principal.id) || this.running.size >= 4) throw new ConflictException('A redemption preparation is running. Wait, then refresh saved redemptions.');
		this.running.add(principal.id);
		const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 110_000); timer.unref();
		const close = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', close);
		try {
			const escrow = await this.db.redemptionEscrowDeployment.findFirst({ where: { id: input.escrowId, orderId, identityId: principal.id } });
			if (!escrow) throw new NotFoundException('Use the verified escrow saved under this completed order.');
			await this.custody.assertRecoverable(order, order.custody!);
			const reserve = await this.deposits.verify(order, order.custody!.address, order.settlement!.deposit!.txid, controller.signal);
			if (!reserve.blockHash || reserve.confirmations < order.sourceConfirmationsRequired || reserve.blockHash !== order.settlement!.deposit!.blockHash) throw new ConflictException('The source reserve or its confirmed block changed. Reconcile the forward order first.');
			const target = await this.checkTarget(order, escrow, input.holder.toLowerCase(), response);
			if (BigInt(target.wrappedBalanceRaw) < amount) throw new ConflictException('The wrapped token balance is insufficient for this redemption.');
			controller.signal.throwIfAborted();
			const evidence: RedemptionOrder['evidence'] = { reserveTxid: reserve.txid, reserveVout: reserve.vout, reserveAmountRaw: reserve.amountRaw,
				reserveBlockHash: reserve.blockHash, reserveConfirmations: reserve.confirmations, reserveCheckedAt: reserve.checkedAt.toISOString(),
				...target, escrowPaused: true, totalLockedRaw: '0', checkedAt: new Date().toISOString() };
			return await this.db.$transaction(async (tx) => {
				// One source reserve backs all partial preparations for this forward order.
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-reserve:${orderId}`}, 0))`;
				controller.signal.throwIfAborted();
				const prior = await tx.redemptionOrder.findUnique({ where: { identityId_idempotencyKey: { identityId: principal.id, idempotencyKey: input.idempotencyKey } }, include });
				if (prior) return retry(prior, orderId, input, amount.toString());
				const current = await tx.bridgeOrder.findUniqueOrThrow({ where: { id: orderId }, include: { settlement: { include: { deposit: true } } } });
				const currentEscrow = await tx.redemptionEscrowDeployment.findUniqueOrThrow({ where: { id: escrow.id } });
				if (current.settlement?.status !== 'completed' || current.settlement.deposit?.blockHash !== reserve.blockHash || currentEscrow.updatedAt.getTime() !== escrow.updatedAt.getTime()) throw new ConflictException('Order or escrow verification changed while preparing. Refresh first.');
				const reservations = await tx.redemptionOrder.aggregate({ where: { orderId, status: 'prepared' }, _sum: { amountRaw: true }, _count: true });
				if (reservations._count >= 3) throw new ConflictException('Close an unused redemption preparation before creating another. Maximum 3 open preparations.');
				const reserved = BigInt(reservations._sum.amountRaw?.toFixed(0) ?? '0');
				if (reserved + amount > BigInt(reserve.amountRaw) || reserved + amount > BigInt(target.wrappedBalanceRaw)) throw new ConflictException('Other preparations already reserve this amount. Close an unused preparation or reduce the amount.');
				const id = randomUUID(); const holder = input.holder.toLowerCase();
				const terms = JSON.stringify([policyVersion, id, principal.id, orderId, input.idempotencyKey, 998, escrow.id, escrow.contractAddress,
					order.destinationContract, order.contractId, order.decimals, holder, input.tbcRecipient, amount.toString(), reserve.txid, reserve.vout]);
				const termsHash = createHash('sha256').update(terms).digest('hex');
				const redemptionId = keccak256(stringToHex(terms));
				const row = await tx.redemptionOrder.create({ data: { id, orderId, identityId: principal.id, escrowId: escrow.id, escrowAddress: escrow.contractAddress!, idempotencyKey: input.idempotencyKey,
					redemptionId, holder, tbcRecipient: input.tbcRecipient, amountRaw: amount.toString(), termsHash, policyVersion, evidence: evidence as unknown as Prisma.InputJsonValue }, include });
				await tx.auditEvent.create({ data: { identityId: principal.id, action: 'bridge.redemption.prepared', data: { orderId, id, termsHash, redemptionId } } });
				return publicRow(row);
			}, { timeout: 10_000 });
		} catch (cause) {
			if (controller.signal.aborted) throw new GatewayTimeoutException('Redemption preparation was interrupted. Refresh saved redemptions before retrying.');
			throw cause;
		} finally { controller.abort(); clearTimeout(timer); response.removeListener('close', close); this.running.delete(principal.id); }
	}
	async cancel(orderId: string, id: string, principal: Principal) {
		this.auth.requireTbc(principal);
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-reserve:${orderId}`}, 0))`;
			const row = await tx.redemptionOrder.findFirst({ where: { id, orderId, identityId: principal.id }, include });
			if (!row) throw new NotFoundException('Redemption not found for this signed-in TBC identity.');
			if (row.status === 'cancelled') return publicRow(row);
			if (row.release) throw new ConflictException('Fee funding details were opened. Keep this preparation and reconcile any fee payment; it cannot be closed as unused.');
			if (row.status !== 'prepared') throw new ConflictException('Only an unused preparation can be closed.');
			const result = await tx.redemptionOrder.updateMany({ where: { id, status: 'prepared', cancelledAt: null }, data: { status: 'cancelled', cancelledAt: new Date() } });
			if (result.count !== 1) throw new ConflictException('The redemption state changed. Refresh it first.');
			await tx.auditEvent.create({ data: { identityId: principal.id, action: 'bridge.redemption.cancelled', data: { orderId, id } } });
			return publicRow(await tx.redemptionOrder.findUniqueOrThrow({ where: { id }, include }));
		});
	}
}
