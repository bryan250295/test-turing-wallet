import { ConflictException, Injectable } from '@nestjs/common';
import { decodeEventLog, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import type { Response } from 'express';
import type { RedemptionOrder, RedemptionEscrowDeployment } from '../../generated/prisma/client';
import { withDeploymentRpc } from './bridge-deployment-verifier';
const abi = parseAbi([
	'function lockForRedemption(bytes32 redemptionId,string tbcRecipient,uint256 amountRaw)',
	'function processedRedemptions(bytes32) view returns (bool)', 'function wrappedToken() view returns (address)',
	'function sourceContractId() view returns (bytes32)', 'function sourceDecimals() view returns (uint8)',
	'function totalLocked() view returns (uint256)', 'function TARGET_CHAIN_ID() view returns (uint256)',
	'event RedemptionLocked(bytes32 indexed redemptionId,address indexed holder,bytes32 indexed recipientHash,address wrappedToken,bytes32 sourceContractId,string tbcRecipient,uint256 amountRaw)',
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
function ensure(ok: unknown, message: string): asserts ok { if (!ok) throw new ConflictException(message); }
@Injectable()
export class RedemptionLockVerifier {
	async verify(row: RedemptionOrder, escrow: RedemptionEscrowDeployment, txHash: string, response: Response) {
		ensure(escrow.status === 'verified' && !escrow.lastError && escrow.contractAddress === row.escrowAddress && escrow.runtimeCodeHash && escrow.receiptBlockHash && escrow.receiptBlockNumber !== null, 'Escrow deployment evidence is incomplete.');
		return withDeploymentRpc(response, async (client) => {
			const address = row.escrowAddress as Address; const amount = BigInt(row.amountRaw.toFixed(0));
			const [tx, receipt, birth, head] = await Promise.all([client.getTransaction({ hash: txHash as Hex }), client.getTransactionReceipt({ hash: txHash as Hex }), client.getBlock({ blockNumber: escrow.receiptBlockNumber! }), client.getBlockNumber({ cacheTime: 0 })]);
			const block = await client.getBlock({ blockNumber: receipt.blockNumber });
			const chain = tx.chainId ?? (tx.v >= 35n ? Number((tx.v - 35n) / 2n) : 0);
			ensure(chain === 998 && tx.hash.toLowerCase() === txHash && tx.from.toLowerCase() === row.holder && tx.to?.toLowerCase() === row.escrowAddress && tx.value === 0n
				&& tx.input.toLowerCase() === encodeFunctionData({ abi, functionName: 'lockForRedemption', args: [row.redemptionId as Hex, row.tbcRecipient, amount] }).toLowerCase(), 'The lock transaction differs from the frozen holder, escrow, redemption ID, amount or recipient.');
			ensure(receipt.status === 'success' && receipt.transactionHash.toLowerCase() === txHash && receipt.from.toLowerCase() === row.holder && receipt.to?.toLowerCase() === row.escrowAddress
				&& birth.hash === escrow.receiptBlockHash && block.hash === receipt.blockHash && tx.blockHash === block.hash && tx.blockNumber === block.number && head >= receipt.blockNumber + 5n, 'Wait for a successful canonical lock with at least 6 confirmations.');
			const code = await client.getCode({ address, blockNumber: receipt.blockNumber });
			ensure(code && keccak256(code) === escrow.runtimeCodeHash, 'The escrow runtime differs from the verified deployment.');
			const matches = [];
			for (const log of receipt.logs) {
				if (log.address.toLowerCase() !== row.escrowAddress) continue;
				try {
					const event = decodeEventLog({ abi, eventName: 'RedemptionLocked', data: log.data, topics: log.topics, strict: true });
					if (event.args.redemptionId.toLowerCase() === row.redemptionId) matches.push({ log, args: event.args });
				} catch { /* Other escrow events cannot authorize a source token release. */ }
			}
			ensure(matches.length === 1, 'Exactly one matching escrow redemption event is required.');
			const { log, args } = matches[0];
			ensure(log.logIndex !== null && log.blockHash === receipt.blockHash && log.transactionHash?.toLowerCase() === txHash
				&& args.holder.toLowerCase() === row.holder && args.recipientHash.toLowerCase() === keccak256(stringToHex(row.tbcRecipient))
				&& args.wrappedToken.toLowerCase() === escrow.wrappedToken && args.sourceContractId.toLowerCase() === `0x${escrow.sourceContractId}`
				&& args.tbcRecipient === row.tbcRecipient && args.amountRaw === amount, 'The permanent lock event does not match the full frozen redemption terms.');
			const read = <N extends 'processedRedemptions' | 'wrappedToken' | 'sourceContractId' | 'sourceDecimals' | 'totalLocked' | 'TARGET_CHAIN_ID'>(functionName: N) =>
				client.readContract({ address, abi, functionName, ...(functionName === 'processedRedemptions' ? { args: [row.redemptionId as Hex] } : {}), blockNumber: receipt.blockNumber } as Parameters<typeof client.readContract>[0]);
			const [processed, token, source, decimals, locked, targetChain, balance] = await Promise.all([
				read('processedRedemptions'), read('wrappedToken'), read('sourceContractId'), read('sourceDecimals'), read('totalLocked'), read('TARGET_CHAIN_ID'),
				client.readContract({ address: escrow.wrappedToken as Address, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: receipt.blockNumber }),
			]);
			ensure(processed === true && typeof token === 'string' && token.toLowerCase() === escrow.wrappedToken && typeof source === 'string' && source.toLowerCase() === `0x${escrow.sourceContractId}`
				&& decimals === escrow.decimals && targetChain === 998n && typeof locked === 'bigint' && locked >= amount && balance >= locked, 'The receipt-block permanent escrow state does not establish the required lock.');
			ensure((await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash && await client.getChainId() === 998, 'The lock block changed during verification.');
			return { txHash, logIndex: log.logIndex, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, confirmations: Number(head - receipt.blockNumber + 1n), checkedAt: new Date() };
		});
	}
}
