import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Principal } from '../auth/auth.service';
import type { Phase3TestnetDepositTerms } from '../../../shared/src/types/phase3TestnetDeposit';
import { getErrorMessage } from '../../../shared/src/utils/errors';
import {
	buildUnsignedPhase3TestnetDeposit, broadcastPhase3Deposit, finalizePhase3Deposit,
	phase3DepositSigningRequest,
} from './phase3/testnet-deposit-engine';

@Injectable()
export class Phase3TestnetDepositService {
	private readonly active = new Set<string>();
	private requireOwner(principal: Principal, sender?: string) {
		if (principal.chain !== 'tbc' || principal.network !== 'testnet') throw new ForbiddenException('Sign in with TBC Testnet first.');
		if (sender !== undefined && sender !== principal.address) throw new ForbiddenException('The v2 deposit sender differs from the signed-in wallet.');
		return principal.address;
	}
	private async run<T>(key: string, operation: () => Promise<T>) {
		if (this.active.has(key)) throw new BadRequestException('This v2 deposit operation is already in progress.');
		this.active.add(key);
		try { return await operation(); }
		catch (cause) { throw new BadRequestException(getErrorMessage(cause)); }
		finally { this.active.delete(key); }
	}
	build(principal: Principal, terms: Phase3TestnetDepositTerms) {
		const owner = this.requireOwner(principal, terms.sender);
		return this.run(`build:${owner}`, () => buildUnsignedPhase3TestnetDeposit(owner, terms, AbortSignal.timeout(90_000)));
	}
	signing(principal: Principal, buildId: string) {
		const owner = this.requireOwner(principal);
		return this.run(buildId, () => phase3DepositSigningRequest(owner, buildId, AbortSignal.timeout(90_000)));
	}
	finalize(principal: Principal, buildId: string, publicKey: string, signatures: string[]) {
		const owner = this.requireOwner(principal);
		return this.run(buildId, () => finalizePhase3Deposit(owner, buildId, publicKey, signatures, AbortSignal.timeout(90_000)));
	}
	broadcast(principal: Principal, buildId: string, checkOnly: boolean) {
		const owner = this.requireOwner(principal);
		return this.run(buildId, () => broadcastPhase3Deposit(owner, buildId, checkOnly, AbortSignal.timeout(90_000)));
	}
}
