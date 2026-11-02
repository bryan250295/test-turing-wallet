import { BadRequestException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { getContractAddress, keccak256, parseAbi, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import type { Prisma, RedemptionEscrowDeployment } from '../../generated/prisma/client';
import { normalizedRuntime, withDeploymentRpc } from './bridge-deployment-verifier';

const abi = parseAbi([
	'function wrappedToken() view returns (address)', 'function sourceContractId() view returns (bytes32)', 'function sourceDecimals() view returns (uint8)',
	'function owner() view returns (address)', 'function pendingOwner() view returns (address)', 'function paused() view returns (bool)',
	'function totalLocked() view returns (uint256)', 'function TARGET_CHAIN_ID() view returns (uint256)',
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

@Injectable()
export class RedemptionEscrowVerifier {
	async check(row: RedemptionEscrowDeployment, response: Response): Promise<Prisma.RedemptionEscrowDeploymentUpdateManyMutationInput> {
		if (!row.txHash) throw new BadRequestException('Recover the escrow deployment hash from MetaMask Activity first.');
		return withDeploymentRpc(response, async (client) => {
			const reset = { status: 'submitted', confirmations: 0, contractAddress: null, runtimeCodeHash: null, verifiedAt: null,
				receiptBlockHash: null, receiptBlockNumber: null, actualFeeWei: null, checkedAt: new Date(), lastError: null };
			let tx;
			try { tx = await client.getTransaction({ hash: row.txHash as Hex }); }
			catch (cause) { if (cause instanceof TransactionNotFoundError) return { ...reset, lastError: 'Transaction not visible yet. Check Activity and refresh; do not deploy again.' }; throw cause; }
			const chain = tx.chainId ?? (tx.v >= 35n ? Number((tx.v - 35n) / 2n) : 0);
			if (chain !== 998 || tx.hash.toLowerCase() !== row.txHash || tx.from.toLowerCase() !== row.deployer || tx.to !== null || tx.value !== 0n || BigInt(tx.nonce) !== row.nonce || tx.input.toLowerCase() !== row.transactionData) return { ...reset, status: 'invalid', lastError: 'The escrow creation transaction differs from the reviewed sender, nonce, network, value or bytecode.' };
			let receipt;
			try { receipt = await client.getTransactionReceipt({ hash: row.txHash as Hex }); }
			catch (cause) { if (cause instanceof TransactionReceiptNotFoundError) return reset; throw cause; }
			const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
			if (block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || head < receipt.blockNumber) return { ...reset, status: 'confirming', lastError: 'Waiting for a canonical escrow creation receipt.' };
			const confirmations = Number(head - receipt.blockNumber + 1n);
			const observed = { ...reset, confirmations, receiptBlockHash: receipt.blockHash, receiptBlockNumber: receipt.blockNumber,
				actualFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
			if (confirmations < 6) return { ...observed, status: 'confirming' };
			if (receipt.status !== 'success') return { ...observed, status: 'reverted', lastError: 'Escrow deployment reverted. Gas was charged, but no usable escrow was registered.' };
			const address = getContractAddress({ from: row.deployer as Address, nonce: row.nonce });
			if (receipt.transactionHash.toLowerCase() !== row.txHash || receipt.contractAddress?.toLowerCase() !== address.toLowerCase() || receipt.from.toLowerCase() !== row.deployer || receipt.to !== null) return { ...observed, status: 'invalid', lastError: 'Escrow creation receipt has an unexpected address or sender.' };
			const code = await client.getCode({ address, blockNumber: receipt.blockNumber });
			if (!code || normalizedRuntime(code, row.immutableReferences) !== normalizedRuntime(row.runtimeBytecode, row.immutableReferences)) return { ...observed, status: 'invalid', lastError: 'The deployed escrow bytecode differs from the saved Solidity build.' };
			const read = <N extends typeof abi[number]['name']>(functionName: N) => client.readContract({ address, abi, functionName, blockNumber: receipt.blockNumber });
			const [token, source, decimals, owner, pendingOwner, paused, locked, targetChain, balance] = await Promise.all([
				read('wrappedToken'), read('sourceContractId'), read('sourceDecimals'), read('owner'), read('pendingOwner'), read('paused'), read('totalLocked'), read('TARGET_CHAIN_ID'),
				client.readContract({ address: row.wrappedToken as Address, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: receipt.blockNumber }),
			]);
			if (token.toLowerCase() !== row.wrappedToken || source.toLowerCase() !== `0x${row.sourceContractId}` || decimals !== row.decimals || owner.toLowerCase() !== row.deployer
				|| pendingOwner !== '0x0000000000000000000000000000000000000000' || paused !== true || locked !== 0n || balance !== 0n || targetChain !== 998n) return { ...observed, status: 'invalid', lastError: 'The escrow token binding, owner, precision, initial pause or initial zero balance/locked state is incorrect.' };
			if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash || await client.getChainId() !== 998) return { ...reset, status: 'confirming', lastError: 'The escrow creation block changed during verification.' };
			return { ...observed, status: 'verified', contractAddress: address.toLowerCase(), runtimeCodeHash: keccak256(code), verifiedAt: new Date() };
		});
	}
}
