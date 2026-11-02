import { Inject, Injectable, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import tbc from 'tbc-lib-js';
import { environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import type { BridgeCustody, BridgeOrder } from '../../generated/prisma/client';

export interface EncryptedBridgeCustody {
	network: 'testnet'; address: string; publicKeyHex: string;
	addressFormat: 'tbc-p2pkh-pubkeyhash00-compressed'; version: 1;
	keyId: string; ivHex: string; tagHex: string; ciphertextHex: string;
}

@Injectable()
export class BridgeCustodyService implements OnModuleDestroy {
	private master?: Buffer;
	private keyId?: string;
	private loading?: Promise<void>;
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	private async load() {
		if (!this.master) {
			this.loading ??= (async () => {
				const key = await readFile(environment().custodyKeyFile);
				if (key.length !== 32) { key.fill(0); throw new Error('Invalid custody key.'); }
				this.master = key;
				this.keyId = createHash('sha256').update(key).digest('hex');
			})();
			try { await this.loading; } finally { this.loading = undefined; }
		}
		if (await this.db.bridgeCustody.count({ where: { keyId: { not: this.keyId! } } })) throw new Error('Custody key mismatch.');
	}
	async ready(): Promise<boolean> {
		try { await this.load(); return true; } catch { return false; }
	}
	async assertRecoverable(order: BridgeOrder, record: BridgeCustody) { await this.withKey(order, record, () => undefined); }
	// Internal signing callback only. The release service must prove a confirmed
	// exact escrow lock and immutable reserved plan before entering this method.
	async signRelease(order: BridgeOrder, record: BridgeCustody, planHash: string, sign: (key: tbc.PrivateKey) => { raw: string; txid: string }) {
		if (!/^[0-9a-f]{64}$/.test(planHash)) throw new Error('Invalid release plan binding.');
		return this.withKey(order, record, sign);
	}
	private async withKey<T>(order: BridgeOrder, record: BridgeCustody, operation: (key: tbc.PrivateKey) => T): Promise<T> {
		let recoveredKey: tbc.PrivateKey | undefined;
		try {
			await this.load();
			if (record.keyId !== this.keyId || record.version !== 1 || record.network !== 'testnet' || record.orderId !== order.id || record.addressFormat !== 'tbc-p2pkh-pubkeyhash00-compressed') throw new Error('Unsupported custody record.');
			const key = Buffer.from(hkdfSync('sha256', this.master!, Buffer.from(order.id), Buffer.from('learning-bridge/custody/testnet/v1'), 32));
			try {
				const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.ivHex, 'hex'));
				decipher.setAAD(Buffer.from(JSON.stringify(['learning-bridge-custody-v1', 'testnet', order.identityId, order.id, order.termsHash, record.address, record.publicKeyHex])));
				decipher.setAuthTag(Buffer.from(record.tagHex, 'hex'));
				const raw = Buffer.concat([decipher.update(Buffer.from(record.ciphertextHex, 'hex')), decipher.final()]);
				const encoded = Buffer.alloc(34);
				try {
					if (raw.length !== 32) throw new Error('Invalid scalar.');
					encoded[0] = 0x80; raw.copy(encoded, 1); encoded[33] = 1;
					const restored = tbc.PrivateKey.fromBuffer(encoded, 'livenet');
					if (restored.toAddress('livenet').toString() !== record.address || restored.toPublicKey().toString() !== record.publicKeyHex) throw new Error('Custody recovery mismatch.');
					recoveredKey = restored;
				} finally { raw.fill(0); encoded.fill(0); }
			} finally { key.fill(0); }
		} catch { throw new ServiceUnavailableException('The saved custody key cannot be authenticated. Restore the matching encryption key before opening payment details.'); }
		return operation(recoveredKey!);
	}
	async allocate(identityId: string, orderId: string, termsHash: string): Promise<EncryptedBridgeCustody> {
		try {
			await this.load();
			// The dedicated tbcdev network uses 0x00 P2PKH address encoding, just as
			// Turing Wallet. SDK "livenet" here selects encoding, never a mainnet RPC.
			const privateKey = tbc.PrivateKey.fromRandom('livenet');
			const raw = privateKey.toBuffer();
			const address = privateKey.toAddress('livenet').toString();
			const publicKeyHex = privateKey.toPublicKey().toString();
			const aad = Buffer.from(JSON.stringify(['learning-bridge-custody-v1', 'testnet', identityId, orderId, termsHash, address, publicKeyHex]));
			const derived = Buffer.from(hkdfSync('sha256', this.master!, Buffer.from(orderId), Buffer.from('learning-bridge/custody/testnet/v1'), 32));
			const iv = randomBytes(12);
			try {
				const cipher = createCipheriv('aes-256-gcm', derived, iv);
				cipher.setAAD(aad);
				const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
				const tag = cipher.getAuthTag();
				// Verify recoverability before the order/address is committed. Only the
				// encrypted record is returned; no WIF/private key has an HTTP route.
				const decipher = createDecipheriv('aes-256-gcm', derived, iv);
				decipher.setAAD(aad); decipher.setAuthTag(tag);
				const recovered = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
				// This SDK restores a bare 32-byte scalar as an UNCOMPRESSED key.
				// Preserve the compressed flag explicitly in its binary key encoding;
				// otherwise recovery would derive a different P2PKH address.
				const encoded = Buffer.alloc(34);
				encoded[0] = 0x80; recovered.copy(encoded, 1); encoded[33] = 1;
				try {
					const restored = tbc.PrivateKey.fromBuffer(encoded, 'livenet');
					if (!raw.equals(recovered) || !restored.compressed || restored.toPublicKey().toString() !== publicKeyHex || restored.toAddress('livenet').toString() !== address) throw new Error('Custody recovery mismatch.');
				} finally { recovered.fill(0); encoded.fill(0); }
				return { network: 'testnet', address, publicKeyHex, addressFormat: 'tbc-p2pkh-pubkeyhash00-compressed', version: 1, keyId: this.keyId!, ivHex: iv.toString('hex'), tagHex: tag.toString('hex'), ciphertextHex: ciphertext.toString('hex') };
			} finally { raw.fill(0); derived.fill(0); }
		} catch { throw new ServiceUnavailableException('Bridge custody is unavailable. Restore the configured custody encryption key before preparing orders.'); }
	}
	onModuleDestroy() { this.master?.fill(0); }
}
