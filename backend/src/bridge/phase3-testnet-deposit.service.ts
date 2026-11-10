import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../auth/auth.service';
import type { Phase3TestnetDepositTerms } from '../../../shared/src/types/phase3TestnetDeposit';
import { getErrorMessage } from '../../../shared/src/utils/errors';
import {
	buildUnsignedPhase3TestnetDeposit, broadcastPhase3Deposit, finalizePhase3Deposit,
	phase3DepositEvidence, phase3DepositSigningRequest,
} from './phase3/testnet-deposit-engine';
import { ProofBridgeV3Repository } from './proof-bridge-v3.repository';
import { ProofBridgeV3ProgressService } from './proof-bridge-v3-progress.service';

@Injectable()
export class Phase3TestnetDepositService {
	private readonly active = new Set<string>();
	constructor(
		@Inject(ProofBridgeV3Repository) private readonly repository: ProofBridgeV3Repository,
		@Inject(ProofBridgeV3ProgressService) private readonly progress: ProofBridgeV3ProgressService,
	) {}
	private requireOwner(principal: Principal, sender?: string) {
		if (principal.chain !== 'tbc' || principal.network !== 'testnet') throw new ForbiddenException('Sign in with TBC Testnet first.');
		if (sender !== undefined && sender !== principal.address) throw new ForbiddenException('The V3 deposit sender differs from the signed-in wallet.');
		return principal.address;
	}
	private async run<T>(key: string, operation: () => Promise<T>) {
		if (this.active.has(key)) throw new BadRequestException('This V3 deposit operation is already in progress.');
		this.active.add(key);
		try { return await operation(); }
		catch (cause) { throw new BadRequestException(getErrorMessage(cause)); }
		finally { this.active.delete(key); }
	}
	async build(principal: Principal, terms: Phase3TestnetDepositTerms) {
		const owner = this.requireOwner(principal, terms.sender);
		const route = await this.repository.route();
		if (!route || route.status !== 'verified') throw new ConflictException('Deploy and register the verified Testnet-v3 route first.');
		if (await this.repository.hasActive(principal.id)) throw new ConflictException('Wait for the active V3 transfer to complete before building another deposit.');
		return this.run(`build:${owner}`, () => buildUnsignedPhase3TestnetDeposit(owner, terms, { destinationGateway: route.gateway as `0x${string}`, reserveController: route.reserveController as `0x${string}` }, AbortSignal.timeout(90_000)));
	}
	signing(principal: Principal, buildId: string) {
		const owner = this.requireOwner(principal);
		return this.run(buildId, () => phase3DepositSigningRequest(owner, buildId, AbortSignal.timeout(90_000)));
	}
	finalize(principal: Principal, buildId: string, publicKey: string, signatures: string[]) {
		const owner = this.requireOwner(principal);
		return this.run(buildId, async () => {
			const signal = AbortSignal.timeout(90_000);
			const result = await finalizePhase3Deposit(owner, buildId, publicKey, signatures, signal);
			await this.repository.createSigned(principal.id, phase3DepositEvidence(owner, buildId));
			// Persist the exact, consented TXID as automation-visible before the
			// external POST. If the process stops in the tiny interval below, the
			// observer still checks this immutable TXID and never creates a second
			// source transaction or silently spends a replacement input.
			await this.repository.markSourceSubmitted(principal.id, buildId);
			// The wallet signature is the user's final consent. Submit this exact,
			// locally verified transaction once before returning so a browser/network
			// interruption cannot strand the flow between Finalize and Broadcast.
			try {
				const submission = await broadcastPhase3Deposit(owner, buildId, false, signal);
				if (submission.status === 'rejected') await this.repository.markNeedsReview(principal.id, buildId, submission.message);
			} catch (cause) {
				await this.repository.markNeedsReview(principal.id, buildId, getErrorMessage(cause));
				await this.progress.publish(principal.id);
				throw cause;
			}
			await this.progress.publish(principal.id);
			return result;
		});
	}
	broadcast(principal: Principal, buildId: string, checkOnly: boolean) {
		const owner = this.requireOwner(principal);
		return this.run(buildId, async () => {
			const result = await broadcastPhase3Deposit(owner, buildId, checkOnly, AbortSignal.timeout(90_000));
			if (result.status === 'submitted' || result.status === 'unknown') await this.repository.markSourceSubmitted(principal.id, buildId);
			await this.progress.publish(principal.id);
			return result;
		});
	}
}
