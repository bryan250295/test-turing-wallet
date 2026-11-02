import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, stringToHex, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import type { BridgeCallAttempt, Prisma } from '../../generated/prisma/client';
import type { BridgeCallKind } from '../../../shared/src/types/learningBridge';
import type { SettlementOrder } from './bridge-settlement.repository';
import { withDeploymentRpc } from './bridge-deployment-verifier';

export const bridgeCallAbi = parseAbi([
	'function unpause()', 'function paused() view returns (bool)',
	'function processedOrders(bytes32) view returns (bool)', 'function processedDeposits(bytes32) view returns (bool)',
	'function mintFromDeposit(bytes32 orderId, bytes32 sourceContractId_, bytes32 sourceTxid, uint32 sourceVout, address recipient, uint256 amountRaw)',
	'event DepositMinted(bytes32 indexed orderId, bytes32 indexed depositId, address indexed recipient, bytes32 sourceContractId, bytes32 sourceTxid, uint32 sourceVout, uint256 amountRaw)',
]);
export function orderKey(orderId: string): Hex { return `0x${createHash('sha256').update(`learning-bridge/order/v1:${orderId}`).digest('hex')}`; }
function paymentKey(order: SettlementOrder): Hex {
	const deposit = order.settlement?.deposit;
	if (!deposit) throw new ConflictException('No verified deposit is saved.');
	return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint32'), [keccak256(stringToHex('learning-bridge/tbc-testnet/legacy-ft/v1')), `0x${order.contractId}`, `0x${deposit.txid}`, deposit.vout]));
}
export function callData(order: SettlementOrder, kind: BridgeCallKind) {
	const deposit = order.settlement?.deposit;
	if (kind === 'unpause') return encodeFunctionData({ abi: bridgeCallAbi, functionName: 'unpause' });
	if (!deposit) throw new ConflictException('Verify the deposit first.');
	return encodeFunctionData({ abi: bridgeCallAbi, functionName: 'mintFromDeposit', args: [orderKey(order.id), `0x${order.contractId}`, `0x${deposit.txid}`, deposit.vout, order.recipient as Address, BigInt(order.amountRaw.toFixed(0))] });
}

@Injectable()
export class BridgeCallVerifier {
	async quote(order: SettlementOrder, kind: BridgeCallKind, from: Address, response: Response, previous?: BridgeCallAttempt) {
		const expected = kind === 'unpause' ? order.deployment.admin : order.deployment.minter;
		if (from.toLowerCase() !== expected.toLowerCase()) throw new BadRequestException(`Select the saved ${kind === 'unpause' ? 'admin' : 'minter'} account ${expected} in MetaMask, then prepare the next step again.`);
		const to = order.destinationContract as Address;
		const data = callData(order, kind);
		return withDeploymentRpc(response, async (client) => {
			const block = await client.getBlock({ blockTag: 'latest' });
			if (block.number === null || !block.hash) throw new ConflictException('No canonical target block is available.');
			const [paused, processedOrder, processedDeposit, balance, code, nonce, gasPrice] = await Promise.all([
				client.readContract({ address: to, abi: bridgeCallAbi, functionName: 'paused', blockNumber: block.number }),
				client.readContract({ address: to, abi: bridgeCallAbi, functionName: 'processedOrders', args: [orderKey(order.id)], blockNumber: block.number }),
				client.readContract({ address: to, abi: bridgeCallAbi, functionName: 'processedDeposits', args: [paymentKey(order)], blockNumber: block.number }),
				client.getBalance({ address: from, blockNumber: block.number }), client.getCode({ address: from, blockNumber: block.number }),
				client.getTransactionCount({ address: from, blockTag: 'pending' }), client.getGasPrice(),
			]);
			if (code && code !== '0x') throw new BadRequestException('Use an ordinary MetaMask account; smart-account calls are not enabled.');
			if (!Number.isSafeInteger(nonce) || nonce < 0) throw new BadRequestException('The account nonce exceeds this wallet workflow’s supported range.');
			if (processedOrder || processedDeposit) throw new ConflictException('The contract already processed this order or deposit. Reconcile the existing mint transaction; do not mint again.');
			if (kind === 'mint' && paused) throw new ConflictException('The contract is paused. Confirm the admin unpause transaction first.');
			if (kind === 'unpause' && !paused) throw new ConflictException('The contract is already unpaused. Prepare mint instead.');
			const estimate = await client.estimateGas({ account: from, to, data, value: 0n, blockNumber: block.number, prepare: false });
			const gas = (estimate * 120n + 99n) / 100n;
			if (estimate <= 0n || gas > block.gasLimit || gasPrice <= 0n) throw new ConflictException('A valid target transaction fee could not be estimated.');
			if (balance < gas * gasPrice) throw new ConflictException('The selected MetaMask account needs more test HYPE for this transaction budget.');
			if (previous && (previous.data !== data || previous.fromAddress !== from.toLowerCase() || previous.toAddress !== to.toLowerCase() || previous.nonce !== BigInt(nonce)
				|| previous.gasLimit < estimate || BigInt(previous.gasPriceWei.toFixed(0)) < gasPrice || balance < BigInt(previous.budgetWei.toFixed(0)))) throw new ConflictException('Nonce, fee or contract terms changed. Discard this unused quote and prepare a fresh one.');
			if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash || await client.getChainId() !== 998) throw new ConflictException('The target block changed during fee estimation.');
			return { orderId: order.id, kind, chainId: 998, fromAddress: from.toLowerCase(), toAddress: to.toLowerCase(), data,
				nonce: BigInt(nonce), gasLimit: gas, gasPriceWei: gasPrice.toString(), estimatedFeeWei: (estimate * gasPrice).toString(), budgetWei: (gas * gasPrice).toString(), expiresAt: new Date(Date.now() + 60_000) };
		});
	}
	async receipt(order: SettlementOrder, attempt: BridgeCallAttempt, response: Response): Promise<Prisma.BridgeCallAttemptUpdateManyMutationInput> {
		if (!attempt.txHash) throw new BadRequestException('Attach the hash from MetaMask Activity first.');
		return withDeploymentRpc(response, async (client) => {
			let tx;
			try { tx = await client.getTransaction({ hash: attempt.txHash as Hex }); }
			catch (cause) { if (cause instanceof TransactionNotFoundError) return { status: 'submitted', confirmations: 0, lastError: 'Transaction not visible yet. Check MetaMask Activity and refresh; do not send again.' }; throw cause; }
			const chain = tx.chainId ?? (tx.v >= 35n ? Number((tx.v - 35n) / 2n) : 0);
			if (chain !== 998 || tx.from.toLowerCase() !== attempt.fromAddress || tx.to?.toLowerCase() !== attempt.toAddress || tx.input.toLowerCase() !== attempt.data || tx.value !== 0n || BigInt(tx.nonce) !== attempt.nonce) return { status: 'invalid', lastError: 'This transaction differs from the reviewed sender, destination, calldata, value, nonce or network. Manual reconciliation is required.' };
			let receipt;
			try { receipt = await client.getTransactionReceipt({ hash: attempt.txHash as Hex }); }
			catch (cause) { if (cause instanceof TransactionReceiptNotFoundError) return { status: 'submitted', confirmations: 0, lastError: null }; throw cause; }
			const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
			if (block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash || head < receipt.blockNumber) return { status: 'confirming', confirmations: 0, lastError: 'The target block changed. Waiting for a canonical receipt.' };
			const confirmations = Number(head - receipt.blockNumber + 1n);
			const result = { confirmations, receiptBlockHash: receipt.blockHash, receiptBlockNumber: receipt.blockNumber, actualFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), lastError: null };
			if (confirmations < order.destinationConfirmationsRequired) return { ...result, status: 'confirming' };
			if (receipt.status !== 'success') return { ...result, status: 'reverted', lastError: 'The transaction reverted. Gas was charged; no successful bridge action was recorded.' };
			if (attempt.kind === 'unpause') {
				if (await client.readContract({ address: attempt.toAddress as Address, abi: bridgeCallAbi, functionName: 'paused', blockNumber: receipt.blockNumber })) return { ...result, status: 'invalid', lastError: 'The unpause receipt does not match its contract state.' };
			} else {
				const deposit = order.settlement!.deposit!;
				const events = receipt.logs.filter((log) => log.address.toLowerCase() === attempt.toAddress).flatMap((log) => {
					try { const decoded = decodeEventLog({ abi: bridgeCallAbi, data: log.data, topics: log.topics, strict: true }); return decoded.eventName === 'DepositMinted' ? [decoded.args] : []; } catch { return []; }
				});
				const event = events[0];
				if (events.length !== 1 || event.orderId !== orderKey(order.id) || event.depositId !== paymentKey(order) || event.recipient.toLowerCase() !== order.recipient
					|| event.sourceContractId !== `0x${order.contractId}` || event.sourceTxid !== `0x${deposit.txid}` || event.sourceVout !== deposit.vout || event.amountRaw !== BigInt(order.amountRaw.toFixed(0))) return { ...result, status: 'invalid', lastError: 'The mint event does not match the frozen order and source output.' };
				const processed = await Promise.all([
					client.readContract({ address: attempt.toAddress as Address, abi: bridgeCallAbi, functionName: 'processedOrders', args: [orderKey(order.id)], blockNumber: receipt.blockNumber }),
					client.readContract({ address: attempt.toAddress as Address, abi: bridgeCallAbi, functionName: 'processedDeposits', args: [paymentKey(order)], blockNumber: receipt.blockNumber }),
				]);
				if (processed.some((value) => !value)) return { ...result, status: 'invalid', lastError: 'The contract replay-protection state is incomplete.' };
			}
			if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash || await client.getChainId() !== 998) return { status: 'confirming', confirmations: 0, lastError: 'The target block changed during receipt verification.' };
			return { ...result, status: 'verified' };
		});
	}
}
