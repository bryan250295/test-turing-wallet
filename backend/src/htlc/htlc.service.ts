import { BadRequestException, ForbiddenException, GatewayTimeoutException, HttpException, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, type Principal } from '../auth/auth.service';
import { HtlcRepository } from './htlc.repository';
import { SecretsRepository } from './secrets.repository';
import { engineStorage } from './engine/storage-context';
import { executeHtlcRequest } from './engine/dispatch';
import { HtlcQueueFullError, HtlcRequestQueue, untilAborted } from './engine/requestQueue';
import { getErrorMessage } from '../../../shared/src/utils/errors';
import { API_URLS } from '../../../shared/src/config/constants';
import { parseHtlcRequest } from '../../../shared/src/utils/htlcRequestHistory';

@Injectable()
export class HtlcService {
	private readonly queue = new HtlcRequestQueue(2, 8);
	private readonly builds = new Set<string>();
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(HtlcRepository) private readonly requests: HtlcRepository, @Inject(SecretsRepository) private readonly secrets: SecretsRepository) {}
	async execute(endpoint: string, payload: unknown, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		const fields = Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([, value]) => value !== undefined));
		payload = fields;
		if (endpoint === API_URLS.unsignedTokenHtlc && fields.sender !== principal.address || endpoint === API_URLS.htlcWalletStatus && fields.address !== principal.address) throw new ForbiddenException('The requested wallet does not match your login session.');
		const buildId = typeof fields.buildId === 'string' ? fields.buildId : undefined;
		if (buildId && this.builds.has(buildId)) throw new BadRequestException('This signing session already has an operation in progress.');
		if (buildId) this.builds.add(buildId);
		const controller = new AbortController();
		const deadline = Date.now() + 90000;
		const timer = setTimeout(() => controller.abort(new DOMException('The HTLC request timed out. Check submission status before retrying.', 'TimeoutError')), 90000);
		timer.unref();
		const cancel = () => { if (!response.writableEnded) controller.abort(new DOMException('Client disconnected.', 'AbortError')); };
		response.once('close', cancel);
		let release: (() => void) | undefined;
		try {
			release = await this.queue.acquire(controller.signal);
			return await engineStorage.run({ owner: principal.address, requests: this.requests, secrets: this.secrets }, () => untilAborted(executeHtlcRequest(endpoint, payload, controller.signal, deadline), controller.signal));
		} catch (cause) {
			if (cause instanceof HtlcQueueFullError) throw new HttpException('The service queue is full. Try again shortly.', 429);
			if (controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError') throw new GatewayTimeoutException('The operation timed out. Check submission status before retrying.');
			throw new BadRequestException(getErrorMessage(cause));
		} finally {
			release?.();
			clearTimeout(timer);
			response.removeListener('close', cancel);
			if (buildId) this.builds.delete(buildId);
		}
	}
	async list(address: string, principal: Principal) {
		this.auth.requireTbc(principal);
		if (address !== principal.address) throw new ForbiddenException('You can only list requests involving your authenticated wallet.');
		return this.requests.list(address);
	}
	async get(lockTxid: string, principal: Principal) {
		this.auth.requireTbc(principal);
		if (!/^[0-9a-f]{64}$/.test(lockTxid)) throw new BadRequestException('Invalid lock transaction ID.');
		const record = await this.requests.get(lockTxid);
		if (record && record.sender !== principal.address && record.receiver !== principal.address) throw new ForbiddenException('This request belongs to other wallets.');
		return record;
	}
	async importBrowserRecord(value: unknown, principal: Principal, response: Response) {
		let record;
		try { record = parseHtlcRequest(value); }
		catch { throw new BadRequestException('Invalid HTLC request metadata.'); }
		if (record.sender !== principal.address && record.receiver !== principal.address) throw new ForbiddenException('This record does not involve your wallet.');
		// Browser metadata is a discovery hint only. Rebuild it from verified chain data.
		await this.execute(API_URLS.inspectTokenHtlc, { lockTxid: record.lockTxid, contractId: record.contractId, recoveryTxids: record.recoveries.map((item) => item.txid) }, principal, response);
		return this.requests.get(record.lockTxid);
	}
	async secretChallenge(lockTxid: string, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		const record = await this.secrets.read(lockTxid);
		if (record.owner !== principal.address) throw new ForbiddenException('Only the original sender can retrieve this secret.');
		return this.auth.challenge({ chain: 'tbc', network: 'testnet', address: principal.address }, response, 'reveal', lockTxid, principal.tokenHash);
	}
	async reveal(challengeId: string, signature: string, principal: Principal) {
		this.auth.requireTbc(principal);
		const challenge = await this.auth.consume(challengeId, signature, 'reveal', principal.tokenHash);
		if (challenge.address !== principal.address || !challenge.lockTxid) throw new ForbiddenException('Secret challenge ownership mismatch.');
		return this.secrets.decrypt(challenge.lockTxid, principal.address);
	}
}
