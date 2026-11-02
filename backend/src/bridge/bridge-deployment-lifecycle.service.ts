import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { getContractAddress, keccak256, type Address } from 'viem';
import { deploymentBuild, deploymentData } from './bridge-build';
import type { BridgeDeploymentInput, BridgeDeploymentPreview } from '../../../shared/src/types/learningBridge';
import { AuthService, type Principal } from '../auth/auth.service';
import { BridgeDeploymentService } from './bridge-deployment.service';
import { BridgeDeploymentsRepository, deploymentRecord } from './bridge-deployments.repository';
import { BridgeDeploymentVerifier, withDeploymentRpc } from './bridge-deployment-verifier';

@Injectable()
export class BridgeDeploymentLifecycleService {
	private readonly checking = new Set<string>();
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(BridgeDeploymentService) private readonly estimates: BridgeDeploymentService,
		@Inject(BridgeDeploymentsRepository) private readonly repository: BridgeDeploymentsRepository,
		@Inject(BridgeDeploymentVerifier) private readonly verifier: BridgeDeploymentVerifier,
	) {}
	async list(principal: Principal, contractId?: string) {
		this.auth.requireTbc(principal);
		if (contractId !== undefined && !/^(?!0{64}$)[0-9a-f]{64}$/.test(contractId)) throw new BadRequestException('Invalid token contract ID.');
		return this.repository.list(principal.id, contractId);
	}
	async prepare(input: BridgeDeploymentInput, principal: Principal, response: Response) {
		const quote = await this.estimates.preview(input, principal, response);
		if (!quote.sufficientBalance) throw new BadRequestException('The deployer does not have enough test HYPE for the displayed deployment budget.');
		const data = deploymentData(quote);
		if (keccak256(data) !== quote.initCodeHash) throw new ConflictException('The build changed during estimation. Estimate again.');
		const nonce = await withDeploymentRpc(response, (client) => client.getTransactionCount({ address: quote.deployer as Address, blockTag: 'pending' }));
		if (Date.parse(quote.expiresAt) <= Date.now() || !Number.isSafeInteger(nonce)) throw new ConflictException('Preparation expired. Estimate again.');
		const predicted = getContractAddress({ from: quote.deployer as Address, nonce: BigInt(nonce) }).toLowerCase();
		if (quote.admin.toLowerCase() === predicted || quote.minter.toLowerCase() === predicted) throw new BadRequestException('Admin and Minter cannot be the contract address being created. Choose controlled wallet addresses.');
		return this.repository.create(principal.id, quote, nonce, data);
	}
	async begin(id: string, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		const row = await this.repository.owned(id, principal.id);
		if (row.status !== 'prepared' || row.expiresAt.getTime() <= Date.now() || row.buildInputSha256 !== deploymentBuild(row.quote as unknown as BridgeDeploymentPreview).build.buildInputSha256) throw new ConflictException('The saved preparation expired, was already used or belongs to an older build. Refresh its status; discard it only if no transaction was sent.');
		const quote = row.quote as unknown as BridgeDeploymentPreview;
		const fresh = await this.estimates.preview({ contractId: row.contractId, deployer: row.deployer, admin: row.admin, minter: row.minter, destinationChainId: 998, wrappedName: quote.wrappedName, wrappedSymbol: quote.wrappedSymbol }, principal, response);
		if (fresh.initCodeHash !== row.initCodeHash || !fresh.sufficientBalance || BigInt(fresh.gasLimit) > BigInt(quote.gasLimit) || BigInt(fresh.gasPriceWei) > BigInt(quote.gasPriceWei)) throw new ConflictException('The fee or balance changed beyond this preparation. Discard the unused preparation and review a new estimate.');
		const nonce = await withDeploymentRpc(response, (client) => client.getTransactionCount({ address: row.deployer as Address, blockTag: 'pending' }));
		if (BigInt(nonce) !== row.nonce) throw new ConflictException('The deployer nonce changed. Check MetaMask activity before preparing another deployment.');
		await this.repository.begin(row);
		return { id: row.id, transaction: {
			from: row.deployer, chainId: '0x3e6', data: row.transactionData, value: '0x0',
			gas: `0x${BigInt(quote.gasLimit).toString(16)}`, gasPrice: `0x${BigInt(quote.gasPriceWei).toString(16)}`, nonce: `0x${row.nonce.toString(16)}`,
		} };
	}
	async cancel(id: string, principal: Principal) { this.auth.requireTbc(principal); return this.repository.cancel(id, principal.id); }
	async submit(id: string, hash: string, principal: Principal) { this.auth.requireTbc(principal); return this.repository.attach(id, principal.id, hash.toLowerCase()); }
	async check(id: string, principal: Principal, response: Response) {
		this.auth.requireTbc(principal);
		const row = await this.repository.owned(id, principal.id);
		if (!row.txHash) return deploymentRecord(row);
		if (this.checking.has(id) || this.checking.size >= 4) throw new ConflictException('A deployment status check is already running. Wait, then refresh.');
		this.checking.add(id);
		try {
			const observation = await this.verifier.check(row, response);
			return await this.repository.observe(row, observation);
		} catch {
			return this.repository.observe(row, { lastError: 'Status unavailable. The last saved result is retained; refresh to verify the transaction again.', checkedAt: new Date() });
		} finally { this.checking.delete(id); }
	}
}
