import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { keccak256, parseAbi, type Address } from 'viem';
import type { ReconciliationBalanceCheck } from '../../../shared/src/types/bridgeReconciliation';
import { API_URLS, DEVNET_API_BASE } from '../../../shared/src/config/constants';
import { isObject } from '../../../shared/src/services/apiValidation';
import { AuthService, type Principal } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import { BRIDGE_ASSET_POLICY as policy } from './bridge.config';
import { readBridgeSource } from './bridge-source-read';
import { withDeploymentRpc } from './bridge-deployment-verifier';

const tokenAbi = parseAbi(['function totalSupply() view returns (uint256)', 'function sourceContractId() view returns (bytes32)',
	'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const escrowAbi = parseAbi(['function wrappedToken() view returns (address)', 'function sourceContractId() view returns (bytes32)',
	'function sourceDecimals() view returns (uint8)', 'function totalLocked() view returns (uint256)']);

@Injectable()
export class BridgeReconciliationBalancesService {
	private readonly running = new Set<string>();
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService) {}
	async check(id: string, principal: Principal, response: Response): Promise<ReconciliationBalanceCheck> {
		this.auth.requireTbc(principal);
		const deployment = await this.db.bridgeDeployment.findFirst({ where: { id, identityId: principal.id, status: 'verified' }, select: {
			contractAddress: true, runtimeCodeHash: true, receiptBlockHash: true, receiptBlockNumber: true, contractId: true, decimals: true,
		} });
		if (!deployment?.contractAddress) throw new NotFoundException('Choose a verified wrapped deployment owned by this TBC wallet.');
		if (this.running.has(id) || this.running.size >= 2) throw new ConflictException('A balance check is running. Wait for it to finish.');
		this.running.add(id);
		const startedAt = new Date().toISOString();
		let custodyAddressCount = 0, escrowCount = 0;
		try {
			// Aggregate every recorded reserve for this contract, not just the current wallet's orders.
			// Addresses belonging to other identities are never returned by this endpoint.
			const records = await this.db.$transaction(async (tx) => ({
				orders: await tx.bridgeOrder.findMany({ where: { deploymentId: id, settlement: { isNot: null } }, select: { custody: { select: { address: true } } }, take: 21 }),
				escrows: await tx.redemptionEscrowDeployment.findMany({ where: { deploymentId: id, contractAddress: { not: null }, status: 'verified' }, select: {
					contractAddress: true, runtimeCodeHash: true, receiptBlockHash: true, receiptBlockNumber: true,
				}, take: 21 }),
			}), { isolationLevel: 'RepeatableRead' });
			custodyAddressCount = records.orders.length; escrowCount = records.escrows.length;
			if (custodyAddressCount > 20 || escrowCount > 20) throw new Error('Read limit exceeded.');
			if (records.orders.some((order) => !order.custody)) throw new Error('Missing custody.');
			const addresses = [...new Set(records.orders.map((order) => order.custody!.address))];
			custodyAddressCount = addresses.length;
			if (!/^[0-9a-f]{64}$/.test(deployment.contractId)) throw new Error('Unexpected asset.');
			const observed = await withDeploymentRpc(response, async (client, signal) => {
				const token = deployment.contractAddress as Address;
				const head = await client.getBlock({ blockTag: 'latest' });
				if (head.number === null || head.number < 5n) throw new Error('No confirmed target block.');
				const blockNumber = head.number - 5n;
				const block = await client.getBlock({ blockNumber });
				if (!block.hash || deployment.receiptBlockNumber === null || blockNumber < deployment.receiptBlockNumber
					|| (await client.getBlock({ blockNumber: deployment.receiptBlockNumber })).hash !== deployment.receiptBlockHash) throw new Error('Deployment block changed.');
				const [code, supply, source, decimals] = await Promise.all([
					client.getCode({ address: token, blockNumber }), client.readContract({ address: token, abi: tokenAbi, functionName: 'totalSupply', blockNumber }),
					client.readContract({ address: token, abi: tokenAbi, functionName: 'sourceContractId', blockNumber }), client.readContract({ address: token, abi: tokenAbi, functionName: 'decimals', blockNumber }),
				]);
				if (!code || keccak256(code) !== deployment.runtimeCodeHash || source.toLowerCase() !== `0x${deployment.contractId}` || decimals !== deployment.decimals) throw new Error('Token bindings changed.');
				let locked = 0n;
				for (const escrow of records.escrows) {
					signal.throwIfAborted();
					const address = escrow.contractAddress as Address;
					if (escrow.receiptBlockNumber === null || blockNumber < escrow.receiptBlockNumber
						|| (await client.getBlock({ blockNumber: escrow.receiptBlockNumber })).hash !== escrow.receiptBlockHash) throw new Error('Escrow creation block changed.');
					const [runtime, boundToken, boundSource, precision, total, balance] = await Promise.all([
						client.getCode({ address, blockNumber }), client.readContract({ address, abi: escrowAbi, functionName: 'wrappedToken', blockNumber }),
						client.readContract({ address, abi: escrowAbi, functionName: 'sourceContractId', blockNumber }), client.readContract({ address, abi: escrowAbi, functionName: 'sourceDecimals', blockNumber }),
						client.readContract({ address, abi: escrowAbi, functionName: 'totalLocked', blockNumber }), client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber }),
					]);
					if (!runtime || keccak256(runtime) !== escrow.runtimeCodeHash || boundToken.toLowerCase() !== token.toLowerCase()
						|| boundSource.toLowerCase() !== `0x${deployment.contractId}` || precision !== deployment.decimals || balance !== total) throw new Error('Escrow bindings or locked balance differ.');
					locked += total;
				}
				if (locked > supply) throw new Error('Locked amount exceeds supply.');
				await this.checkpoint(signal);
				let reserve = 0n;
				const outpoints = new Set<string>();
				for (const address of addresses) reserve += await this.indexedBalance(address, deployment.contractId, signal, outpoints);
				await this.checkpoint(signal);
				if ((await client.getBlock({ blockNumber })).hash !== block.hash || await client.getChainId() !== 998) throw new Error('Target block changed during reads.');
				return { reserve, supply, locked, circulating: supply - locked, blockNumber, blockHash: block.hash };
			});
			const difference = observed.reserve - observed.circulating;
			return { deploymentId: id, wrappedToken: deployment.contractAddress, startedAt, checkedAt: new Date().toISOString(),
				status: difference === 0n ? 'matching' : 'difference', message: difference === 0n ? 'Indexed source token reserves match totalSupply minus registered permanent locks for this observation.' : 'Observed source token reserves and circulating wrapped token differ. Pending deposits or returns can explain a difference; review the transaction history.',
				custodyAddressCount, escrowCount, indexedReserveRaw: observed.reserve.toString(), totalSupplyRaw: observed.supply.toString(), permanentlyLockedRaw: observed.locked.toString(),
				circulatingRaw: observed.circulating.toString(), differenceRaw: difference.toString(), targetBlockNumber: observed.blockNumber.toString(), targetBlockHash: observed.blockHash };
		} catch {
			return { deploymentId: id, wrappedToken: deployment.contractAddress, startedAt, checkedAt: new Date().toISOString(), status: 'unavailable',
				message: 'A complete balance observation is unavailable. A network read, contract binding, pagination limit or canonical-block check failed. Saved history is unchanged; unavailable balances are not zero.',
				custodyAddressCount, escrowCount, indexedReserveRaw: null, totalSupplyRaw: null, permanentlyLockedRaw: null, circulatingRaw: null, differenceRaw: null, targetBlockNumber: null, targetBlockHash: null };
		} finally { this.running.delete(id); }
	}
	private async checkpoint(signal: AbortSignal) {
		const block = await readBridgeSource(`${DEVNET_API_BASE}/blockByHeight/height/${policy.genesisBlockHeight}`, signal);
		if (block.hash !== policy.genesisBlockHash || block.height !== policy.genesisBlockHeight || !Number.isSafeInteger(block.confirmations) || Number(block.confirmations) < policy.minimumConfirmations) throw new ServiceUnavailableException('The fixed source checkpoint did not match.');
	}
	private async indexedBalance(address: string, contractId: string, signal: AbortSignal, seen: Set<string>) {
		let sum = 0n, cursor = '';
		const cursors = new Set<string>();
		for (let page = 0; page < 10; page++) {
			const url = new URL(API_URLS.tokenUtxos(address, contractId)); url.searchParams.set('limit', '1000');
			if (cursor) url.searchParams.set('after', cursor);
			const data = await readBridgeSource(url, signal);
			if (!Array.isArray(data.utxos) || data.utxos.length > 1000) throw new Error('Invalid index page.');
			for (const item of data.utxos as unknown[]) {
				if (!isObject(item) || typeof item.txid !== 'string' || !/^[0-9a-f]{64}$/.test(item.txid) || !Number.isSafeInteger(item.index) || Number(item.index) < 0
					|| !(typeof item.ft_value === 'string' && /^\d{1,20}$/.test(item.ft_value) || typeof item.ft_value === 'number' && Number.isSafeInteger(item.ft_value) && item.ft_value >= 0)) throw new Error('Invalid indexed amount.');
				const key = `${item.txid}:${item.index}`;
				if (seen.has(key)) throw new Error('Duplicate indexed outpoint.');
				seen.add(key); const amount = BigInt(item.ft_value);
				if (amount > 18446744073709551615n) throw new Error('Indexed amount overflow.');
				sum += amount;
			}
			if (data.next_cursor == null || data.next_cursor === '') return sum;
			if (typeof data.next_cursor !== 'string' || data.next_cursor.length > 1000 || cursors.has(data.next_cursor)) throw new Error('Invalid index cursor.');
			cursor = data.next_cursor; cursors.add(cursor);
		}
		throw new Error('Incomplete index pages.');
	}
}
