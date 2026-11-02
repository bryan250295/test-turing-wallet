import { GatewayTimeoutException, HttpException, Inject, Injectable, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, type Principal } from '../auth/auth.service';
import { bridgeRouteId } from '../../../shared/src/config/bridgeRoutes';
import { BRIDGE_ASSET_POLICY as policy } from './bridge.config';
import { BridgeAssetVerifier } from './bridge-asset.verifier';
import { BridgeRepository } from './bridge.repository';

@Injectable()
export class BridgeService {
	private verifying = false;
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(BridgeAssetVerifier) private readonly verifier: BridgeAssetVerifier,
		@Inject(BridgeRepository) private readonly repository: BridgeRepository,
	) {}
	private route(contractId: string) {
		try { return bridgeRouteId(contractId.toLowerCase()); }
		catch { throw new BadRequestException('Choose a valid source token contract ID.'); }
	}
	async get(contractId: string, principal: Principal) {
		this.auth.requireTbc(principal);
		return this.repository.get(this.route(contractId));
	}
	async verify(contractId: string, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		this.route(contractId);
		return this.verifyConfiguredAsset(principal.id, response, contractId.toLowerCase());
	}
	// Operator CLI uses the same verifier and repository. It cannot select an RPC,
	// approve another asset or mint tokens, and never opens a wallet prompt.
	async verifyConfiguredAsset(identityId?: string, response?: Response, contractId: string = policy.contractId) {
		if (this.verifying) throw new HttpException('Asset verification is already running. Try again when it finishes.', 429);
		this.verifying = true;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new DOMException('Asset verification timed out.', 'TimeoutError')), 45000);
		timer.unref();
		const cancel = () => { if (!response?.writableEnded) controller.abort(new DOMException('Client disconnected.', 'AbortError')); };
		response?.once('close', cancel);
		try {
			const asset = await this.verifier.verify(controller.signal, contractId);
			controller.signal.throwIfAborted();
			return await this.repository.save(asset, identityId);
		} catch (cause) {
			if (controller.signal.aborted) throw new GatewayTimeoutException('Verification did not finish. No deployment or transfer was submitted; reconnect and retry when ready.');
			throw cause;
		} finally {
			this.verifying = false;
			clearTimeout(timer);
			controller.abort();
			response?.removeListener('close', cancel);
		}
	}
}
