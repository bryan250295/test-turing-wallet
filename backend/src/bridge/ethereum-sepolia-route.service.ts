import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { getAddress, isAddress, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import type { Prisma } from '../../generated/prisma/client';
import { sepoliaFtRouteId, sepoliaWrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import { AuthService, type Principal } from '../auth/auth.service';
import { environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { v15OperatorRoles } from './bridge.config';
import { BridgeAssetVerifier } from './bridge-asset.verifier';
import type { RegisterEthereumSepoliaFtRouteDto } from './bridge.dto';
import { ETHEREUM_SEPOLIA_CHAIN_ID, withSepoliaRpc } from './ethereum-sepolia-rpc';

export const SEPOLIA_NATIVE_TBC_ROUTE_ID = 'tbc-testnet-native-to-ethereum-sepolia-burn-v1';
export const NATIVE_TBC_SOURCE_ID = keccak256(stringToHex('tbc/testnet/native-tbc'));
export const NATIVE_TBC_DECIMALS = 6;

const wrappedAbi = parseAbi([
	'function owner() view returns (address)', 'function minter() view returns (address)',
	'function sourceAssetId() view returns (bytes32)', 'function sourceDecimals() view returns (uint8)',
	'function sourceAssetKind() view returns (uint8)', 'function decimals() view returns (uint8)',
	'function paused() view returns (bool)', 'function name() view returns (string)', 'function symbol() view returns (string)',
	'function TARGET_CHAIN_ID() view returns (uint256)',
]);
const adminAbi = parseAbi([
	'function signer1() view returns (address)', 'function signer2() view returns (address)',
	'function threshold() view returns (uint256)', 'function TARGET_CHAIN_ID() view returns (uint256)',
]);

function configuredAddress(value: string, name: string): Address {
	if (!isAddress(value, { strict: true }) || /^0x0{40}$/i.test(value)) throw new Error(`${name} must be a nonzero checksummed address.`);
	return getAddress(value);
}

@Injectable()
export class EthereumSepoliaRouteService {
	constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(PrismaService) private readonly db: PrismaService,
		@Inject(BridgeAssetVerifier) private readonly assets: BridgeAssetVerifier) {}

	async ensure(principal: Principal, response?: Response) {
		this.auth.requireTbc(principal);
		const config = environment();
		const admin = configuredAddress(config.sepoliaAdminAddress, 'SEPOLIA_BRIDGE_ADMIN_ADDRESS');
		const wrapped = configuredAddress(config.sepoliaWrappedTbcAddress, 'SEPOLIA_WRAPPED_TBC_ADDRESS');
		const deployer = configuredAddress(config.sepoliaDeployerAddress, 'SEPOLIA_DEPLOYER_ADDRESS');
		const roles = v15OperatorRoles();
		const observed = await withSepoliaRpc(response, async (rpc) => {
			const block = await rpc.getBlock({ blockTag: 'latest' });
			if (block.number === null || !block.hash) throw new ConflictException('Sepolia has no canonical latest block.');
			const readWrapped = <N extends typeof wrappedAbi[number]['name']>(functionName: N) => rpc.readContract({ address: wrapped, abi: wrappedAbi, functionName, blockNumber: block.number! });
			const readAdmin = <N extends typeof adminAbi[number]['name']>(functionName: N) => rpc.readContract({ address: admin, abi: adminAbi, functionName, blockNumber: block.number! });
			const [code, owner, minter, sourceId, sourceDecimals, sourceKind, decimals, paused, name, symbol, targetChain, signer1, signer2, threshold, adminChain] = await Promise.all([
				rpc.getCode({ address: wrapped, blockNumber: block.number }), readWrapped('owner'), readWrapped('minter'), readWrapped('sourceAssetId'),
				readWrapped('sourceDecimals'), readWrapped('sourceAssetKind'), readWrapped('decimals'), readWrapped('paused'), readWrapped('name'), readWrapped('symbol'),
				readWrapped('TARGET_CHAIN_ID'), readAdmin('signer1'), readAdmin('signer2'), readAdmin('threshold'), readAdmin('TARGET_CHAIN_ID'),
			]);
			if (!code || code === '0x') throw new ConflictException('The configured Wrapped TBC contract has no Sepolia bytecode.');
			if (owner.toLowerCase() !== admin.toLowerCase() || minter.toLowerCase() !== roles.minter.toLowerCase()
				|| sourceId.toLowerCase() !== NATIVE_TBC_SOURCE_ID.toLowerCase() || sourceDecimals !== NATIVE_TBC_DECIMALS || decimals !== NATIVE_TBC_DECIMALS
				|| sourceKind !== 0 || paused || name !== 'Wrapped TBC' || symbol !== 'wTBC' || targetChain !== BigInt(ETHEREUM_SEPOLIA_CHAIN_ID)
				|| signer1.toLowerCase() !== roles.signer1.toLowerCase() || signer2.toLowerCase() !== roles.signer2.toLowerCase() || threshold !== 2n || adminChain !== BigInt(ETHEREUM_SEPOLIA_CHAIN_ID)) {
				throw new ConflictException('The configured Sepolia route does not match the active 2-of-2 Admin, mint-only relayer, native TBC binding, six-decimal precision or unpaused state.');
			}
			if ((await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new ConflictException('The Sepolia block changed during route verification.');
			return { blockNumber: block.number, blockHash: block.hash, code, codeHash: keccak256(code) };
		});

		const now = new Date();
		const source = NATIVE_TBC_SOURCE_ID.slice(2);
		const quote = {
			protocol: 'native-tbc-burn-v1', governanceMode: 'ethereum-burn-multisig-v1', wrappedName: 'Wrapped TBC', wrappedSymbol: 'wTBC',
			destinationName: 'Ethereum Sepolia', sourceAssetKind: 'native-tbc', sourceDecimals: NATIVE_TBC_DECIMALS,
		} as Prisma.InputJsonValue;
		const deployment = await this.db.$transaction(async (tx) => {
			await tx.bridgeAsset.upsert({
				where: { routeId: SEPOLIA_NATIVE_TBC_ROUTE_ID },
				create: {
					routeId: SEPOLIA_NATIVE_TBC_ROUTE_ID, sourceNetwork: 'testnet', contractId: source, protocol: 'native-tbc', name: 'TBC', symbol: 'TBC', decimals: NATIVE_TBC_DECIMALS,
					legacyVersion: 0, totalSupplyRaw: '21000000000000', genesisCodeHash: source, genesisTapeHash: source, mintSourceTxid: source, mintSourceVout: 0,
					genesisBlockHash: source, genesisBlockHeight: 0, confirmations: 6, destinationChainId: ETHEREUM_SEPOLIA_CHAIN_ID,
					verificationMethod: 'native-tbc-sepolia-burn-v1', verifiedAt: now,
				},
				update: { verifiedAt: now, confirmations: 6 },
			});
			const existing = await tx.bridgeDeployment.findFirst({ where: { chainId: ETHEREUM_SEPOLIA_CHAIN_ID, contractAddress: wrapped.toLowerCase() } });
			if (existing && existing.identityId !== principal.id) throw new ConflictException('This shared Sepolia route is already registered to another local TBC identity.');
			const common = {
				identityId: principal.id, routeId: SEPOLIA_NATIVE_TBC_ROUTE_ID, chainId: ETHEREUM_SEPOLIA_CHAIN_ID, deployer: deployer.toLowerCase(), admin: admin.toLowerCase(),
				minter: roles.minter.toLowerCase(), contractId: source, decimals: NATIVE_TBC_DECIMALS, nonce: 0n,
				buildInputSha256: createHash('sha256').update(observed.code).digest('hex'), initCodeHash: observed.codeHash, transactionData: '0x', runtimeBytecode: observed.code,
				immutableReferences: [] as Prisma.InputJsonValue[], quote, status: 'verified', contractAddress: wrapped.toLowerCase(), confirmations: 6,
				receiptBlockHash: observed.blockHash, receiptBlockNumber: observed.blockNumber, runtimeCodeHash: observed.codeHash, verifiedAt: now, checkedAt: now, lastError: null,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			};
			if (existing) return tx.bridgeDeployment.update({ where: { id: existing.id }, data: common });
			return tx.bridgeDeployment.create({ data: common });
		});
		return {
			id: deployment.id, chainId: deployment.chainId, contractId: deployment.contractId, decimals: deployment.decimals,
			sourceName: 'TBC', sourceSymbol: 'TBC', sourceAssetKind: 'native-tbc' as const,
			wrappedName: 'Wrapped TBC', wrappedSymbol: 'wTBC', contractAddress: deployment.contractAddress!, admin: deployment.admin,
			minter: deployment.minter, verifiedAt: deployment.verifiedAt!.toISOString(), active: true,
		};
	}

	async registerFt(input: RegisterEthereumSepoliaFtRouteDto, principal: Principal, response?: Response) {
		this.auth.requireTbc(principal);
		const contractId = input.contractId.toLowerCase();
		const wrapped = getAddress(input.wrappedToken);
		const txHash = input.txHash.toLowerCase() as Hex;
		const config = environment();
		const admin = configuredAddress(config.sepoliaAdminAddress, 'SEPOLIA_BRIDGE_ADMIN_ADDRESS');
		const roles = v15OperatorRoles();
		const source = await this.assets.verify(AbortSignal.timeout(110_000), contractId);
		const metadata = sepoliaWrappedMetadata(source.name, source.symbol);
		const observed = await withSepoliaRpc(response, async (rpc) => {
			const [head, tx, receipt] = await Promise.all([
				rpc.getBlock({ blockTag: 'latest' }),
				rpc.getTransaction({ hash: txHash }),
				rpc.getTransactionReceipt({ hash: txHash }),
			]);
			if (head.number === null || !head.hash) throw new ConflictException('Sepolia has no canonical latest block.');
			if (tx.to !== null || (tx.chainId ?? 0) !== ETHEREUM_SEPOLIA_CHAIN_ID || receipt.status !== 'success'
				|| receipt.transactionHash.toLowerCase() !== txHash || receipt.contractAddress?.toLowerCase() !== wrapped.toLowerCase()) {
				throw new BadRequestException('The saved transaction is not the successful Sepolia creation of this wrapped-token contract.');
			}
			const confirmations = Number(head.number >= receipt.blockNumber ? head.number - receipt.blockNumber + 1n : 0n);
			if (confirmations < 6) throw new ConflictException(`The wrapped-token deployment needs 6 Sepolia confirmations; it currently has ${confirmations}.`);
			const birth = await rpc.getBlock({ blockNumber: receipt.blockNumber });
			if (birth.hash !== receipt.blockHash) throw new ConflictException('The wrapped-token deployment is not in the current canonical Sepolia block.');
			const readWrapped = <N extends typeof wrappedAbi[number]['name']>(functionName: N) => rpc.readContract({ address: wrapped, abi: wrappedAbi, functionName, blockNumber: head.number! });
			const readAdmin = <N extends typeof adminAbi[number]['name']>(functionName: N) => rpc.readContract({ address: admin, abi: adminAbi, functionName, blockNumber: head.number! });
			const [code, owner, minter, sourceId, sourceDecimals, sourceKind, decimals, paused, name, symbol, targetChain, signer1, signer2, threshold, adminChain] = await Promise.all([
				rpc.getCode({ address: wrapped, blockNumber: head.number }), readWrapped('owner'), readWrapped('minter'), readWrapped('sourceAssetId'),
				readWrapped('sourceDecimals'), readWrapped('sourceAssetKind'), readWrapped('decimals'), readWrapped('paused'), readWrapped('name'), readWrapped('symbol'),
				readWrapped('TARGET_CHAIN_ID'), readAdmin('signer1'), readAdmin('signer2'), readAdmin('threshold'), readAdmin('TARGET_CHAIN_ID'),
			]);
			if (!code || code === '0x') throw new ConflictException('The selected wrapped-token contract has no Sepolia bytecode.');
			if (owner.toLowerCase() !== admin.toLowerCase() || minter.toLowerCase() !== roles.minter.toLowerCase()
				|| sourceId.toLowerCase() !== `0x${contractId}` || sourceDecimals !== source.decimals || decimals !== source.decimals
				|| sourceKind !== 1 || paused || name !== metadata.wrappedName || symbol !== metadata.wrappedSymbol
				|| targetChain !== BigInt(ETHEREUM_SEPOLIA_CHAIN_ID) || signer1.toLowerCase() !== roles.signer1.toLowerCase()
				|| signer2.toLowerCase() !== roles.signer2.toLowerCase() || threshold !== 2n || adminChain !== BigInt(ETHEREUM_SEPOLIA_CHAIN_ID)) {
				throw new ConflictException('The Sepolia FT route does not match the verified TBC token, precision, wrapped metadata, active 2-of-2 Admin or mint-only relayer.');
			}
			if ((await rpc.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new ConflictException('The Sepolia block changed during FT route verification.');
			return { head, tx, receipt, confirmations, code, codeHash: keccak256(code) };
		});

		const now = new Date();
		const routeId = sepoliaFtRouteId(contractId);
		const quote = {
			protocol: 'tbc-ft-burn-v1', governanceMode: 'ethereum-burn-multisig-v1', wrappedName: metadata.wrappedName, wrappedSymbol: metadata.wrappedSymbol,
			destinationName: 'Ethereum Sepolia', sourceAssetKind: 'fungible-token', sourceDecimals: source.decimals,
		} as Prisma.InputJsonValue;
		const deployment = await this.db.$transaction(async (db) => {
			await db.bridgeAsset.upsert({
				where: { routeId },
				create: { ...source, routeId, destinationChainId: ETHEREUM_SEPOLIA_CHAIN_ID, verifiedAt: now },
				update: { verifiedAt: now, confirmations: source.confirmations },
			});
			const existing = await db.bridgeDeployment.findFirst({ where: { chainId: ETHEREUM_SEPOLIA_CHAIN_ID, contractAddress: wrapped.toLowerCase() } });
			if (existing && existing.identityId !== principal.id) throw new ConflictException('This Sepolia FT route is already registered to another local TBC identity.');
			const common = {
				identityId: principal.id, routeId, chainId: ETHEREUM_SEPOLIA_CHAIN_ID, deployer: observed.tx.from.toLowerCase(), admin: admin.toLowerCase(),
				minter: roles.minter.toLowerCase(), contractId, decimals: source.decimals, nonce: BigInt(observed.tx.nonce),
				buildInputSha256: createHash('sha256').update(observed.tx.input).digest('hex'), initCodeHash: keccak256(observed.tx.input), transactionData: observed.tx.input,
				runtimeBytecode: observed.code, immutableReferences: [] as Prisma.InputJsonValue[], quote, status: 'verified', txHash,
				contractAddress: wrapped.toLowerCase(), confirmations: observed.confirmations, receiptBlockHash: observed.receipt.blockHash,
				receiptBlockNumber: observed.receipt.blockNumber, gasUsed: observed.receipt.gasUsed.toString(), effectiveGasPriceWei: observed.receipt.effectiveGasPrice.toString(),
				actualFeeWei: (observed.receipt.gasUsed * observed.receipt.effectiveGasPrice).toString(), runtimeCodeHash: observed.codeHash,
				verifiedAt: now, checkedAt: now, lastError: null, expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			};
			if (existing) return db.bridgeDeployment.update({ where: { id: existing.id }, data: common });
			return db.bridgeDeployment.create({ data: common });
		});
		return {
			id: deployment.id, chainId: ETHEREUM_SEPOLIA_CHAIN_ID, contractId, decimals: source.decimals,
			sourceName: source.name, sourceSymbol: source.symbol, sourceAssetKind: 'fungible-token' as const,
			wrappedName: metadata.wrappedName, wrappedSymbol: metadata.wrappedSymbol, contractAddress: wrapped,
			admin, minter: roles.minter, verifiedAt: deployment.verifiedAt!.toISOString(), active: true as const,
		};
	}
}
