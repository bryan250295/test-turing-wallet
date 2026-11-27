import { BadRequestException, ConflictException, GatewayTimeoutException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import tbc from 'tbc-lib-js';
import { decodeEventLog, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import type { Prisma, SepoliaBurnCall, SepoliaBurnRedemption } from '../../generated/prisma/client';
import type { SepoliaBurnCall as PublicCall, SepoliaBurnRedemption as PublicRedemption } from '../../../shared/src/types/learningBridge';
import { API_URLS } from '../../../shared/src/config/constants';
import { AuthService, type Principal } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import { BridgeSettlementRepository, type SettlementOrder } from './bridge-settlement.repository';
import { BridgeCustodyService } from './bridge-custody.service';
import { BridgeDepositVerifier } from './bridge-deposit.verifier';
import { RedemptionReleaseEngine, type ReleaseInput, type ReleaseMaterial } from './redemption-release.engine';
import { SepoliaNativeReleaseEngine, type NativeReleaseInput, type NativeReleasePlan } from './sepolia-native-release.engine';
import { ETHEREUM_SEPOLIA_CHAIN_ID, withSepoliaRpc } from './ethereum-sepolia-rpc';
import { NATIVE_TBC_SOURCE_ID } from './ethereum-sepolia-route.service';
import { BridgeProgressService } from './bridge-progress.service';
import { matchesFrozenBurnEnvelope } from './sepolia-burn-transaction.verifier';

const abi = parseAbi([
	'function paused() view returns (bool)',
	'function balanceOf(address) view returns (uint256)',
	'function processedRedemptions(bytes32) view returns (bool)',
	'function burnForRedemption(bytes32 redemptionId,string tbcRecipient,uint256 amountRaw)',
	'event RedemptionBurned(bytes32 indexed redemptionId,address indexed holder,bytes32 indexed recipientHash,bytes32 sourceAssetId,uint8 sourceAssetKind,string tbcRecipient,uint256 amountRaw)',
]);
const activeCallStates = ['quoted', 'awaiting_wallet', 'submitted', 'confirming'];
const include = { calls: { orderBy: { createdAt: 'desc' as const }, take: 20 } } as const;
type Row = Prisma.SepoliaBurnRedemptionGetPayload<{ include: typeof include }>;

function callView(row: SepoliaBurnCall): PublicCall {
	return { id: row.id, status: row.status as PublicCall['status'], transaction: {
		from: row.fromAddress, to: row.toAddress, chainId: '0xaa36a7', value: '0x0', data: row.data,
		nonce: `0x${row.nonce.toString(16)}`, gas: `0x${row.gasLimit.toString(16)}`, gasPrice: `0x${BigInt(row.gasPriceWei.toFixed(0)).toString(16)}`,
	}, estimatedFeeWei: row.estimatedFeeWei.toFixed(0), budgetWei: row.budgetWei.toFixed(0), expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
		txHash: row.txHash, logIndex: row.logIndex, confirmations: row.confirmations, actualFeeWei: row.actualFeeWei?.toFixed(0) ?? null, lastError: row.lastError };
}
function view(row: Row): PublicRedemption {
	return { id: row.id, orderId: row.orderId, status: row.status as PublicRedemption['status'], redemptionKey: row.redemptionKey, holder: row.holder,
		tbcRecipient: row.tbcRecipient, sourceAssetKind: row.sourceAssetKind as PublicRedemption['sourceAssetKind'], amountRaw: row.amountRaw.toFixed(0),
		payoutRaw: row.payoutRaw?.toString() ?? null, feeRaw: row.feeRaw?.toString() ?? null, releasePlanHash: row.releasePlanHash,
		fundingAddress: row.fundingAddress, fundingRequiredRaw: row.fundingRequiredRaw?.toString() ?? null,
		feeQuote: row.feeQuote as PublicRedemption['feeQuote'], fundingTxid: row.fundingTxid, fundingConfirmations: row.fundingConfirmations,
		releaseTxid: row.releaseTxid, releaseConfirmations: row.releaseConfirmations,
		releaseBlockHash: row.releaseBlockHash, checkedAt: row.checkedAt?.toISOString() ?? null, lastError: row.lastError, createdAt: row.createdAt.toISOString(), calls: row.calls.map(callView) };
}

@Injectable()
export class SepoliaBurnRedemptionService {
	private readonly running = new Set<string>();
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeSettlementRepository) private readonly orders: BridgeSettlementRepository,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
		@Inject(BridgeDepositVerifier) private readonly deposits: BridgeDepositVerifier,
		@Inject(RedemptionReleaseEngine) private readonly source: RedemptionReleaseEngine,
		@Inject(SepoliaNativeReleaseEngine) private readonly releases: SepoliaNativeReleaseEngine,
		@Inject(BridgeProgressService) private readonly progress: BridgeProgressService) {}

	private async owned(orderId: string, principal: Principal) {
		this.auth.requireTbc(principal);
		const row = await this.db.sepoliaBurnRedemption.findFirst({ where: { orderId, identityId: principal.id }, include });
		if (!row) throw new NotFoundException('No Sepolia burn return is saved for this bridge order.');
		return row;
	}
	private validOrder(order: SettlementOrder) {
		const protocol = order.deployment.quote && typeof order.deployment.quote === 'object' ? (order.deployment.quote as Record<string, unknown>).protocol : null;
		if (order.destinationChainId !== ETHEREUM_SEPOLIA_CHAIN_ID || !['native-tbc-burn-v1', 'tbc-ft-burn-v1'].includes(String(protocol))) throw new ConflictException('This order is not an Ethereum Sepolia burn-return route.');
		if (order.settlement?.status !== 'completed' || !order.settlement.deposit || !order.custody) throw new ConflictException('Complete and verify the TBC to Sepolia mint before preparing its return.');
		if (order.settlement.deposit.confirmations < order.sourceConfirmationsRequired || order.settlement.deposit.amountRaw.toFixed(0) !== order.amountRaw.toFixed(0)) throw new ConflictException('The original TBC reserve is not fully confirmed.');
		return order;
	}
	private async order(orderId: string, principal: Principal) {
		this.auth.requireTbc(principal);
		return this.validOrder(await this.orders.owned(orderId, principal.id));
	}
	private sourceKind(order: SettlementOrder): PublicRedemption['sourceAssetKind'] {
		return order.deployment.quote && typeof order.deployment.quote === 'object' && (order.deployment.quote as Record<string, unknown>).sourceAssetKind === 'fungible-token' ? 'fungible-token' : 'native-tbc';
	}
	private async ftMaterial(order: SettlementOrder, recipient: string, signal: AbortSignal): Promise<ReleaseMaterial> {
		const deposit = order.settlement!.deposit!;
		const reserve = await this.deposits.verify(order, order.custody!.address, deposit.txid, signal);
		if (reserve.confirmations < order.sourceConfirmationsRequired || reserve.blockHash !== deposit.blockHash || reserve.amountRaw !== order.amountRaw.toFixed(0)) throw new ConflictException('The original TT reserve is not confirmed in its saved canonical block.');
		return this.source.material(reserve.txid, reserve.vout, reserve.amountRaw, order.custody!.address, recipient, order.custody!.publicKeyHex, signal);
	}
	private async run<T>(key: string, response: Response, work: (signal: AbortSignal) => Promise<T>) {
		if (this.running.has(key) || this.running.size >= 4) throw new ConflictException('A Sepolia return check is already running. Refresh saved progress shortly.');
		this.running.add(key); const controller = new AbortController();
		const close = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', close);
		const timer = setTimeout(() => controller.abort(), 110_000); timer.unref();
		try { return await work(controller.signal); }
		catch (cause) { if (controller.signal.aborted) throw new GatewayTimeoutException('The return check was interrupted. Refresh saved progress; do not burn or broadcast again.'); throw cause; }
		finally { controller.abort(); clearTimeout(timer); response.removeListener('close', close); this.running.delete(key); }
	}
	private progressState(row: Row) {
		return JSON.stringify({ status: row.status, fundingTxid: row.fundingTxid, fundingConfirmations: row.fundingConfirmations,
			releaseTxid: row.releaseTxid, releaseConfirmations: row.releaseConfirmations, releaseBlockHash: row.releaseBlockHash,
			lastError: row.lastError, calls: row.calls.map((call) => ({ id: call.id, status: call.status, txHash: call.txHash,
				confirmations: call.confirmations, receiptBlockHash: call.receiptBlockHash, lastError: call.lastError })) });
	}
	private async publishIfChanged(id: string, before: string, reason: string) {
		const after = await this.db.sepoliaBurnRedemption.findUnique({ where: { id }, include });
		if (after && this.progressState(after) !== before) this.progress.publish(after.identityId, after.orderId, reason);
	}

	private async observeSavedFunding(row: Row, signal: AbortSignal, requestedTxid?: string) {
		if (row.sourceAssetKind !== 'fungible-token' || row.status !== 'awaiting_fee' || !row.fundingAddress || row.fundingRequiredRaw === null) return;
		const txid = requestedTxid ?? row.fundingTxid ?? undefined;
		const observed = txid
			? await this.source.observeFunding(row.fundingAddress, txid, signal)
			: await this.source.discoverFunding(row.fundingAddress, row.fundingRequiredRaw.toString(), signal);
		if (!observed) {
			await this.db.sepoliaBurnRedemption.updateMany({ where: { id: row.id, status: 'awaiting_fee', fundingTxid: null }, data: { checkedAt: new Date(), lastError: null } });
			return;
		}
		if (observed.satoshis < Number(row.fundingRequiredRaw)) throw new ConflictException('This native TBC fee payment is below the frozen funding requirement. Do not pay again until it is reviewed.');
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`sepolia-redemption:${row.orderId}`}, 0))`;
			const current = await tx.sepoliaBurnRedemption.findUniqueOrThrow({ where: { id: row.id } });
			if (current.status !== 'awaiting_fee') return;
			if (current.fundingTxid && current.fundingTxid !== observed.txid) throw new ConflictException('A different fee TXID is already saved for this return. Do not pay again.');
			await tx.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { fundingTxid: observed.txid, fundingConfirmations: observed.confirmations,
				fundingVout: observed.outputIndex, fundingValueRaw: BigInt(observed.satoshis), fundingRaw: observed.raw, checkedAt: new Date(), lastError: null } });
		});
		if (observed.confirmations < 6) return;
		const order = this.validOrder(await this.orders.find(row.orderId));
		await this.custody.assertRecoverable(order, order.custody!);
		const material = await this.ftMaterial(order, row.tbcRecipient, signal);
		const plan = await this.source.funding(material, observed.txid, signal); signal.throwIfAborted();
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`sepolia-redemption:${row.orderId}`}, 0))`;
			const current = await tx.sepoliaBurnRedemption.findUniqueOrThrow({ where: { id: row.id } });
			if (current.status !== 'awaiting_fee') return;
			if (current.fundingTxid !== observed.txid) throw new ConflictException('The saved fee transaction changed during verification.');
			await tx.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: 'prepared', payoutRaw: BigInt(order.amountRaw.toFixed(0)), feeRaw: BigInt(plan.feeRaw),
				releaseUnsignedRaw: plan.unsignedRaw, releasePlanHash: plan.planHash, fundingConfirmations: plan.confirmations,
				fundingVout: plan.funding.outputIndex, fundingValueRaw: BigInt(plan.funding.satoshis), fundingRaw: plan.fundingRaw, reserveRaw: material.reserve.uncheckedSerialize(),
				releaseInputs: plan.inputs as unknown as Prisma.InputJsonValue, proof: material.proof, checkedAt: new Date(), lastError: null } });
			await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.sepolia_redemption.fee_reserved', data: { orderId: row.orderId, redemptionId: row.id, txid: observed.txid, planHash: plan.planHash } } });
		});
	}
	async observeFundingProgress(id: string) {
		const row = await this.db.sepoliaBurnRedemption.findUnique({ where: { id }, include });
		if (!row || row.status !== 'awaiting_fee') return;
		const before = this.progressState(row);
		const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 50_000); timeout.unref();
		try { await this.observeSavedFunding(row, controller.signal); }
		catch (cause) {
			await this.db.sepoliaBurnRedemption.updateMany({ where: { id, status: 'awaiting_fee' }, data: { checkedAt: new Date(), lastError: cause instanceof Error ? cause.message : 'Automatic fee check is temporarily unavailable.' } });
			throw cause;
		} finally { clearTimeout(timeout); await this.publishIfChanged(id, before, 'sepolia-funding'); }
	}
	async get(orderId: string, principal: Principal) {
		this.auth.requireTbc(principal);
		const row = await this.db.sepoliaBurnRedemption.findFirst({ where: { orderId, identityId: principal.id }, include });
		return row ? view(row) : null;
	}
	async prepare(orderId: string, holder: string, tbcRecipient: string, principal: Principal, response: Response) {
		return this.run(`prepare:${orderId}`, response, async (signal) => {
			const order = await this.order(orderId, principal);
			if (holder.toLowerCase() !== order.recipient.toLowerCase()) throw new BadRequestException(`Select the original receiving account ${order.recipient} on Sepolia.`);
			if (tbcRecipient !== order.sender || tbcRecipient !== principal.address) throw new BadRequestException('This full return must go back to the signed-in source TBC wallet.');
			const existing = await this.db.sepoliaBurnRedemption.findUnique({ where: { orderId }, include });
			if (existing) {
				if (existing.identityId !== principal.id || existing.holder !== holder.toLowerCase() || existing.tbcRecipient !== tbcRecipient) throw new ConflictException('This order already has different frozen return terms.');
				return view(existing);
			}
			await this.custody.assertRecoverable(order, order.custody!);
			const deposit = order.settlement!.deposit!;
			const sourceAssetKind = this.sourceKind(order);
			const nativePlan = sourceAssetKind === 'native-tbc' ? await this.releases.prepare(deposit.txid, deposit.vout, order.amountRaw.toFixed(0), order.custody!.address, tbcRecipient, signal) : null;
			const ftMaterial = sourceAssetKind === 'fungible-token' ? await this.ftMaterial(order, tbcRecipient, signal) : null;
			const feeQuote = ftMaterial ? this.source.quote(ftMaterial) : null;
			const id = randomUUID();
			const redemptionKey = `0x${createHash('sha256').update(`learning-bridge/sepolia-redemption/v1:${id}`).digest('hex')}`;
			const row = await this.db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`sepolia-redemption:${orderId}`}, 0))`;
				const current = await tx.sepoliaBurnRedemption.findUnique({ where: { orderId }, include });
				if (current) return current;
				const created = await tx.sepoliaBurnRedemption.create({ data: { id, orderId, identityId: principal.id, redemptionKey, holder: holder.toLowerCase(), tbcRecipient, sourceAssetKind,
					status: nativePlan ? 'prepared' : 'awaiting_fee', amountRaw: order.amountRaw, payoutRaw: nativePlan ? BigInt(nativePlan.payoutRaw) : BigInt(order.amountRaw.toFixed(0)),
					feeRaw: nativePlan ? BigInt(nativePlan.feeRaw) : null, releaseUnsignedRaw: nativePlan?.unsignedRaw, releasePlanHash: nativePlan?.planHash,
					fundingAddress: ftMaterial?.custodyAddress, fundingRequiredRaw: feeQuote ? BigInt(feeQuote.fundingRequiredRaw) : null,
					feeQuote: feeQuote as unknown as Prisma.InputJsonValue }, include });
				await tx.auditEvent.create({ data: { identityId: principal.id, action: 'bridge.sepolia_redemption.prepared', data: { orderId, redemptionId: id, redemptionKey, sourceAssetKind, payoutRaw: nativePlan ? String(nativePlan.payoutRaw) : order.amountRaw.toFixed(0), feeRaw: nativePlan ? String(nativePlan.feeRaw) : feeQuote?.feeRaw } } });
				return created;
			});
				this.progress.publish(row.identityId, row.orderId, 'sepolia-return-prepared');
			return view(row);
		});
	}
	async fund(orderId: string, txid: string, principal: Principal, response: Response) {
		return this.run(`fund:${orderId}`, response, async (signal) => {
			const row = await this.owned(orderId, principal); await this.order(orderId, principal);
			if (row.sourceAssetKind !== 'fungible-token') throw new ConflictException('Native TBC returns do not need a separate fee input.');
			if (row.status !== 'awaiting_fee') throw new ConflictException('This fee preparation is already closed. Refresh saved progress.');
				const before = this.progressState(row);
			await this.observeSavedFunding(row, signal, txid);
				await this.publishIfChanged(row.id, before, 'sepolia-funding');
			return view(await this.owned(orderId, principal));
		});
	}

	private calldata(row: SepoliaBurnRedemption) {
		return encodeFunctionData({ abi, functionName: 'burnForRedemption', args: [row.redemptionKey as Hex, row.tbcRecipient, BigInt(row.amountRaw.toFixed(0))] });
	}
	async quote(orderId: string, from: string, principal: Principal, response: Response) {
		const row = await this.owned(orderId, principal); const order = await this.order(orderId, principal);
		if (row.status !== 'prepared') throw new ConflictException('This burn return has already progressed beyond preparation.');
		if (from.toLowerCase() !== row.holder) throw new BadRequestException(`Select the original wrapped-token holder ${row.holder} in MetaMask.`);
		if (row.calls.some((item) => activeCallStates.includes(item.status))) throw new ConflictException('Complete or reconcile the existing burn wallet request first.');
		const data = this.calldata(row); const to = order.destinationContract.toLowerCase() as Address; const amount = BigInt(row.amountRaw.toFixed(0));
		const quote = await withSepoliaRpc(response, async (rpc) => {
			const block = await rpc.getBlock({ blockTag: 'latest' }); if (block.number === null || !block.hash) throw new ConflictException('No canonical Sepolia block is available.');
			const [paused, balance, processed, eth, code, nonce, gasPrice] = await Promise.all([
				rpc.readContract({ address: to, abi, functionName: 'paused', blockNumber: block.number }), rpc.readContract({ address: to, abi, functionName: 'balanceOf', args: [from as Address], blockNumber: block.number }),
				rpc.readContract({ address: to, abi, functionName: 'processedRedemptions', args: [row.redemptionKey as Hex], blockNumber: block.number }), rpc.getBalance({ address: from as Address, blockNumber: block.number }),
				rpc.getCode({ address: from as Address, blockNumber: block.number }), rpc.getTransactionCount({ address: from as Address, blockTag: 'pending' }), rpc.getGasPrice(),
			]);
			if (paused || processed) throw new ConflictException(processed ? 'This redemption key was already burned. Reconcile its saved transaction.' : 'The Sepolia route is paused. No burn was prepared.');
			if (balance < amount) throw new ConflictException('The original receiving account does not hold the full wrapped TBC amount for this return.');
			if (code && code !== '0x') throw new BadRequestException('Use the original ordinary MetaMask account; smart-account burns are not enabled.');
			const estimate = await rpc.estimateGas({ account: from as Address, to, data, value: 0n, blockNumber: block.number, prepare: false });
			const gas = (estimate * 120n + 99n) / 100n;
			if (gas <= 0n || gas > block.gasLimit || gasPrice <= 0n || eth < gas * gasPrice) throw new ConflictException('The selected account needs enough Sepolia ETH for the reviewed burn transaction budget.');
			if ((await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new ConflictException('The Sepolia quote block changed. Prepare a fresh quote.');
			return { nonce: BigInt(nonce), gasLimit: gas, gasPriceWei: gasPrice, estimatedFeeWei: estimate * gasPrice, budgetWei: gas * gasPrice };
		});
		const call = await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`sepolia-burn:${row.id}`}, 0))`;
			if (await tx.sepoliaBurnCall.count({ where: { redemptionId: row.id, status: { in: activeCallStates } } })) throw new ConflictException('Another burn wallet request is already active.');
			const created = await tx.sepoliaBurnCall.create({ data: { redemptionId: row.id, chainId: ETHEREUM_SEPOLIA_CHAIN_ID, fromAddress: from.toLowerCase(), toAddress: to,
				data, nonce: quote.nonce, gasLimit: quote.gasLimit, gasPriceWei: quote.gasPriceWei.toString(), estimatedFeeWei: quote.estimatedFeeWei.toString(), budgetWei: quote.budgetWei.toString(), expiresAt: new Date(Date.now() + 60_000) } });
			await tx.auditEvent.create({ data: { identityId: principal.id, action: 'bridge.sepolia_redemption.burn_quoted', data: { orderId, redemptionId: row.id, callId: created.id } } });
			return created;
		});
			this.progress.publish(row.identityId, row.orderId, 'sepolia-burn-quoted');
		return callView(call);
	}
	private async call(orderId: string, callId: string, principal: Principal) {
		const row = await this.owned(orderId, principal);
		const call = row.calls.find((item) => item.id === callId); if (!call) throw new NotFoundException('Burn wallet request not found.');
		return { row, call };
	}
	async begin(orderId: string, callId: string, principal: Principal) {
		const { row, call } = await this.call(orderId, callId, principal);
		const changed = await this.db.sepoliaBurnCall.updateMany({ where: { id: call.id, status: 'quoted', updatedAt: call.updatedAt, expiresAt: { gt: new Date() } }, data: { status: 'awaiting_wallet' } });
		if (changed.count !== 1) throw new ConflictException('This burn quote changed or expired. Prepare a fresh quote.');
		await this.db.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: 'burn_pending', checkedAt: new Date() } });
			this.progress.publish(row.identityId, row.orderId, 'sepolia-burn-wallet-opened');
		return callView(await this.db.sepoliaBurnCall.findUniqueOrThrow({ where: { id: call.id } }));
	}
	async submit(orderId: string, callId: string, txHash: string, principal: Principal) {
			const { row, call } = await this.call(orderId, callId, principal);
		const changed = await this.db.sepoliaBurnCall.updateMany({ where: { id: call.id, status: 'awaiting_wallet', txHash: null, updatedAt: call.updatedAt }, data: { status: 'submitted', txHash: txHash.toLowerCase() } });
		if (changed.count !== 1) throw new ConflictException('The burn request changed. Refresh saved progress and do not send again.');
			this.progress.publish(row.identityId, row.orderId, 'sepolia-burn-submitted');
		return callView(await this.db.sepoliaBurnCall.findUniqueOrThrow({ where: { id: call.id } }));
	}
	async cancel(orderId: string, callId: string, notSent: boolean, principal: Principal) {
		const { row, call } = await this.call(orderId, callId, principal);
		if (!notSent || call.txHash) throw new ConflictException('Only a rejected or never-sent MetaMask request can be discarded.');
		const changed = await this.db.sepoliaBurnCall.updateMany({ where: { id: call.id, txHash: null, status: { in: ['quoted', 'awaiting_wallet'] }, updatedAt: call.updatedAt }, data: { status: 'cancelled' } });
		if (changed.count !== 1) throw new ConflictException('The burn request changed. Check MetaMask Activity.');
		await this.db.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: 'prepared', checkedAt: new Date(), lastError: null } });
			this.progress.publish(row.identityId, row.orderId, 'sepolia-burn-cancelled');
		return callView(await this.db.sepoliaBurnCall.findUniqueOrThrow({ where: { id: call.id } }));
	}

	private async verifyBurn(row: Row, call: SepoliaBurnCall, order: SettlementOrder, response?: Response) {
		if (!call.txHash) throw new ConflictException('Save the burn transaction hash from MetaMask Activity first.');
		return withSepoliaRpc(response, async (rpc) => {
			let tx; try { tx = await rpc.getTransaction({ hash: call.txHash as Hex }); } catch { return { pending: true as const, confirmations: 0 }; }
			if (!(await matchesFrozenBurnEnvelope(tx, call))) throw new ConflictException('The Sepolia burn transaction is not the reviewed direct call or its exact supported MetaMask delegation.');
			let receipt; try { receipt = await rpc.getTransactionReceipt({ hash: call.txHash as Hex }); } catch { return { pending: true as const, confirmations: 0 }; }
			if (receipt.status !== 'success') return { reverted: true as const, confirmations: 0, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, actualFee: receipt.gasUsed * receipt.effectiveGasPrice };
			const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
			if (block.hash !== receipt.blockHash) throw new ConflictException('The Sepolia burn receipt is no longer in its saved canonical block.');
			const latest = await rpc.getBlockNumber(); const confirmations = Number(latest >= receipt.blockNumber ? latest - receipt.blockNumber + 1n : 0n);
			const matches: { logIndex: number; args: Record<string, unknown> }[] = [];
			for (const log of receipt.logs) {
				if (log.address.toLowerCase() !== order.destinationContract.toLowerCase()) continue;
				try {
					const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
					if (decoded.eventName === 'RedemptionBurned' && String(decoded.args.redemptionId).toLowerCase() === row.redemptionKey.toLowerCase()) matches.push({ logIndex: log.logIndex ?? 0, args: decoded.args as unknown as Record<string, unknown> });
				} catch { /* Other token events are irrelevant. */ }
			}
			if (matches.length !== 1) throw new ConflictException('Exactly one matching Sepolia RedemptionBurned event is required.');
			const event = matches[0];
			const expectedSourceId = row.sourceAssetKind === 'native-tbc' ? NATIVE_TBC_SOURCE_ID : `0x${order.contractId}`;
			const expectedSourceKind = row.sourceAssetKind === 'fungible-token' ? 1 : 0;
			if (String(event.args.holder).toLowerCase() !== row.holder || String(event.args.recipientHash).toLowerCase() !== keccak256(stringToHex(row.tbcRecipient)).toLowerCase()
				|| String(event.args.sourceAssetId).toLowerCase() !== expectedSourceId.toLowerCase() || Number(event.args.sourceAssetKind) !== expectedSourceKind
				|| event.args.tbcRecipient !== row.tbcRecipient || BigInt(String(event.args.amountRaw)) !== BigInt(row.amountRaw.toFixed(0))) throw new ConflictException('The Sepolia burn event differs from the frozen TBC return terms.');
			const processed = await rpc.readContract({ address: order.destinationContract as Address, abi, functionName: 'processedRedemptions', args: [row.redemptionKey as Hex], blockNumber: receipt.blockNumber });
			if (!processed || (await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new ConflictException('The burn replay marker or canonical block changed during verification.');
			return { pending: false as const, confirmations, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, actualFee: receipt.gasUsed * receipt.effectiveGasPrice, logIndex: event.logIndex };
		});
	}
	private async observeBurn(row: Row, call: SepoliaBurnCall, order: SettlementOrder, signal: AbortSignal, response?: Response) {
		if (!call.txHash) throw new ConflictException('Save the MetaMask burn hash first.');
		const proof = await this.verifyBurn(row, call, order, response); signal.throwIfAborted();
		if ('reverted' in proof) {
			await this.db.$transaction([this.db.sepoliaBurnCall.update({ where: { id: call.id }, data: { status: 'reverted', confirmations: 0, receiptBlockHash: proof.blockHash, receiptBlockNumber: proof.blockNumber, actualFeeWei: proof.actualFee!.toString(), lastError: 'The Sepolia burn reverted. The wrapped tokens were not destroyed.' } }), this.db.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: 'prepared', checkedAt: new Date(), lastError: null } })]);
			return;
		}
		if (proof.pending) {
			await this.db.$transaction([this.db.sepoliaBurnCall.update({ where: { id: call.id }, data: { status: 'submitted', confirmations: 0, lastError: null } }), this.db.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: 'burn_pending', checkedAt: new Date(), lastError: null } })]);
			return;
		}
		const verified = proof.confirmations >= order.destinationConfirmationsRequired;
		await this.db.$transaction([this.db.sepoliaBurnCall.update({ where: { id: call.id }, data: { status: verified ? 'verified' : 'confirming', confirmations: proof.confirmations, logIndex: proof.logIndex, receiptBlockHash: proof.blockHash, receiptBlockNumber: proof.blockNumber, actualFeeWei: proof.actualFee.toString(), lastError: null } }), this.db.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: verified ? 'burn_verified' : 'burn_confirming', checkedAt: new Date(), lastError: null } })]);
		if (verified) {
			const current = await this.db.sepoliaBurnRedemption.findUniqueOrThrow({ where: { id: row.id }, include });
			await this.signRelease(current, order, signal);
		}
	}
	private plan(row: Row, order: SettlementOrder): NativeReleasePlan {
		if (!row.releaseUnsignedRaw || !row.releasePlanHash || row.feeRaw === null || row.payoutRaw === null) throw new ConflictException('The saved native TBC release plan is incomplete.');
		const deposit = order.settlement!.deposit!;
		const input: NativeReleaseInput = { txId: deposit.txid, outputIndex: deposit.vout, script: requireCustodyScript(order), satoshis: Number(order.amountRaw.toFixed(0)) };
		return { unsignedRaw: row.releaseUnsignedRaw, planHash: row.releasePlanHash, feeRaw: Number(row.feeRaw), payoutRaw: Number(row.payoutRaw), estimatedBytes: 0, input };
	}
	private async signRelease(row: Row, order: SettlementOrder, signal: AbortSignal) {
		if (row.releaseRaw && row.releaseTxid) return;
		let planHash: string; let signed: { raw: string; txid: string };
		if (row.sourceAssetKind === 'native-tbc') {
			const deposit = order.settlement!.deposit!; await this.source.nativeUnspent(order.custody!.address, deposit.txid, deposit.vout, Number(order.amountRaw.toFixed(0)), signal);
			const plan = this.plan(row, order); planHash = plan.planHash;
			signed = await this.custody.signRelease(order, order.custody!, plan.planHash, (key) => this.releases.sign(plan, row.tbcRecipient, order.custody!.address, order.custody!.publicKeyHex, key));
		} else {
			if (!row.fundingTxid || !row.releaseUnsignedRaw || !row.releasePlanHash || row.feeRaw === null || !row.reserveRaw || !row.proof) throw new ConflictException('Fund and freeze the TT release before burning wTT.');
			const material = await this.ftMaterial(order, row.tbcRecipient, signal);
			const funding = await this.source.funding(material, row.fundingTxid, signal);
			if (funding.planHash !== row.releasePlanHash || funding.unsignedRaw !== row.releaseUnsignedRaw || material.reserve.uncheckedSerialize() !== row.reserveRaw || material.proof !== row.proof) throw new ConflictException('The funded TT release differs from its immutable saved plan.');
			planHash = row.releasePlanHash;
			signed = await this.custody.signRelease(order, order.custody!, planHash, (key) => this.source.sign(row.releaseUnsignedRaw!, material, funding.funding, row.feeRaw!, key));
		}
		await this.db.$transaction(async (db) => {
			const changed = await db.sepoliaBurnRedemption.updateMany({ where: { id: row.id, releaseRaw: null, status: 'burn_verified' }, data: { releaseRaw: signed.raw, releaseTxid: signed.txid, status: 'release_signed', checkedAt: new Date(), lastError: null } });
			if (changed.count !== 1) throw new ConflictException('The verified return changed while saving its signed TBC release. Refresh saved progress.');
			await db.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.sepolia_redemption.release_signed', data: { orderId: row.orderId, redemptionId: row.id, txid: signed.txid, planHash } } });
		});
	}
	async checkBurn(orderId: string, callId: string, principal: Principal, response: Response) {
		return this.run(`burn:${callId}`, response, async (signal) => {
			const { row, call } = await this.call(orderId, callId, principal); const order = await this.order(orderId, principal);
			const before = this.progressState(row);
			await this.observeBurn(row, call, order, signal, response);
			await this.publishIfChanged(row.id, before, 'sepolia-burn');
			return view(await this.owned(orderId, principal));
		});
	}
	async observeBurnProgress(callId: string) {
		const call = await this.db.sepoliaBurnCall.findUnique({ where: { id: callId } });
		if (!call?.txHash || !['submitted', 'confirming'].includes(call.status)) return;
		const row = await this.db.sepoliaBurnRedemption.findUnique({ where: { id: call.redemptionId }, include });
		if (!row) return;
		const before = this.progressState(row); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 40_000); timeout.unref();
		try {
			const order = this.validOrder(await this.orders.find(row.orderId));
			await this.observeBurn(row, call, order, controller.signal);
		} catch (cause) {
			await this.db.sepoliaBurnRedemption.updateMany({ where: { id: row.id, status: { in: ['burn_pending', 'burn_confirming'] } }, data: { checkedAt: new Date(), lastError: cause instanceof Error ? cause.message : 'Automatic Sepolia burn check is temporarily unavailable.' } });
			throw cause;
		} finally { clearTimeout(timeout); await this.publishIfChanged(row.id, before, 'sepolia-burn'); }
	}

	private assertSigned(row: Row, order: SettlementOrder) {
		if (!row.releaseRaw || !row.releaseTxid) throw new ConflictException('No signed TBC release is saved.');
		let tx;
		if (row.sourceAssetKind === 'native-tbc') {
			const plan = this.plan(row, order); tx = this.releases.assertPlan(row.releaseRaw, { input: plan.input, recipient: row.tbcRecipient, payoutRaw: BigInt(plan.payoutRaw), feeRaw: BigInt(plan.feeRaw) });
		} else {
			if (!row.releaseInputs || !row.reserveRaw || row.feeRaw === null) throw new ConflictException('The saved TT release evidence is incomplete.');
			tx = this.source.assertPlan(row.releaseRaw, { inputs: row.releaseInputs as unknown as ReleaseInput[], recipient: row.tbcRecipient, amountRaw: row.amountRaw.toFixed(0), custodyAddress: order.custody!.address, feeRaw: row.feeRaw, reserveRaw: row.reserveRaw });
		}
		if (tx.hash !== row.releaseTxid) throw new ConflictException('The saved TBC release TXID is invalid. Nothing was broadcast.');
		for (let index = 0; index < tx.inputs.length; index++) if (!tx.verifyScript(index).success) throw new ConflictException('A saved TBC release signature is invalid. Nothing was broadcast.');
		return tx;
	}
	async broadcast(orderId: string, planHash: string, principal: Principal, response: Response) {
		return this.run(`broadcast:${orderId}`, response, async (signal) => {
			const row = await this.owned(orderId, principal); const order = await this.order(orderId, principal);
			const before = this.progressState(row);
			if (planHash !== row.releasePlanHash || !row.releaseTxid || !row.releaseRaw) throw new ConflictException('Review the exact saved TBC release before broadcasting.');
			if (row.status === 'completed') return view(row);
			await this.broadcastSaved(row, order, signal);
			await this.publishIfChanged(row.id, before, 'sepolia-release-submitted');
			return view(await this.owned(orderId, principal));
		});
	}
	private async broadcastSaved(row: Row, order: SettlementOrder, signal: AbortSignal) {
		if (!['release_signed', 'release_broadcasting', 'release_submitted', 'release_confirming'].includes(row.status)) throw new ConflictException('The Sepolia burn must be verified before releasing TBC.');
		this.assertSigned(row, order);
		if (row.status !== 'release_signed') return;
		if (row.sourceAssetKind === 'native-tbc') {
			const deposit = order.settlement!.deposit!; await this.source.nativeUnspent(order.custody!.address, deposit.txid, deposit.vout, Number(order.amountRaw.toFixed(0)), signal);
		} else {
			if (!row.fundingTxid || row.fundingVout === null || row.fundingValueRaw === null || !row.reserveRaw || !row.proof) throw new ConflictException('The funded TT release evidence is incomplete.');
			const material = await this.ftMaterial(order, row.tbcRecipient, signal);
			await this.source.nativeUnspent(order.custody!.address, row.fundingTxid, row.fundingVout, Number(row.fundingValueRaw), signal);
			if (material.reserve.uncheckedSerialize() !== row.reserveRaw || material.proof !== row.proof) throw new ConflictException('The original TT reserve differs from the saved release proof.');
		}
		const changed = await this.db.sepoliaBurnRedemption.updateMany({ where: { id: row.id, status: 'release_signed', updatedAt: row.updatedAt }, data: { status: 'release_broadcasting', checkedAt: new Date(), lastError: 'Automatic submission started. Reconcile this exact saved TBC TXID; never create a second release.' } });
		if (changed.count !== 1) return;
		let accepted = false;
		try {
			const result = await fetch(API_URLS.testnetBroadcast, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ txraw: row.releaseRaw }), signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
			const body = await result.json(); accepted = result.ok && String(body.code) === '200' && body.data?.txid === row.releaseTxid;
		} catch { /* The exact raw transaction and TXID remain durable for reconciliation. */ }
		await this.db.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: accepted ? 'release_submitted' : 'release_broadcasting', checkedAt: new Date(), lastError: accepted ? null : 'Automatic submission is uncertain. Tracking the exact saved TBC TXID; no replacement payout will be created.' } });
	}
	private async observeRelease(row: Row, order: SettlementOrder, signal: AbortSignal) {
		this.assertSigned(row, order);
		if (!row.releaseTxid) throw new ConflictException('No saved TBC release TXID.');
		let block;
		try { block = await this.source.confirmed(row.releaseTxid, signal, true); }
		catch { throw new ServiceUnavailableException(`The exact release ${row.releaseTxid} is not visible yet. Retain it and refresh; do not broadcast again.`); }
		const completed = block.confirmations >= 6;
		await this.db.$transaction(async (tx) => {
			await tx.sepoliaBurnRedemption.update({ where: { id: row.id }, data: { status: completed ? 'completed' : 'release_confirming', releaseConfirmations: block.confirmations, releaseBlockHash: block.blockHash, releaseBlockHeight: block.blockHeight, checkedAt: new Date(), lastError: null } });
			if (completed && row.status !== 'completed') await tx.auditEvent.create({ data: { identityId: row.identityId, action: 'bridge.sepolia_redemption.completed', data: { orderId: row.orderId, redemptionId: row.id, burnTxHash: row.calls.find((item) => item.status === 'verified')?.txHash, releaseTxid: row.releaseTxid } } });
		});
	}
	async checkRelease(orderId: string, principal: Principal, response: Response) {
		return this.run(`release:${orderId}`, response, async (signal) => {
			const row = await this.owned(orderId, principal); const order = await this.order(orderId, principal); const before = this.progressState(row);
			await this.observeRelease(row, order, signal);
			await this.publishIfChanged(row.id, before, 'sepolia-release');
			return view(await this.owned(orderId, principal));
		});
	}
	async observeReleaseProgress(id: string) {
		const row = await this.db.sepoliaBurnRedemption.findUnique({ where: { id }, include });
		if (!row?.releaseTxid || !['release_signed', 'release_broadcasting', 'release_submitted', 'release_confirming'].includes(row.status)) return;
		const before = this.progressState(row); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 50_000); timeout.unref();
		try {
			const order = this.validOrder(await this.orders.find(row.orderId));
			if (row.status === 'release_signed') await this.broadcastSaved(row, order, controller.signal);
			else await this.observeRelease(row, order, controller.signal);
		} catch (cause) {
			await this.db.sepoliaBurnRedemption.updateMany({ where: { id, status: { in: ['release_signed', 'release_broadcasting', 'release_submitted', 'release_confirming'] } }, data: { checkedAt: new Date(), lastError: cause instanceof Error ? cause.message : 'Automatic TBC release check is temporarily unavailable.' } });
			throw cause;
		} finally { clearTimeout(timeout); await this.publishIfChanged(id, before, 'sepolia-release'); }
	}
}

function requireCustodyScript(order: SettlementOrder) {
	if (!order.custody) throw new ConflictException('The saved native TBC custody output is unavailable.');
	// Avoid persisting a second copy of the reserve script; it is deterministically
	// reconstructed from the authenticated custody address every time.
	return tbc.Script.buildPublicKeyHashOut(order.custody.address).toHex();
}
