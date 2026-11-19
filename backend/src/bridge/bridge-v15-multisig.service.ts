import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { decodeEventLog, encodeAbiParameters, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, keccak256, parseAbi, parseAbiParameters, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { BRIDGE_ADMIN_MULTISIG_BUILD as build, BRIDGE_ADMIN_MULTISIG_RUNTIME as runtime } from '../../../shared/src/contracts/bridgeAdminMultisig';
import { LEARNING_BRIDGE_EVM as network } from '../../../shared/src/config/learningBridge';
import type { BridgeCallTransaction, BridgeDeploymentPreview, BridgeDeploymentTransaction, V15ActivationKind, V15ActivationPreview, V15ActivationState, V15ActivationStatus, V15MultisigDeploymentPreview, V15MultisigDeploymentStatus } from '../../../shared/src/types/learningBridge';
import { AuthService, type Principal } from '../auth/auth.service';
import { v15OperatorRoles } from './bridge.config';
import { normalizedRuntime, withDeploymentRpc } from './bridge-deployment-verifier';
import { BridgeDeploymentsRepository } from './bridge-deployments.repository';
import { BridgeOrderTargetService } from './bridge-order-target.service';

const readAbi = parseAbi([
	'function signer1() view returns (address)',
	'function signer2() view returns (address)',
	'function threshold() view returns (uint256)',
	'function TARGET_CHAIN_ID() view returns (uint256)',
	'function nonce() view returns (uint256)',
	'function action(bytes32 actionId) view returns (address target, bytes data, bool executed)',
	'function approved(bytes32 actionId, address signer) view returns (bool)',
]);
const adminAbi = parseAbi([
	'function propose(address target, bytes data) returns (bytes32 actionId)',
	'function approveAndExecute(bytes32 actionId) returns (bytes returnData)',
	'event ActionProposed(bytes32 indexed actionId, address indexed proposer, address indexed target, bytes data)',
	'event ActionApproved(bytes32 indexed actionId, address indexed signer)',
	'event ActionExecuted(bytes32 indexed actionId, address indexed target)',
]);
const wrappedAbi = parseAbi(['function unpause()', 'function paused() view returns (bool)']);
const unpauseData = encodeFunctionData({ abi: wrappedAbi, functionName: 'unpause' });

function creationData() {
	const roles = v15OperatorRoles();
	return encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [roles.signer1 as Address, roles.signer2 as Address] });
}

@Injectable()
export class BridgeV15MultisigService {
	constructor(
		@Inject(AuthService) private readonly auth: AuthService,
		@Inject(BridgeDeploymentsRepository) private readonly deployments: BridgeDeploymentsRepository,
		@Inject(BridgeOrderTargetService) private readonly target: BridgeOrderTargetService,
	) {}

	roles(principal: Principal) {
		this.auth.requireTbc(principal);
		return v15OperatorRoles();
	}

	async preview(deployerValue: string, principal: Principal, response: Response): Promise<V15MultisigDeploymentPreview> {
		this.auth.requireTbc(principal);
		const deployer = getAddress(deployerValue);
		const roles = v15OperatorRoles();
		const data = creationData();
		return withDeploymentRpc(response, async (client) => {
			const block = await client.getBlock({ blockTag: 'latest' });
			if (block.number === null) throw new BadRequestException('HyperEVM did not return a confirmed block.');
			const [balance, gasPrice, deployerCode, signer1Code, signer2Code, minterCode, nonce, gas] = await Promise.all([
				client.getBalance({ address: deployer, blockNumber: block.number }),
				client.getGasPrice(),
				client.getCode({ address: deployer, blockNumber: block.number }),
				client.getCode({ address: roles.signer1 as Address, blockNumber: block.number }),
				client.getCode({ address: roles.signer2 as Address, blockNumber: block.number }),
				client.getCode({ address: roles.minter as Address, blockNumber: block.number }),
				client.getTransactionCount({ address: deployer, blockTag: 'pending' }),
				client.estimateGas({ account: deployer, data, value: 0n, blockNumber: block.number, prepare: false }),
			]);
			if ([deployerCode, signer1Code, signer2Code, minterCode].some((code) => code && code !== '0x')) throw new BadRequestException('The deployer, both configured signers and the minter must be ordinary MetaMask accounts.');
			const gasLimit = (gas * BigInt(100 + network.gasBufferPercent) + 99n) / 100n;
			const bufferedFee = gasLimit * gasPrice;
			const predictedAddress = getContractAddress({ from: deployer, nonce: BigInt(nonce) });
			const transaction: BridgeDeploymentTransaction = {
				from: deployer, chainId: '0x3e6', data, value: '0x0',
				gas: `0x${gasLimit.toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}`, nonce: `0x${BigInt(nonce).toString(16)}`,
			};
			return {
				roles, deployer, predictedAddress, initCodeHash: keccak256(data), gasEstimate: gas.toString(), gasLimit: gasLimit.toString(),
				gasPriceWei: gasPrice.toString(), bufferedFeeWei: bufferedFee.toString(), balanceWei: balance.toString(),
				sufficientBalance: balance >= bufferedFee, confirmationsRequired: network.deploymentConfirmations, transaction,
			};
		});
	}

	async check(txHash: Hex, principal: Principal, response: Response): Promise<V15MultisigDeploymentStatus> {
		this.auth.requireTbc(principal);
		const pending = (lastError: string | null = null): V15MultisigDeploymentStatus => ({ status: 'pending', txHash, contractAddress: null, confirmations: 0, confirmationsRequired: network.deploymentConfirmations, actualFeeWei: null, lastError });
		return withDeploymentRpc(response, async (client) => {
			let transaction;
			try { transaction = await client.getTransaction({ hash: txHash }); }
			catch (cause) { if (cause instanceof TransactionNotFoundError) return pending('Transaction is not visible on HyperEVM Testnet yet.'); throw cause; }
			if (transaction.to !== null || transaction.value !== 0n || transaction.input.toLowerCase() !== creationData().toLowerCase()) return { ...pending(), status: 'invalid', lastError: 'The transaction is not the configured V1.5 multisig deployment.' };
			let receipt;
			try { receipt = await client.getTransactionReceipt({ hash: txHash }); }
			catch (cause) { if (cause instanceof TransactionReceiptNotFoundError) return pending(); throw cause; }
			const [head, receiptBlock] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber: receipt.blockNumber })]);
			if (receiptBlock.hash !== receipt.blockHash || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber) return pending('The transaction block is not canonical yet.');
			const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
			const actualFeeWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
			const expected = getContractAddress({ from: transaction.from, nonce: BigInt(transaction.nonce) });
			const base = { txHash, contractAddress: receipt.contractAddress?.toLowerCase() ?? null, confirmations, confirmationsRequired: network.deploymentConfirmations, actualFeeWei, lastError: null };
			if (receipt.status !== 'success') return { ...base, status: confirmations >= network.deploymentConfirmations ? 'reverted' : 'confirming', contractAddress: null, lastError: 'The multisig deployment reverted.' };
			if (!receipt.contractAddress || receipt.contractAddress.toLowerCase() !== expected.toLowerCase()) return { ...base, status: 'invalid', contractAddress: null, lastError: 'The deployment receipt has an unexpected contract address.' };
			if (confirmations < network.deploymentConfirmations) return { ...base, status: 'confirming' };
			const code = await client.getCode({ address: expected, blockNumber: receipt.blockNumber });
			if (!code || normalizedRuntime(code, runtime.immutableReferences) !== normalizedRuntime(runtime.bytecode, runtime.immutableReferences)) return { ...base, status: 'invalid', contractAddress: null, lastError: 'The deployed multisig bytecode differs from the pinned build.' };
			const [signer1, signer2, threshold, chain] = await Promise.all([
				client.readContract({ address: expected, abi: readAbi, functionName: 'signer1', blockNumber: receipt.blockNumber }),
				client.readContract({ address: expected, abi: readAbi, functionName: 'signer2', blockNumber: receipt.blockNumber }),
				client.readContract({ address: expected, abi: readAbi, functionName: 'threshold', blockNumber: receipt.blockNumber }),
				client.readContract({ address: expected, abi: readAbi, functionName: 'TARGET_CHAIN_ID', blockNumber: receipt.blockNumber }),
			]);
			const roles = v15OperatorRoles();
			if (signer1.toLowerCase() !== roles.signer1.toLowerCase() || signer2.toLowerCase() !== roles.signer2.toLowerCase() || threshold !== 2n || chain !== 998n) return { ...base, status: 'invalid', contractAddress: null, lastError: 'The deployed multisig roles or chain binding are incorrect.' };
			if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) return pending('The deployment block changed during verification.');
			return { ...base, status: 'verified', contractAddress: expected.toLowerCase() };
		});
	}

	private async activationDeployment(id: string, principal: Principal) {
		this.auth.requireTbc(principal);
		const row = await this.deployments.owned(id, principal.id);
		const quote = row.quote as unknown as Partial<BridgeDeploymentPreview>;
		if (row.status !== 'verified' || row.lastError || !row.contractAddress || quote.governanceMode !== 'multisig-relayer-v1.5') throw new ConflictException('Choose a verified V1.5 wrapped-token deployment.');
		const roles = v15OperatorRoles();
		if (row.minter.toLowerCase() !== roles.minter.toLowerCase()) throw new ConflictException('The deployment minter no longer matches the configured V1.5 operator role.');
		return { row, roles };
	}

	private actionId(admin: Address, nonce: bigint, target: Address) {
		return keccak256(encodeAbiParameters(parseAbiParameters('uint256, address, uint256, address, bytes32'), [998n, admin, nonce, target, keccak256(unpauseData)]));
	}

	async activationState(id: string, principal: Principal, response: Response): Promise<V15ActivationState> {
		const { row, roles } = await this.activationDeployment(id, principal);
		const target = await this.target.check(row, response);
		return withDeploymentRpc(response, async (client) => {
			const block = await client.getBlock({ blockTag: 'latest' });
			if (block.number === null || !block.hash) throw new ConflictException('No canonical HyperEVM block is available.');
			const admin = row.admin as Address;
			const [code, signer1, signer2, threshold] = await Promise.all([
				client.getCode({ address: admin, blockNumber: block.number }),
				client.readContract({ address: admin, abi: readAbi, functionName: 'signer1', blockNumber: block.number }),
				client.readContract({ address: admin, abi: readAbi, functionName: 'signer2', blockNumber: block.number }),
				client.readContract({ address: admin, abi: readAbi, functionName: 'threshold', blockNumber: block.number }),
			]);
			if (!code || code === '0x' || signer1.toLowerCase() !== roles.signer1.toLowerCase() || signer2.toLowerCase() !== roles.signer2.toLowerCase() || threshold !== 2n) throw new ConflictException('The wrapped token Admin is not the configured 2-of-2 multisig.');
			return { deploymentId: row.id, contractAddress: row.contractAddress!, admin: row.admin, minter: row.minter, signer1: roles.signer1, signer2: roles.signer2, paused: target.paused, active: !target.paused };
		});
	}

	async previewActivation(id: string, kind: V15ActivationKind, requestedActionId: Hex | undefined, principal: Principal, response: Response): Promise<V15ActivationPreview> {
		const { row, roles } = await this.activationDeployment(id, principal);
		const targetState = await this.target.check(row, response);
		if (!targetState.paused) throw new ConflictException('This V1.5 wrapped token is already active.');
		const admin = row.admin as Address;
		const wrapped = row.contractAddress as Address;
		return withDeploymentRpc(response, async (client) => {
			const block = await client.getBlock({ blockTag: 'latest' });
			if (block.number === null || !block.hash) throw new ConflictException('No canonical HyperEVM block is available.');
			let actionId: Hex;
			let from: Address;
			let data: Hex;
			if (kind === 'propose') {
				const actionNonce = await client.readContract({ address: admin, abi: readAbi, functionName: 'nonce', blockNumber: block.number });
				actionId = this.actionId(admin, actionNonce, wrapped);
				from = roles.signer1 as Address;
				data = encodeFunctionData({ abi: adminAbi, functionName: 'propose', args: [wrapped, unpauseData] });
			} else {
				if (!requestedActionId) throw new BadRequestException('Choose the verified activation proposal before preparing approval.');
				actionId = requestedActionId;
				const [action, first, second] = await Promise.all([
					client.readContract({ address: admin, abi: readAbi, functionName: 'action', args: [actionId], blockNumber: block.number }),
					client.readContract({ address: admin, abi: readAbi, functionName: 'approved', args: [actionId, roles.signer1 as Address], blockNumber: block.number }),
					client.readContract({ address: admin, abi: readAbi, functionName: 'approved', args: [actionId, roles.signer2 as Address], blockNumber: block.number }),
				]);
				if (action[0].toLowerCase() !== wrapped.toLowerCase() || action[1].toLowerCase() !== unpauseData || action[2] || !first || second) throw new ConflictException('The saved proposal is missing, already executed, or does not exactly unpause this wrapped token.');
				from = roles.signer2 as Address;
				data = encodeFunctionData({ abi: adminAbi, functionName: 'approveAndExecute', args: [actionId] });
			}
			const [balance, code, nonce, gasPrice, estimate] = await Promise.all([
				client.getBalance({ address: from, blockNumber: block.number }),
				client.getCode({ address: from, blockNumber: block.number }),
				client.getTransactionCount({ address: from, blockTag: 'pending' }),
				client.getGasPrice(),
				client.estimateGas({ account: from, to: admin, data, value: 0n, blockNumber: block.number, prepare: false }),
			]);
			if (code && code !== '0x') throw new BadRequestException('The configured multisig signer must be an ordinary MetaMask account.');
			if (!Number.isSafeInteger(nonce) || nonce < 0) throw new BadRequestException('The signer nonce exceeds this wallet workflow’s supported range.');
			const gas = (estimate * 120n + 99n) / 100n;
			if (estimate <= 0n || gas > block.gasLimit || gasPrice <= 0n) throw new ConflictException('A valid activation fee could not be estimated.');
			if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash || await client.getChainId() !== 998) throw new ConflictException('The target block changed during activation estimation.');
			const transaction: BridgeCallTransaction = { from, to: admin, chainId: '0x3e6', data, value: '0x0', gas: `0x${gas.toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}`, nonce: `0x${BigInt(nonce).toString(16)}` };
			return { deploymentId: row.id, kind, actionId, gasEstimate: estimate.toString(), gasLimit: gas.toString(), gasPriceWei: gasPrice.toString(), bufferedFeeWei: (gas * gasPrice).toString(), balanceWei: balance.toString(), sufficientBalance: balance >= gas * gasPrice, confirmationsRequired: network.deploymentConfirmations, transaction };
		});
	}

	async checkActivation(id: string, kind: V15ActivationKind, actionId: Hex, txHash: Hex, principal: Principal, response: Response): Promise<V15ActivationStatus> {
		const { row, roles } = await this.activationDeployment(id, principal);
		const admin = row.admin as Address;
		const wrapped = row.contractAddress as Address;
		const from = (kind === 'propose' ? roles.signer1 : roles.signer2) as Address;
		const data = kind === 'propose'
			? encodeFunctionData({ abi: adminAbi, functionName: 'propose', args: [wrapped, unpauseData] })
			: encodeFunctionData({ abi: adminAbi, functionName: 'approveAndExecute', args: [actionId] });
		return withDeploymentRpc(response, async (client) => {
			const pausedNow = await client.readContract({ address: wrapped, abi: wrappedAbi, functionName: 'paused' });
			const base = { deploymentId: row.id, kind, actionId, txHash, confirmations: 0, confirmationsRequired: network.deploymentConfirmations, actualFeeWei: null, paused: pausedNow, lastError: null };
			let tx;
			try { tx = await client.getTransaction({ hash: txHash }); }
			catch (cause) { if (cause instanceof TransactionNotFoundError) return { ...base, status: 'pending' as const, lastError: 'Transaction is not visible on HyperEVM Testnet yet.' }; throw cause; }
			const chain = tx.chainId ?? (tx.v >= 35n ? Number((tx.v - 35n) / 2n) : 0);
			if (chain !== 998 || tx.from.toLowerCase() !== from.toLowerCase() || tx.to?.toLowerCase() !== admin.toLowerCase() || tx.input.toLowerCase() !== data.toLowerCase() || tx.value !== 0n) return { ...base, status: 'invalid' as const, lastError: 'This transaction differs from the configured signer, multisig, action or network.' };
			let receipt;
			try { receipt = await client.getTransactionReceipt({ hash: txHash }); }
			catch (cause) { if (cause instanceof TransactionReceiptNotFoundError) return { ...base, status: 'pending' as const }; throw cause; }
			const [receiptBlock, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
			if (receiptBlock.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || head < receipt.blockNumber) return { ...base, status: 'confirming' as const, lastError: 'The activation receipt is not canonical yet.' };
			const confirmations = Number(head - receipt.blockNumber + 1n);
			const actualFeeWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
			const included = { ...base, confirmations, actualFeeWei };
			if (receipt.status !== 'success') return { ...included, status: confirmations >= network.deploymentConfirmations ? 'reverted' as const : 'confirming' as const, lastError: 'The multisig activation transaction reverted.' };
			const expectedEvent = kind === 'propose' ? 'ActionProposed' : 'ActionExecuted';
			const events = receipt.logs.filter((log) => log.address.toLowerCase() === admin.toLowerCase()).flatMap((log) => {
				try { const decoded = decodeEventLog({ abi: adminAbi, data: log.data, topics: log.topics, strict: true }); return decoded.eventName === expectedEvent ? [decoded.args] : []; } catch { return []; }
			});
			if (events.length !== 1 || !('actionId' in events[0]) || events[0].actionId !== actionId || !('target' in events[0]) || events[0].target.toLowerCase() !== wrapped.toLowerCase()) return { ...included, status: 'invalid' as const, lastError: 'The multisig event does not match this wrapped-token activation.' };
			if (confirmations < network.deploymentConfirmations) return { ...included, status: 'confirming' as const };
			const [action, first, second, paused] = await Promise.all([
				client.readContract({ address: admin, abi: readAbi, functionName: 'action', args: [actionId], blockNumber: receipt.blockNumber }),
				client.readContract({ address: admin, abi: readAbi, functionName: 'approved', args: [actionId, roles.signer1 as Address], blockNumber: receipt.blockNumber }),
				client.readContract({ address: admin, abi: readAbi, functionName: 'approved', args: [actionId, roles.signer2 as Address], blockNumber: receipt.blockNumber }),
				client.readContract({ address: wrapped, abi: wrappedAbi, functionName: 'paused', blockNumber: receipt.blockNumber }),
			]);
			const commonMatches = action[0].toLowerCase() === wrapped.toLowerCase() && action[1].toLowerCase() === unpauseData && first;
			const valid = kind === 'propose' ? commonMatches && !action[2] && !second && paused : commonMatches && action[2] && second && !paused;
			if (!valid) return { ...included, paused, status: 'invalid' as const, lastError: 'The confirmed multisig state does not match this activation step.' };
			if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash || await client.getChainId() !== 998) return { ...included, status: 'confirming' as const, lastError: 'The activation block changed during verification.' };
			return { ...included, paused, status: 'verified' as const };
		});
	}
}
