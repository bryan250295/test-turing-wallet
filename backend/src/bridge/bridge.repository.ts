import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { BridgeAsset } from '../../generated/prisma/client';
import type { VerifiedBridgeAsset } from '../../../shared/src/types/learningBridge';
import { PrismaService } from '../database/prisma.service';

function publicAsset(row: BridgeAsset): VerifiedBridgeAsset {
	return {
		routeId: row.routeId, sourceNetwork: 'testnet', protocol: 'legacy-ft',
		contractId: row.contractId, name: row.name, symbol: row.symbol, decimals: row.decimals,
		legacyVersion: row.legacyVersion, totalSupplyRaw: row.totalSupplyRaw.toFixed(0),
		genesisCodeHash: row.genesisCodeHash, genesisTapeHash: row.genesisTapeHash,
		mintSourceTxid: row.mintSourceTxid, mintSourceVout: row.mintSourceVout,
		genesisBlockHash: row.genesisBlockHash, genesisBlockHeight: row.genesisBlockHeight,
		confirmations: row.confirmations, destinationChainId: 998,
		verificationMethod: row.verificationMethod, verifiedAt: row.verifiedAt.toISOString(),
	};
}

@Injectable()
export class BridgeRepository {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	async get(routeId: string) {
		const row = await this.db.bridgeAsset.findUnique({ where: { routeId } });
		return row ? publicAsset(row) : null;
	}
	async save(asset: VerifiedBridgeAsset, identityId?: string) {
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-asset:${asset.routeId}`}, 0))`;
			const existing = await tx.bridgeAsset.findUnique({ where: { routeId: asset.routeId } });
			if (existing) {
				const previous = publicAsset(existing);
				const immutable = Object.keys(asset).filter((field) => !['verifiedAt', 'confirmations'].includes(field)) as (keyof VerifiedBridgeAsset)[];
				if (immutable.some((field) => previous[field] !== asset[field])) throw new ConflictException('The saved bridge asset differs from its verified chain identity. Review the route configuration before continuing.');
				if (existing.verifiedAt > new Date(asset.verifiedAt)) return previous;
			}
			const row = await tx.bridgeAsset.upsert({
				where: { routeId: asset.routeId },
				create: { ...asset, verifiedAt: new Date(asset.verifiedAt) },
				update: { verifiedAt: new Date(asset.verifiedAt), confirmations: asset.confirmations },
			});
			await tx.auditEvent.create({ data: {
				identityId, action: 'bridge.asset.verified',
				data: { routeId: asset.routeId, contractId: asset.contractId, verificationMethod: asset.verificationMethod },
			} });
			return publicAsset(row);
		});
	}
}
