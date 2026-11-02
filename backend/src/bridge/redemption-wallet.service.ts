import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { encodeFunctionData, isAddress, keccak256, parseAbi, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { AuthService, type Principal } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import type { Prisma, RedemptionWalletCall as Row } from '../../generated/prisma/client';
import type { RedemptionWalletCall, RedemptionWalletKind, RedemptionWalletState } from '../../../shared/src/types/learningBridge';
import { withDeploymentRpc } from './bridge-deployment-verifier';
import { RedemptionReleaseService } from './redemption-release.service';
import { RedemptionLockVerifier } from './redemption-lock.verifier';
import { assertEscrowSenderIdle } from './redemption-escrow.repository';

const abi = parseAbi(['function unpause()', 'function paused() view returns (bool)', 'function owner() view returns (address)',
	'function pendingOwner() view returns (address)', 'function wrappedToken() view returns (address)', 'function sourceContractId() view returns (bytes32)',
	'function sourceDecimals() view returns (uint8)', 'function TARGET_CHAIN_ID() view returns (uint256)', 'function totalLocked() view returns (uint256)',
	'function processedRedemptions(bytes32) view returns (bool)', 'function lockForRedemption(bytes32 redemptionId,string tbcRecipient,uint256 amountRaw)']);
const tokenAbi = parseAbi(['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const active = ['quoted', 'awaiting_wallet', 'submitted', 'confirming'];
const include = { escrow: true, release: { include: { plan: true, signed: true, lock: true } } } as const;
type Redemption = Prisma.RedemptionOrderGetPayload<{ include: typeof include }>;
export function redemptionCallData(row: Redemption, kind: RedemptionWalletKind) {
	if (kind === 'unpause') return encodeFunctionData({ abi, functionName: 'unpause' });
	if (kind === 'lock') return encodeFunctionData({ abi, functionName: 'lockForRedemption', args: [row.redemptionId as Hex, row.tbcRecipient, BigInt(row.amountRaw.toFixed(0))] });
	return encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [row.escrowAddress as Address, kind === 'reset' ? 0n : BigInt(row.amountRaw.toFixed(0))] });
}
function callView(row: Row): RedemptionWalletCall {
	return { id: row.id, redemptionId: row.redemptionId, kind: row.kind as RedemptionWalletKind, status: row.status as RedemptionWalletCall['status'],
		transaction: { from: row.fromAddress, to: row.toAddress, chainId: '0x3e6', value: '0x0', data: row.data, nonce: `0x${row.nonce.toString(16)}`, gas: `0x${row.gasLimit.toString(16)}`, gasPrice: `0x${BigInt(row.gasPriceWei.toFixed(0)).toString(16)}` },
		estimatedFeeWei: row.estimatedFeeWei.toFixed(0), budgetWei: row.budgetWei.toFixed(0), expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
		txHash: row.txHash, confirmations: row.confirmations, actualFeeWei: row.actualFeeWei?.toFixed(0) ?? null, lastError: row.lastError };
}
@Injectable()
export class RedemptionWalletService {
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService,
		@Inject(RedemptionReleaseService) private readonly releases: RedemptionReleaseService, @Inject(RedemptionLockVerifier) private readonly locks: RedemptionLockVerifier) {}
	private async owned(orderId: string, id: string, principal: Principal) {
		this.auth.requireTbc(principal);
		const row = await this.db.redemptionOrder.findFirst({ where: { id, orderId, identityId: principal.id }, include });
		if (!row) throw new NotFoundException('Redemption not found for this signed-in TBC identity.');
		return row;
	}
	private async attempt(row: Redemption, callId: string) {
		const call = await this.db.redemptionWalletCall.findFirst({ where: { id: callId, redemptionId: row.id } });
		if (!call) throw new NotFoundException('Wallet request not found for this redemption.');
		return call;
	}
	async list(orderId: string, id: string, principal: Principal) {
		await this.owned(orderId, id, principal);
		const pending = await this.db.redemptionWalletCall.findMany({ where: { redemptionId: id, status: { in: active } }, orderBy: { createdAt: 'desc' }, take: 4 });
		const recent = await this.db.redemptionWalletCall.findMany({ where: { redemptionId: id, id: { notIn: pending.map((r) => r.id) } }, orderBy: { createdAt: 'desc' }, take: 20 - pending.length });
		return [...pending, ...recent].map(callView);
	}
	private async target(row: Redemption, response: Response) {
		const escrow = row.escrow;
		if (escrow.status !== 'verified' || escrow.lastError || !escrow.runtimeCodeHash || escrow.contractAddress !== row.escrowAddress || !escrow.receiptBlockHash || escrow.receiptBlockNumber === null) throw new ConflictException('Check the saved escrow deployment before continuing.');
		return withDeploymentRpc(response, async (client) => {
			const address = row.escrowAddress as Address; const token = escrow.wrappedToken as Address;
			const [head, birth] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockNumber: escrow.receiptBlockNumber! })]);
			if (head.number === null || !head.hash || birth.hash !== escrow.receiptBlockHash || head.number < escrow.receiptBlockNumber! + 5n) throw new ConflictException('The escrow creation block changed. Recheck its deployment.');
			const read = <N extends 'paused' | 'owner' | 'pendingOwner' | 'wrappedToken' | 'sourceContractId' | 'sourceDecimals' | 'TARGET_CHAIN_ID' | 'totalLocked'>(functionName: N) => client.readContract({ address, abi, functionName, blockNumber: head.number! });
			const [code, owner, pending, boundToken, source, decimals, chain, paused, locked, processed, allowance, balance, escrowBalance, tokenCode] = await Promise.all([
				client.getCode({ address, blockNumber: head.number }), read('owner'), read('pendingOwner'), read('wrappedToken'), read('sourceContractId'), read('sourceDecimals'), read('TARGET_CHAIN_ID'), read('paused'), read('totalLocked'),
				client.readContract({ address, abi, functionName: 'processedRedemptions', args: [row.redemptionId as Hex], blockNumber: head.number }),
				client.readContract({ address: token, abi: tokenAbi, functionName: 'allowance', args: [row.holder as Address, address], blockNumber: head.number }),
				client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [row.holder as Address], blockNumber: head.number }),
				client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: head.number }), client.getCode({ address: token, blockNumber: head.number }),
			]);
			const original = await this.db.bridgeOrder.findUniqueOrThrow({ where: { id: row.orderId }, include: { deployment: true } });
			if (!code || keccak256(code) !== escrow.runtimeCodeHash || !tokenCode || keccak256(tokenCode) !== original.deployment.runtimeCodeHash
				|| owner.toLowerCase() !== escrow.deployer || pending !== '0x0000000000000000000000000000000000000000' || boundToken.toLowerCase() !== escrow.wrappedToken
				|| source.toLowerCase() !== `0x${escrow.sourceContractId}` || decimals !== escrow.decimals || chain !== 998n) throw new ConflictException('The escrow or wrapped-token code, owner or source binding changed.');
			if (processed || locked !== 0n || escrowBalance !== 0n) throw new ConflictException('The escrow already holds a lock. Recover its transaction hash before requesting another wallet transaction.');
			if (balance < BigInt(row.amountRaw.toFixed(0))) throw new ConflictException('The original receiving account has insufficient wrapped token.');
			if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash || await client.getChainId() !== 998) throw new ConflictException('The target chain changed during the wallet check.');
			const nextKind: RedemptionWalletKind = paused ? 'unpause' : allowance === BigInt(row.amountRaw.toFixed(0)) ? 'lock' : allowance > 0n ? 'reset' : 'approve';
			return { redemptionId: row.id, paused, allowanceRaw: allowance.toString(), balanceRaw: balance.toString(), nextKind,
				from: nextKind === 'unpause' ? escrow.deployer : row.holder, blockNumber: head.number.toString(), blockHash: head.hash } satisfies RedemptionWalletState;
		});
	}
	async state(orderId: string, id: string, principal: Principal, response: Response) {
		return this.target(await this.releases.walletPreflight(orderId, id, principal, response), response);
	}
	private async quoteData(row: Redemption, kind: RedemptionWalletKind, from: string, response: Response, previous?: Row) {
		const state = await this.target(row, response);
		if (kind !== state.nextKind) throw new ConflictException(`The next required wallet step is ${state.nextKind}. Check the next step and prepare it.`);
		if (!isAddress(from, { strict: true }) || from.toLowerCase() !== state.from) throw new BadRequestException(`Select ${state.from} in MetaMask for this step.`);
		return withDeploymentRpc(response, async (client) => {
			const account = state.from as Address; const to = (kind === 'approve' || kind === 'reset' ? row.escrow.wrappedToken : row.escrowAddress) as Address;
			const data = redemptionCallData(row, kind);
			const [head, nonce, price, balance, code] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getTransactionCount({ address: account, blockTag: 'pending' }), client.getGasPrice(), client.getBalance({ address: account }), client.getCode({ address: account })]);
			if (head.number === null || !head.hash || code && code !== '0x' || !Number.isSafeInteger(nonce) || nonce < 0 || price <= 0n) throw new ConflictException('Use a funded ordinary MetaMask account on Testnet 998.');
			const estimate = await client.estimateGas({ account, to, data, value: 0n, blockNumber: head.number, prepare: false }); const gas = (estimate * 120n + 99n) / 100n;
			if (estimate <= 0n || gas > head.gasLimit || balance < gas * price) throw new ConflictException('Insufficient HYPE for the estimated wallet transaction budget.');
			if (previous && (previous.nonce !== BigInt(nonce) || previous.data !== data || previous.fromAddress !== account || previous.toAddress !== to || previous.gasLimit < estimate || BigInt(previous.gasPriceWei.toFixed(0)) < price || balance < BigInt(previous.budgetWei.toFixed(0)))) throw new ConflictException('Nonce, fees or wallet terms changed. Discard the unused quote and prepare again.');
			if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash || await client.getChainId() !== 998) throw new ConflictException('The target chain changed during fee estimation.');
			return { redemptionId: row.id, kind, fromAddress: account.toLowerCase(), toAddress: to.toLowerCase(), data, nonce: BigInt(nonce), gasLimit: gas,
				gasPriceWei: price.toString(), estimatedFeeWei: (estimate * price).toString(), budgetWei: (gas * price).toString(), expiresAt: new Date(Date.now() + 60_000) };
		});
	}
	private async senderIdle(tx: Prisma.TransactionClient, from: string, exceptId?: string) {
		await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-evm-sender:${from}`}, 0))`;
		await assertEscrowSenderIdle(tx, from, exceptId);
		if (await tx.bridgeDeployment.count({ where: { deployer: { equals: from, mode: 'insensitive' }, status: { in: ['prepared', 'awaiting_wallet', 'submitted', 'confirming'] } } }) || await tx.bridgeCallAttempt.count({ where: { fromAddress: from, status: { in: active } } })) throw new ConflictException('Finish or reconcile the other active MetaMask transaction first.');
	}
	async quote(orderId: string, id: string, kind: RedemptionWalletKind, from: string, principal: Principal, response: Response) {
		const row = await this.releases.walletPreflight(orderId, id, principal, response);
		const data = await this.quoteData(row, kind, from, response);
		return this.db.$transaction(async (tx) => {
			await this.senderIdle(tx, data.fromAddress);
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`redemption-wallet:${id}`}, 0))`;
			if (await tx.redemptionWalletCall.count({ where: { redemptionId: id, status: { in: active } } })) throw new ConflictException('Finish or reconcile the saved redemption wallet request first.');
			const current = await tx.redemptionRelease.findUniqueOrThrow({ where: { redemptionId: id } });
			if (current.status !== 'funded' || current.updatedAt.getTime() !== row.release!.updatedAt.getTime()) throw new ConflictException('The release plan changed. Refresh it first.');
			const saved = await tx.redemptionWalletCall.create({ data });
			await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.redemption.wallet_quoted', data: { id, callId: saved.id, kind } } });
			return callView(saved);
		});
	}
	async begin(orderId: string, id: string, callId: string, principal: Principal, response: Response) {
		const row = await this.releases.walletPreflight(orderId, id, principal, response); const call = await this.attempt(row, callId);
		if (call.status !== 'quoted' || call.expiresAt.getTime() <= Date.now()) throw new ConflictException('This wallet quote expired or was already used. Refresh saved requests.');
		await this.quoteData(row, call.kind as RedemptionWalletKind, call.fromAddress, response, call);
		await this.db.$transaction(async (tx) => {
			await this.senderIdle(tx, call.fromAddress, call.id);
			const changed = await tx.redemptionWalletCall.updateMany({ where: { id: call.id, status: 'quoted', updatedAt: call.updatedAt, expiresAt: { gt: new Date() } }, data: { status: 'awaiting_wallet', lastError: null } });
			if (changed.count !== 1) throw new ConflictException('This quote changed or expired before opening MetaMask.');
			await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.redemption.wallet_requested', data: { id, callId } } });
		});
		return callView(await this.attempt(row, callId));
	}
	async submit(orderId: string, id: string, callId: string, txHash: string, principal: Principal) {
		const row = await this.owned(orderId, id, principal); const call = await this.attempt(row, callId);
		if (call.txHash) { if (call.txHash !== txHash) throw new ConflictException('A different transaction is already saved.'); return callView(call); }
		if (call.status !== 'awaiting_wallet') throw new ConflictException('No wallet send slot was reserved for this request.');
		const saved = await this.db.redemptionWalletCall.updateMany({ where: { id: call.id, status: 'awaiting_wallet', txHash: null, updatedAt: call.updatedAt }, data: { txHash, status: 'submitted', lastError: null } });
		if (saved.count !== 1) throw new ConflictException('This wallet request changed. Refresh saved requests.');
		return callView(await this.attempt(row, callId));
	}
	async cancel(orderId: string, id: string, callId: string, notSent: boolean, principal: Principal) {
		const row = await this.owned(orderId, id, principal); const call = await this.attempt(row, callId);
		if (call.txHash || call.status !== 'quoted' && !(call.status === 'awaiting_wallet' && notSent)) throw new ConflictException('Recover the existing Activity hash before retrying an uncertain transaction.');
		const saved = await this.db.redemptionWalletCall.updateMany({ where: { id: call.id, status: call.status, txHash: null, updatedAt: call.updatedAt }, data: { status: 'cancelled' } });
		if (saved.count !== 1) throw new ConflictException('The saved request changed. Refresh first.');
		return callView(await this.attempt(row, callId));
	}
	async check(orderId: string, id: string, callId: string, principal: Principal, response: Response) {
		const row = await this.owned(orderId, id, principal); const call = await this.attempt(row, callId);
		if (!call.txHash) throw new ConflictException('Save the transaction hash from MetaMask Activity first.');
		const observation = await withDeploymentRpc(response, async (client): Promise<Prisma.RedemptionWalletCallUpdateManyMutationInput> => {
			const reset = { status: 'submitted', confirmations: 0, receiptBlockHash: null, receiptBlockNumber: null, actualFeeWei: null, lastError: null };
			let tx; let receipt;
			try { [tx, receipt] = await Promise.all([client.getTransaction({ hash: call.txHash as Hex }), client.getTransactionReceipt({ hash: call.txHash as Hex })]); }
			catch (cause) { if (cause instanceof TransactionNotFoundError || cause instanceof TransactionReceiptNotFoundError) return { ...reset, lastError: 'Waiting for this saved transaction receipt. Check Activity; do not send again.' }; throw cause; }
			const chain = tx.chainId ?? (tx.v >= 35n ? Number((tx.v - 35n) / 2n) : 0);
			if (chain !== 998 || tx.hash.toLowerCase() !== call.txHash || tx.from.toLowerCase() !== call.fromAddress || tx.to?.toLowerCase() !== call.toAddress || tx.value !== 0n || BigInt(tx.nonce) !== call.nonce || tx.input.toLowerCase() !== call.data || call.data !== redemptionCallData(row, call.kind as RedemptionWalletKind)) return { ...reset, status: 'invalid', lastError: 'The wallet transaction differs from the reviewed sender, nonce, contract or call data.' };
			const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
			if (block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || head < receipt.blockNumber) return { ...reset, status: 'confirming', lastError: 'Waiting for a canonical receipt.' };
			const fee = receipt.gasUsed * receipt.effectiveGasPrice;
			const observed = { ...reset, confirmations: Number(head - receipt.blockNumber + 1n), receiptBlockHash: receipt.blockHash, receiptBlockNumber: receipt.blockNumber, actualFeeWei: fee.toString() };
			if (receipt.status !== 'success') return { ...observed, status: 'reverted', lastError: 'The wallet transaction reverted. Gas was charged; no successful action was verified.' };
			if (observed.confirmations < 6) return { ...observed, status: 'confirming' };
			if (receipt.transactionHash.toLowerCase() !== call.txHash || receipt.from.toLowerCase() !== call.fromAddress || receipt.to?.toLowerCase() !== call.toAddress || fee > BigInt(call.budgetWei.toFixed(0))) return { ...observed, status: 'invalid', lastError: 'The receipt differs from the reviewed sender, contract or HYPE budget. Reconcile the existing transaction.' };
			const code = await client.getCode({ address: row.escrowAddress as Address, blockNumber: receipt.blockNumber });
			if (!code || keccak256(code) !== row.escrow.runtimeCodeHash) throw new ConflictException('Escrow receipt-block runtime mismatch.');
			if (call.kind === 'unpause') {
				if (await client.readContract({ address: row.escrowAddress as Address, abi, functionName: 'paused', blockNumber: receipt.blockNumber })) throw new ConflictException('Escrow was not unpaused at the receipt block.');
			} else if (call.kind !== 'lock') {
				const allowance = await client.readContract({ address: row.escrow.wrappedToken as Address, abi: tokenAbi, functionName: 'allowance', args: [row.holder as Address, row.escrowAddress as Address], blockNumber: receipt.blockNumber });
				if (allowance !== (call.kind === 'reset' ? 0n : BigInt(row.amountRaw.toFixed(0)))) throw new ConflictException('The receipt-block allowance differs from the exact reviewed amount.');
			}
			if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash || await client.getChainId() !== 998) return { ...reset, status: 'confirming', lastError: 'The receipt block changed during verification.' };
			return { ...observed, status: 'verified' };
		});
		if (observation.status === 'verified' && call.kind === 'lock') {
			await this.locks.verify(row, row.escrow, call.txHash, response);
			if (!row.release?.signed) await this.releases.attachLock(orderId, id, call.txHash, principal, response);
		}
		await this.db.redemptionWalletCall.updateMany({ where: { id: call.id, updatedAt: call.updatedAt, txHash: call.txHash }, data: observation });
		return callView(await this.attempt(row, callId));
	}
}
