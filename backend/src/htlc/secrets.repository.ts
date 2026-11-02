import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaService } from '../database/prisma.service';
import { environment } from '../config/environment';

export interface SecretRecord { version: number; network: string; lockTxid: string; owner: string; hashHex: string; ivHex: string; tagHex: string; ciphertextHex: string }
const hex32 = /^[0-9a-f]{64}$/;
export function parseSecretRecord(value: unknown): SecretRecord {
	if (!value || typeof value !== 'object') throw new Error('Invalid encrypted secret record.');
	const r = value as Record<string, unknown>;
	if (r.version !== 1 || r.network !== 'testnet' || typeof r.owner !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(r.owner) || ['lockTxid', 'hashHex', 'ciphertextHex'].some((key) => typeof r[key] !== 'string' || !hex32.test(r[key] as string)) || typeof r.ivHex !== 'string' || !/^[0-9a-f]{24}$/.test(r.ivHex) || typeof r.tagHex !== 'string' || !/^[0-9a-f]{32}$/.test(r.tagHex)) throw new Error('Invalid encrypted secret record.');
	return { version: 1, network: 'testnet', lockTxid: String(r.lockTxid), owner: r.owner, hashHex: String(r.hashHex), ivHex: r.ivHex, tagHex: r.tagHex, ciphertextHex: String(r.ciphertextHex) };
}
const aad = (r: Pick<SecretRecord, 'owner' | 'lockTxid' | 'hashHex'>) => Buffer.from(JSON.stringify(['htlc-secret-v1', 'testnet', r.owner, r.lockTxid, r.hashHex]));
export function decryptRecord(record: SecretRecord, key: Buffer) {
	const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.ivHex, 'hex'));
	cipher.setAAD(aad(record));
	cipher.setAuthTag(Buffer.from(record.tagHex, 'hex'));
	const secretHex = Buffer.concat([cipher.update(Buffer.from(record.ciphertextHex, 'hex')), cipher.final()]).toString('hex');
	if (createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex') !== record.hashHex) throw new Error('The stored secret does not match its hashlock.');
	return secretHex;
}

@Injectable()
export class SecretsRepository implements OnModuleInit {
	private key!: Buffer;
	private keyId!: string;
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	async onModuleInit() {
		this.key = await readFile(environment().keyFile);
		if (this.key.length !== 32) throw new Error('SECRET_KEY_FILE must contain the original 32-byte encryption key.');
		this.keyId = createHash('sha256').update(this.key).digest('hex');
		if (await this.db.claimSecret.count({ where: { keyId: { not: this.keyId } } })) throw new Error('The encryption key does not match existing database secrets. Restore the correct key.');
	}
	async read(lockTxid: string) {
		if (!hex32.test(lockTxid)) throw new Error('Invalid lock transaction ID.');
		const row = await this.db.claimSecret.findUnique({ where: { network_lockTxid: { network: 'testnet', lockTxid } } });
		if (!row) throw new Error('No saved secret exists for this lock. Older locks still need their original secret.');
		if (row.keyId !== this.keyId) throw new Error('Secret encryption key mismatch.');
		return parseSecretRecord(row);
	}
	async save(owner: string, lockTxid: string, hashHex: string, secretHex: string) {
		if (![lockTxid, hashHex, secretHex].every((s) => hex32.test(s)) || createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex') !== hashHex) throw new Error('The claim secret does not match the reviewed hashlock.');
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		cipher.setAAD(aad({ owner, lockTxid, hashHex }));
		const ciphertextHex = Buffer.concat([cipher.update(Buffer.from(secretHex, 'hex')), cipher.final()]).toString('hex');
		const data = { version: 1, network: 'testnet', lockTxid, owner, hashHex, ivHex: iv.toString('hex'), tagHex: cipher.getAuthTag().toString('hex'), ciphertextHex, keyId: this.keyId };
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`secret:testnet:${lockTxid}`}, 0))`;
			const existing = await tx.claimSecret.findUnique({ where: { network_lockTxid: { network: 'testnet', lockTxid } } });
			if (existing && (existing.owner !== owner || existing.hashHex !== hashHex)) throw new Error('Conflicting secret ownership or hashlock.');
			await tx.claimSecret.upsert({ where: { network_lockTxid: { network: 'testnet', lockTxid } }, create: data, update: data });
		});
	}
	async decrypt(lockTxid: string, owner: string) {
		const record = await this.read(lockTxid);
		if (record.owner !== owner) throw new Error('The sender wallet does not match this secret.');
		return { secretHex: decryptRecord(record, this.key), hashHex: record.hashHex, lockTxid };
	}
}
