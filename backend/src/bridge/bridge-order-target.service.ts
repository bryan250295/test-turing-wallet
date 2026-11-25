import { ConflictException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { keccak256, parseAbi, type Address } from 'viem';
import type { BridgeDeployment } from '../../generated/prisma/client';
import { withDeploymentRpc } from './bridge-deployment-verifier';
import { ETHEREUM_SEPOLIA_CHAIN_ID, withSepoliaRpc } from './ethereum-sepolia-rpc';

const abi = parseAbi([
	'function owner() view returns (address)', 'function minter() view returns (address)',
	'function sourceContractId() view returns (bytes32)', 'function decimals() view returns (uint8)',
	'function paused() view returns (bool)', 'function totalSupply() view returns (uint256)',
]);
const sepoliaAbi = parseAbi([
	'function owner() view returns (address)', 'function minter() view returns (address)',
	'function sourceAssetId() view returns (bytes32)', 'function sourceDecimals() view returns (uint8)', 'function sourceAssetKind() view returns (uint8)',
	'function decimals() view returns (uint8)', 'function paused() view returns (bool)', 'function totalSupply() view returns (uint256)',
]);

@Injectable()
export class BridgeOrderTargetService {
	async check(deployment: BridgeDeployment, response: Response) {
		if (deployment.chainId === ETHEREUM_SEPOLIA_CHAIN_ID) return this.checkSepolia(deployment, response);
		if (!deployment.contractAddress || !deployment.runtimeCodeHash || !deployment.receiptBlockHash || deployment.receiptBlockNumber === null) throw new ConflictException('The deployment verification record is incomplete. Refresh deployment status.');
		const address = deployment.contractAddress as Address;
		return withDeploymentRpc(response, async (client) => {
			const [head, birth] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockNumber: deployment.receiptBlockNumber! })]);
			if (head.number === null || head.hash === null || birth.hash !== deployment.receiptBlockHash || head.number < deployment.receiptBlockNumber! + 5n) throw new ConflictException('The deployment block is not verified on the current chain. Refresh its status.');
			const read = <N extends typeof abi[number]['name']>(functionName: N) => client.readContract({ address, abi, functionName, blockNumber: head.number! });
			const [code, owner, minter, sourceId, decimals, paused, supply] = await Promise.all([
				client.getCode({ address, blockNumber: head.number }), read('owner'), read('minter'), read('sourceContractId'), read('decimals'), read('paused'), read('totalSupply'),
			]);
			if (!code || keccak256(code) !== deployment.runtimeCodeHash || owner.toLowerCase() !== deployment.admin.toLowerCase() || minter.toLowerCase() !== deployment.minter.toLowerCase()
				|| sourceId.toLowerCase() !== `0x${deployment.contractId}` || decimals !== deployment.decimals) throw new ConflictException('The target contract no longer matches its verified owner, minter, source token binding or precision.');
			if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash || await client.getChainId() !== 998) throw new ConflictException('The target chain changed while checking the order. Refresh before retrying.');
			return { blockNumber: head.number, blockHash: head.hash, paused, supply };
		});
	}
	private async checkSepolia(deployment: BridgeDeployment, response: Response) {
		if (!deployment.contractAddress || !deployment.runtimeCodeHash) throw new ConflictException('The Sepolia route verification record is incomplete. Refresh route status.');
		const address = deployment.contractAddress as Address;
		const expectedSourceKind = deployment.quote && typeof deployment.quote === 'object' && 'sourceAssetKind' in deployment.quote && deployment.quote.sourceAssetKind === 'fungible-token' ? 1 : 0;
		return withSepoliaRpc(response, async (client) => {
			const head = await client.getBlock({ blockTag: 'latest' });
			if (head.number === null || !head.hash) throw new ConflictException('No canonical Sepolia block is available.');
			const read = <N extends typeof sepoliaAbi[number]['name']>(functionName: N) => client.readContract({ address, abi: sepoliaAbi, functionName, blockNumber: head.number! });
			const [code, owner, minter, sourceId, sourceDecimals, observedSourceKind, decimals, paused, supply] = await Promise.all([
				client.getCode({ address, blockNumber: head.number }), read('owner'), read('minter'), read('sourceAssetId'), read('sourceDecimals'),
				read('sourceAssetKind'), read('decimals'), read('paused'), read('totalSupply'),
			]);
			if (!code || keccak256(code) !== deployment.runtimeCodeHash || owner.toLowerCase() !== deployment.admin.toLowerCase() || minter.toLowerCase() !== deployment.minter.toLowerCase()
				|| sourceId.toLowerCase() !== `0x${deployment.contractId}` || sourceDecimals !== deployment.decimals || decimals !== deployment.decimals || observedSourceKind !== expectedSourceKind)
				throw new ConflictException('The Sepolia wrapped contract no longer matches its verified bytecode, Admin, minter, source asset binding or precision.');
			if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash || await client.getChainId() !== ETHEREUM_SEPOLIA_CHAIN_ID) throw new ConflictException('The Sepolia target changed while checking the order.');
			return { blockNumber: head.number, blockHash: head.hash, paused, supply };
		});
	}
}
