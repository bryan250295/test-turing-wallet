import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type HtlcRequest as RequestRow, type HtlcRecovery } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { mergeHtlcRequest, parseHtlcRequest, type HtlcRequest } from '../../../shared/src/utils/htlcRequestHistory';
import type { TokenHtlcLock } from '../../../shared/src/types/htlc';

export function requestRecord(row: RequestRow & { recoveries: HtlcRecovery[] }): HtlcRequest {
	return parseHtlcRequest({ ...row, amountRaw: row.amountRaw.toFixed(0), refundTimestamp: Number(row.refundTimestamp), tokenName: row.tokenName ?? undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), recoveries: row.recoveries });
}

export async function writeRequest(tx: Prisma.TransactionClient, value: HtlcRequest, source: string, preserveTimestamp = false) {
	const id = { network: 'testnet', lockTxid: value.lockTxid };
	// Serialize merge operations across API requests and processes, including first insertion.
	await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`htlc:testnet:${value.lockTxid}`}, 0))`;
	const row = await tx.htlcRequest.findUnique({ where: { network_lockTxid: id }, include: { recoveries: { orderBy: { createdAt: 'asc' } } } });
	const next = mergeHtlcRequest(row ? requestRecord(row) : undefined, value);
	if (row && row.source !== 'legacy_import' && (row.sender !== next.sender || row.receiver !== next.receiver || row.amountRaw.toFixed(0) !== BigInt(next.amountRaw).toString() || row.decimals !== next.decimals || Number(row.refundTimestamp) !== next.refundTimestamp)) throw new Error('Conflicting immutable HTLC terms.');
	const data = { contractId: next.contractId, sender: next.sender, receiver: next.receiver, amountRaw: new Prisma.Decimal(next.amountRaw), decimals: next.decimals, symbol: next.symbol, tokenName: next.tokenName ?? null, refundTimestamp: BigInt(next.refundTimestamp), submission: next.submission ?? null, source, createdAt: new Date(next.createdAt), updatedAt: preserveTimestamp ? new Date(next.updatedAt) : new Date() };
	await tx.htlcRequest.upsert({ where: { network_lockTxid: id }, create: { ...id, ...data }, update: data });
	for (const item of next.recoveries) await tx.htlcRecovery.upsert({ where: { network_lockTxid_txid: { ...id, txid: item.txid } }, create: { ...id, ...item }, update: { action: item.action, submission: item.submission ?? null } });
	const saved = await tx.htlcRequest.findUniqueOrThrow({ where: { network_lockTxid: id }, include: { recoveries: { orderBy: { createdAt: 'asc' } } } });
	return requestRecord(saved);
}

@Injectable()
export class HtlcRepository {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	save(value: unknown) { return this.db.$transaction((tx) => writeRequest(tx, parseHtlcRequest(value), 'backend'), { timeout: 15000 }); }
	async list(address: string) {
		const rows = await this.db.htlcRequest.findMany({ where: { network: 'testnet', OR: [{ sender: address }, { receiver: address }] }, orderBy: [{ createdAt: 'desc' }, { lockTxid: 'asc' }], include: { recoveries: { orderBy: { createdAt: 'asc' } } } });
		return rows.map(requestRecord);
	}
	async get(lockTxid: string) {
		const row = await this.db.htlcRequest.findUnique({ where: { network_lockTxid: { network: 'testnet', lockTxid } }, include: { recoveries: { orderBy: { createdAt: 'asc' } } } });
		return row ? requestRecord(row) : undefined;
	}
	async observation(lockTxid: string, lock?: TokenHtlcLock, error?: string) {
		const id = { network: 'testnet', lockTxid };
		const exists = await this.db.htlcRequest.findUnique({ where: { network_lockTxid: id }, select: { lockTxid: true } });
		if (!exists) return;
		const data = { attemptedAt: new Date(), lastError: error?.slice(0, 1000) ?? null, ...(lock ? { lastResult: JSON.parse(JSON.stringify(lock)) as Prisma.InputJsonObject, checkedAt: new Date(lock.checkedAt) } : {}) };
		await this.db.htlcObservation.upsert({ where: { network_lockTxid: id }, create: { ...id, ...data }, update: data });
	}
	async previousObservation(lockTxid: string) {
		const row = await this.db.htlcObservation.findUnique({ where: { network_lockTxid: { network: 'testnet', lockTxid } } });
		return row?.lastResult ? row.lastResult as unknown as TokenHtlcLock : undefined;
	}
}
