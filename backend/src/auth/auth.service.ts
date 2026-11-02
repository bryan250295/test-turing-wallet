import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import tbc from 'tbc-lib-js';
import { verifyMessage, getAddress } from 'viem';
import type { Request, Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { environment } from '../config/environment';
import { validateHtlcAddress } from '../../../shared/src/utils/htlcTokenLock';
import type { LoginChallengeDto } from './auth.dto';

export const SESSION_COOKIE = 'bridge_session';
export const CHALLENGE_COOKIE = 'bridge_challenge';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface Principal { id: string; chain: string; network: string; address: string; role: string; tokenHash: string; csrfToken: string }
export interface AuthenticatedRequest extends Request { principal: Principal; requestId?: string }
export const cookieOptions = () => ({ httpOnly: true, secure: environment().secureCookies, sameSite: 'strict' as const, path: '/' });

@Injectable()
export class AuthService {
	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
	async challenge(input: LoginChallengeDto, response: Response, purpose = 'login', lockTxid?: string, sessionHash?: string) {
		let address = input.address;
		if (input.chain === 'tbc' && input.network === 'testnet') await validateHtlcAddress(address);
		else if (input.chain === 'evm' && input.network === '998') {
			try { address = getAddress(address).toLowerCase(); } catch { throw new BadRequestException('Invalid EVM address.'); }
		} else throw new BadRequestException('Only TBC Testnet and HyperEVM Testnet are supported.');
		const origin = environment().origin;
		const expiresAt = new Date(Date.now() + 180000);
		const binding = randomBytes(32).toString('hex');
		const nonce = randomBytes(32).toString('hex');
		const message = purpose === 'reveal'
			? ['Reveal my saved TBC Testnet claim secret', `Origin: ${origin}`, `Sender: ${address}`, `Lock TXID: ${lockTxid}`, `Nonce: ${nonce}`, `Expires: ${expiresAt.toISOString()}`, 'This signature authorizes one secret retrieval. It does not send a transaction.'].join('\n')
			: ['Sign in to Learning Bridge', `Origin: ${origin}`, `Chain: ${input.chain}`, `Network: ${input.network}`, `Address: ${address}`, `Nonce: ${nonce}`, `Expires: ${expiresAt.toISOString()}`, 'This signature creates a temporary login session. It does not send a transaction.'].join('\n');
		// Prune expired authentication state; no pending challenge survives beyond its TTL.
		await this.db.$transaction([
			this.db.authChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
			this.db.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
		]);
		const row = await this.db.authChallenge.create({ data: { chain: input.chain, network: input.network, address, purpose, lockTxid, origin, message, expiresAt, bindingHash: digest(purpose === 'reveal' ? sessionHash! : binding) } });
		if (purpose === 'login') response.cookie(CHALLENGE_COOKIE, binding, { ...cookieOptions(), maxAge: 180000 });
		return { challengeId: row.id, message, address, owner: address, lockTxid, chain: input.chain, network: input.network, expiresAt: expiresAt.toISOString() };
	}
	async consume(challengeId: string, signature: string, purpose: string, binding: string) {
		const row = await this.db.authChallenge.findUnique({ where: { id: challengeId } });
		if (!row || row.purpose !== purpose || row.expiresAt <= new Date() || row.consumedAt || row.bindingHash !== digest(binding) || row.origin !== environment().origin) throw new UnauthorizedException('The ownership challenge expired or does not match this browser.');
		const consumed = await this.db.authChallenge.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
		if (consumed.count !== 1) throw new UnauthorizedException('This challenge has already been used.');
		let valid = false;
		try {
			valid = row.chain === 'tbc'
				? tbc.Message.verify(Buffer.from(row.message, 'utf8'), row.address, signature)
				: await verifyMessage({ address: row.address as `0x${string}`, message: row.message, signature: signature as `0x${string}` });
		} catch { /* Invalid encodings fail closed. Never log signature bodies. */ }
		if (!valid) throw new UnauthorizedException('Wallet ownership could not be verified. Request a new challenge.');
		return row;
	}
	async login(challengeId: string, signature: string, request: Request, response: Response) {
		const binding = request.cookies?.[CHALLENGE_COOKIE];
		if (typeof binding !== 'string' || !/^[0-9a-f]{64}$/.test(binding)) throw new UnauthorizedException('Request a login challenge in this browser first.');
		const challenge = await this.consume(challengeId, signature, 'login', binding);
		const token = randomBytes(32).toString('hex');
		const expiresAt = new Date(Date.now() + environment().sessionHours * 3600000);
		const csrfToken = randomBytes(32).toString('hex');
		const identity = await this.db.$transaction(async (tx) => {
			const identity = await tx.walletIdentity.upsert({ where: { chain_network_address: { chain: challenge.chain, network: challenge.network, address: challenge.address } }, create: { chain: challenge.chain, network: challenge.network, address: challenge.address }, update: {} });
			const previous = request.cookies?.[SESSION_COOKIE];
			if (typeof previous === 'string') await tx.authSession.deleteMany({ where: { tokenHash: digest(previous) } });
			await tx.authSession.create({ data: { tokenHash: digest(token), identityId: identity.id, csrfToken, expiresAt } });
			return identity;
		});
		response.clearCookie(CHALLENGE_COOKIE, cookieOptions());
		response.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: environment().sessionHours * 3600000 });
		return { identity: { id: identity.id, chain: identity.chain, network: identity.network, address: identity.address, role: identity.role }, csrfToken, expiresAt: expiresAt.toISOString() };
	}
	async session(request: Request): Promise<(Principal & { expiresAt: Date }) | null> {
		const token = request.cookies?.[SESSION_COOKIE];
		if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
		const row = await this.db.authSession.findUnique({ where: { tokenHash: digest(token) }, include: { identity: true } });
		if (!row || row.expiresAt <= new Date()) return null;
		return { ...row.identity, tokenHash: row.tokenHash, csrfToken: row.csrfToken, expiresAt: row.expiresAt };
	}
	async logout(principal: Principal, response: Response) {
		await this.db.authSession.deleteMany({ where: { tokenHash: principal.tokenHash } });
		response.clearCookie(SESSION_COOKIE, cookieOptions());
		return { signedOut: true };
	}
	requireTbc(principal: Principal) {
		if (principal.chain !== 'tbc' || principal.network !== 'testnet') throw new ForbiddenException('Sign in with your TBC Testnet wallet to continue.');
	}
}
