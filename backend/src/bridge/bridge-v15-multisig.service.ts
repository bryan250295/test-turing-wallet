import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { encodeDeployData, getAddress, getContractAddress, keccak256, parseAbi, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { BRIDGE_ADMIN_MULTISIG_BUILD as build, BRIDGE_ADMIN_MULTISIG_RUNTIME as runtime } from '../../../shared/src/contracts/bridgeAdminMultisig';
import { LEARNING_BRIDGE_EVM as network } from '../../../shared/src/config/learningBridge';
import type { BridgeDeploymentTransaction, V15MultisigDeploymentPreview, V15MultisigDeploymentStatus } from '../../../shared/src/types/learningBridge';
import { AuthService, type Principal } from '../auth/auth.service';
import { v15OperatorRoles } from './bridge.config';
import { normalizedRuntime, withDeploymentRpc } from './bridge-deployment-verifier';

const readAbi = parseAbi([
	'function signer1() view returns (address)',
	'function signer2() view returns (address)',
	'function threshold() view returns (uint256)',
	'function TARGET_CHAIN_ID() view returns (uint256)',
]);

function creationData() {
	const roles = v15OperatorRoles();
	return encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [roles.signer1 as Address, roles.signer2 as Address] });
}

@Injectable()
export class BridgeV15MultisigService {
	constructor(@Inject(AuthService) private readonly auth: AuthService) {}

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
}
