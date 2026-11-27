import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { LEARNING_BRIDGE_ORDERS as rules, LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import type { BridgeOrder, BridgeOrderDraft, BridgeOrderDraftFinalizeInput, BridgeOrderDraftInput, BridgeOrderInput, BridgeOrderSetup } from '../../../shared/src/types/learningBridge';
import type { Prisma } from '../../generated/prisma/client';
import { tokenAmountToRaw } from '../../../shared/src/utils/tokenAmounts';
import { PrismaService } from '../database/prisma.service';
import { AuthService, type Principal } from '../auth/auth.service';
import { BRIDGE_ASSET_POLICY as policy } from './bridge.config';
import { bridgeRouteId, wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import { BridgeOrdersRepository } from './bridge-orders.repository';
import { BridgeOrderTargetService } from './bridge-order-target.service';
import { BridgeCustodyService } from './bridge-custody.service';
import { ETHEREUM_SEPOLIA_CHAIN_ID } from './ethereum-sepolia-rpc';

const draftInclude = { deployment: { include: { asset: true } } } as const;
type DraftRow = Prisma.BridgeOrderDraftGetPayload<{ include: typeof draftInclude }>;
type ExistingOrder = Prisma.BridgeOrderGetPayload<{ include: { deployment: { include: { asset: true } } } }>;

function governanceMode(quote: unknown) {
	return quote && typeof quote === 'object' && 'governanceMode' in quote ? String(quote.governanceMode) : '';
}

function draftView(row: DraftRow): BridgeOrderDraft {
	const native = row.deployment.asset.protocol === 'native-tbc' && row.deployment.chainId === ETHEREUM_SEPOLIA_CHAIN_ID;
	return { id: row.id, deploymentId: row.deploymentId, status: row.status as BridgeOrderDraft['status'], contractId: row.deployment.contractId,
		name: row.deployment.asset.name, totalSupplyRaw: row.deployment.asset.totalSupplyRaw.toFixed(0), verifiedAt: row.deployment.asset.verifiedAt.toISOString(),
		sourceAssetKind: native ? 'native-tbc' : 'fungible-token', destinationChainId: row.deployment.chainId as 998 | 11_155_111,
		destinationContract: row.deployment.contractAddress!, decimals: row.deployment.decimals, symbol: row.deployment.asset.symbol,
		...wrappedMetadata(row.deployment.quote), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
		finalizedAt: row.finalizedAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null };
}

function legacyOrderDraft(row: ExistingOrder): BridgeOrderDraft {
	const native = row.deployment.asset.protocol === 'native-tbc' && row.destinationChainId === ETHEREUM_SEPOLIA_CHAIN_ID;
	return { id: row.id, deploymentId: row.deploymentId, status: row.status === 'cancelled' ? 'cancelled' : 'finalized', contractId: row.contractId,
		name: row.deployment.asset.name, totalSupplyRaw: row.deployment.asset.totalSupplyRaw.toFixed(0), verifiedAt: row.deployment.asset.verifiedAt.toISOString(),
		sourceAssetKind: native ? 'native-tbc' : 'fungible-token', destinationChainId: row.destinationChainId as 998 | 11_155_111,
		destinationContract: row.destinationContract, decimals: row.decimals, symbol: row.symbol, ...wrappedMetadata(row.deployment.quote),
		createdAt: row.createdAt.toISOString(), updatedAt: (row.cancelledAt ?? row.createdAt).toISOString(),
		finalizedAt: row.status === 'cancelled' ? null : row.createdAt.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null };
}

@Injectable()
export class BridgeOrdersService {
	private readonly preparing = new Set<string>();
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeOrdersRepository) private readonly repository: BridgeOrdersRepository,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService,
		@Inject(BridgeCustodyService) private readonly custody: BridgeCustodyService,
	) {}
	async setup(principal: Principal): Promise<BridgeOrderSetup> {
		this.auth.requireTbc(principal);
		const [custodyReady, deployments] = await Promise.all([
			this.custody.ready(),
			this.db.bridgeDeployment.findMany({ where: { identityId: principal.id, status: 'verified', lastError: null }, orderBy: { createdAt: 'desc' }, take: 201, include: { asset: true } }),
		]);
		if (deployments.length > 200) throw new ConflictException('Too many registered routes to load. No partial route list was returned.');
		return { custodyReady, paymentEnabled: custodyReady, maxOpenOrders: rules.maxOpenOrders,
			message: custodyReady ? 'Prepare an order, then explicitly open payment details. Deposits are verified before wallet-confirmed minting.' : 'Custody setup is unavailable. Run local setup or restore the configured custody encryption key.',
			deployments: deployments.filter((row) => row.contractAddress && row.verifiedAt).map((row) => {
				const quote = row.quote as unknown as { governanceMode?: string; protocol?: string; sourceAssetKind?: string };
				const native = row.asset.protocol === 'native-tbc' && row.chainId === ETHEREUM_SEPOLIA_CHAIN_ID;
				return ({
				contractId: row.contractId,
				decimals: row.decimals,
				sourceSymbol: row.asset.symbol,
				...wrappedMetadata(row.quote),
				id: row.id,
				contractAddress: row.contractAddress!,
				deployer: row.deployer,
				verifiedAt: row.verifiedAt!.toISOString(),
				chainId: row.chainId,
				protocol: native ? 'native-tbc' as const : 'legacy-ft' as const,
				sourceAssetKind: native ? 'native-tbc' as const : 'fungible-token' as const,
				governanceMode: quote.governanceMode === 'multisig-relayer-v1.5' ? 'multisig-relayer-v1.5' as const
					: quote.governanceMode === 'ethereum-burn-multisig-v1' ? 'ethereum-burn-multisig-v1' as const : undefined,
			}); }),
		};
	}
	async list(principal: Principal) { this.auth.requireTbc(principal); return this.repository.list(principal.id); }
	async createDraft(input: BridgeOrderDraftInput, principal: Principal): Promise<BridgeOrderDraft> {
		this.auth.requireTbc(principal);
		const candidates = await this.db.bridgeDeployment.findMany({ where: { identityId: principal.id, contractId: input.contractId.toLowerCase(), chainId: input.destinationChainId,
			status: 'verified', lastError: null, contractAddress: { not: null } }, include: { asset: true }, orderBy: { createdAt: 'desc' }, take: 20 });
		const expectedGovernance = input.destinationChainId === ETHEREUM_SEPOLIA_CHAIN_ID ? 'ethereum-burn-multisig-v1' : 'multisig-relayer-v1.5';
		const chosen = candidates.find((row) => governanceMode(row.quote) === expectedGovernance);
		if (!chosen) throw new NotFoundException('No active verified bridge route matches this token and destination. Return to Transfer and choose another route.');
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-orders:${principal.id}`}, 0))`;
			const previous = await tx.bridgeOrderDraft.findUnique({ where: { identityId_idempotencyKey: { identityId: principal.id, idempotencyKey: input.idempotencyKey } }, include: draftInclude });
			if (previous) {
				if (previous.deploymentId !== chosen.id) throw new ConflictException('This Proceed request was already used for a different bridge route. Refresh Transfer before retrying.');
				return draftView(previous);
			}
			const [drafts, orders] = await Promise.all([
				tx.bridgeOrderDraft.count({ where: { identityId: principal.id, status: 'draft' } }),
				tx.bridgeOrder.count({ where: { identityId: principal.id, status: 'prepared', OR: [{ settlement: null }, { settlement: { status: { not: 'completed' } } }] } }),
			]);
			if (drafts + orders >= rules.maxOpenOrders) throw new ConflictException(`You already have ${rules.maxOpenOrders} unfinished transfers. Continue or close one from Reconciliation before creating another.`);
			const row = await tx.bridgeOrderDraft.create({ data: { identityId: principal.id, idempotencyKey: input.idempotencyKey, deploymentId: chosen.id }, include: draftInclude });
			await tx.auditEvent.create({ data: { identityId: principal.id, action: 'bridge.order_draft.created', data: { id: row.id, deploymentId: row.deploymentId } } });
			return draftView(row);
		});
	}
	async getDraft(id: string, principal: Principal): Promise<BridgeOrderDraft> {
		this.auth.requireTbc(principal);
		const draft = await this.db.bridgeOrderDraft.findFirst({ where: { id, identityId: principal.id }, include: draftInclude });
		if (draft) return draftView(draft);
		const order = await this.db.bridgeOrder.findFirst({ where: { id, identityId: principal.id }, include: { deployment: { include: { asset: true } } } });
		if (order) return legacyOrderDraft(order);
		throw new NotFoundException('Transfer order not found for this signed-in TBC wallet.');
	}
	async finalizeDraft(id: string, input: BridgeOrderDraftFinalizeInput, principal: Principal, response: Response): Promise<BridgeOrder> {
		this.auth.requireTbc(principal);
		const draft = await this.db.bridgeOrderDraft.findFirst({ where: { id, identityId: principal.id } });
		if (!draft) {
			const existing = await this.repository.existing(principal.id, id);
			if (existing) return this.repository.assertRetry(existing, { deploymentId: existing.deploymentId, recipient: existing.recipient, amountRaw: existing.amountRaw.toFixed(0) });
			throw new NotFoundException('Transfer draft not found. Return to Transfer and start again.');
		}
		if (draft.status === 'cancelled') throw new ConflictException('This transfer draft was closed. Start a new transfer.');
		return this.prepare({ idempotencyKey: id, deploymentId: draft.deploymentId, amount: input.amount, recipient: input.recipient }, principal, response, id);
	}
	async prepare(input: BridgeOrderInput, principal: Principal, response: Response, draftId?: string) {
		this.auth.requireTbc(principal);
		const chosen = await this.db.bridgeDeployment.findFirst({ where: { id: input.deploymentId, identityId: principal.id }, include: { asset: true } });
		if (!chosen) throw new NotFoundException('Choose a deployment registered to your TBC wallet.');
		let amount: bigint;
		try { amount = tokenAmountToRaw(input.amount, chosen.decimals); } catch { throw new BadRequestException(`Enter a positive amount with at most ${chosen.decimals} decimal places.`); }
		if (amount > 18446744073709551615n) throw new BadRequestException('This amount exceeds the supported TBC quantity range.');
		if (!isAddress(input.recipient, { strict: true }) || input.recipient.toLowerCase() === zeroAddress) throw new BadRequestException('Use a valid, nonzero destination recipient address. Check mixed-case checksums.');
		const recipient = getAddress(input.recipient).toLowerCase();
		const retry = await this.repository.existing(principal.id, input.idempotencyKey);
		if (retry) return this.repository.assertRetry(retry, { deploymentId: input.deploymentId, recipient, amountRaw: amount.toString() });
		if (this.preparing.has(principal.id) || this.preparing.size >= 4) throw new ConflictException('An order preparation is running. Wait, then refresh saved orders.');
		this.preparing.add(principal.id);
		try {
			const [deployment, asset, custodyReady] = await Promise.all([
				this.db.bridgeDeployment.findFirst({ where: { id: input.deploymentId, identityId: principal.id, status: 'verified', lastError: null } }),
				this.db.bridgeAsset.findUnique({ where: { routeId: chosen.routeId } }),
				this.custody.ready(),
			]);
			if (!deployment?.contractAddress) throw new NotFoundException('Choose a verified deployment saved by your current TBC wallet.');
			const sepolia = deployment.chainId === ETHEREUM_SEPOLIA_CHAIN_ID;
			const native = asset?.protocol === 'native-tbc' && sepolia;
			if (!asset || asset.contractId !== deployment.contractId || asset.decimals !== deployment.decimals
				|| native && (asset.routeId !== deployment.routeId || asset.destinationChainId !== ETHEREUM_SEPOLIA_CHAIN_ID)
				|| sepolia && !native && (asset.routeId !== deployment.routeId || asset.destinationChainId !== ETHEREUM_SEPOLIA_CHAIN_ID || asset.protocol !== 'legacy-ft'
					|| asset.confirmations < policy.minimumConfirmations || asset.verifiedAt.getTime() > Date.now() + 30_000)
				|| !sepolia && (asset.routeId !== bridgeRouteId(deployment.contractId) || asset.destinationChainId !== 998
					|| asset.confirmations < policy.minimumConfirmations || Date.now() - asset.verifiedAt.getTime() > LEARNING_BRIDGE_EVM.assetVerificationLifetimeMs || asset.verifiedAt.getTime() > Date.now() + 30_000))
				throw new ConflictException(native ? 'The native TBC Sepolia route is no longer verified.' : 'Verify this token again before preparing the transfer. Verification must be less than 10 minutes old.');
			if (amount > BigInt(asset.totalSupplyRaw.toFixed(0))) throw new BadRequestException('The order amount exceeds the verified token total supply.');
			if (!custodyReady) throw new ServiceUnavailableException('Custody setup is unavailable. Restore the configured custody encryption key before preparing orders.');
			if (recipient === deployment.contractAddress.toLowerCase()) throw new BadRequestException('The wrapped token contract cannot be the recipient. Choose a receiving wallet address.');
			const target = await this.target.check(deployment, response);
			if (target.paused) throw new ConflictException('This V1.5 wrapped-token route is deployed but still paused. Complete its one-time 2-of-2 Admin activation before accepting a source payment.');
			return await this.repository.create({ identityId: principal.id, idempotencyKey: input.idempotencyKey, deployment, sender: principal.address, recipient, amountRaw: amount.toString(), sourceSymbol: asset.symbol, targetBlockNumber: target.blockNumber, targetBlockHash: target.blockHash, draftId });
		} finally { this.preparing.delete(principal.id); }
	}
	async cancel(id: string, principal: Principal) { this.auth.requireTbc(principal); return this.repository.cancel(id, principal.id); }
}
