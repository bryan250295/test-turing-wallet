import { ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import {
	createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData,
	getAddress, http, keccak256, parseAbi, parseAbiParameters, TransactionNotFoundError,
	TransactionReceiptNotFoundError, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { BridgeAdminActivation, BridgeDeployment } from '../../generated/prisma/client';
import { LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import { environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { v15OperatorRoles } from './bridge.config';
import { ETHEREUM_SEPOLIA_CHAIN_ID } from './ethereum-sepolia-rpc';

const adminAbi = parseAbi([
	'function signer1() view returns (address)', 'function signer2() view returns (address)',
	'function threshold() view returns (uint256)', 'function TARGET_CHAIN_ID() view returns (uint256)',
	'function nonce() view returns (uint256)',
	'function action(bytes32 actionId) view returns (address target, bytes data, bool executed)',
	'function approved(bytes32 actionId,address signer) view returns (bool)',
	'function propose(address target,bytes data) returns (bytes32 actionId)',
	'function approveAndExecute(bytes32 actionId) returns (bytes returnData)',
	'event ActionProposed(bytes32 indexed actionId,address indexed proposer,address indexed target,bytes data)',
	'event ActionApproved(bytes32 indexed actionId,address indexed signer)',
	'event ActionExecuted(bytes32 indexed actionId,address indexed target)',
]);
const wrappedAbi = parseAbi(['function unpause()', 'function paused() view returns (bool)', 'function owner() view returns (address)']);
const unpauseData = encodeFunctionData({ abi: wrappedAbi, functionName: 'unpause' });
const active = ['proposal_signed', 'proposal_submitted', 'proposal_confirming', 'proposal_verified', 'approval_signed', 'approval_submitted', 'approval_confirming'];

const hyperEvm = defineChain({
	id: 998, name: 'HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
	rpcUrls: { default: { http: [LEARNING_BRIDGE_EVM.rpcUrl] } }, testnet: true,
});
function sepolia() {
	const rpc = environment().sepoliaRpcUrl;
	return defineChain({ id: ETHEREUM_SEPOLIA_CHAIN_ID, name: 'Ethereum Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } }, testnet: true });
}

type Phase = 'proposal' | 'approval';
type Signed = { nonce: bigint; data: Hex; gasLimit: bigint; gasPriceWei: bigint; raw: Hex; txHash: Hex };

@Injectable()
export class BridgeAdminRelayerService implements OnModuleInit {
	private readonly logger = new Logger(BridgeAdminRelayerService.name);
	private signer1: PrivateKeyAccount | null = null;
	private signer2: PrivateKeyAccount | null = null;
	private busy = false;

	constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

	private async key(path: string, label: string) {
		const metadata = await stat(path);
		if (metadata.isCharacterDevice()) return null;
		if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error(`${label} must be an owner-only regular file (chmod 600).`);
		const value = (await readFile(path, 'utf8')).trim();
		if (!/^(?:0x)?[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} does not contain one 32-byte private key.`);
		return privateKeyToAccount(`0x${value.replace(/^0x/i, '')}`);
	}

	async onModuleInit() {
		const config = environment();
		if (!config.v15AdminSigner1KeyFile && !config.v15AdminSigner2KeyFile) {
			this.logger.warn('Automatic 2-of-2 Admin activation is disabled: signer key files are unset. MetaMask activation remains available.');
			return;
		}
		if (!config.v15AdminSigner1KeyFile || !config.v15AdminSigner2KeyFile) throw new Error('Set both V15_ADMIN_SIGNER_1_KEY_FILE and V15_ADMIN_SIGNER_2_KEY_FILE, or leave both unset.');
		const [first, second] = await Promise.all([
			this.key(config.v15AdminSigner1KeyFile, 'V15_ADMIN_SIGNER_1_KEY_FILE'),
			this.key(config.v15AdminSigner2KeyFile, 'V15_ADMIN_SIGNER_2_KEY_FILE'),
		]);
		if (!first && !second) {
			this.logger.warn('Automatic 2-of-2 Admin activation is disabled: signer key files are unset. MetaMask activation remains available.');
			return;
		}
		if (!first || !second) throw new Error('Both V1.5 Admin signer key files are required for automatic activation.');
		const roles = v15OperatorRoles();
		if (first.address.toLowerCase() !== roles.signer1.toLowerCase()) throw new Error('V15_ADMIN_SIGNER_1_KEY_FILE does not belong to V15_ADMIN_SIGNER_1.');
		if (second.address.toLowerCase() !== roles.signer2.toLowerCase()) throw new Error('V15_ADMIN_SIGNER_2_KEY_FILE does not belong to V15_ADMIN_SIGNER_2.');
		this.signer1 = first; this.signer2 = second;
		this.logger.warn(`Automatic testnet Admin activation enabled for ${first.address} and ${second.address}. Both keys share this backend trust boundary; key material was not logged.`);
	}

	isConfigured() { return this.signer1 !== null && this.signer2 !== null; }

	private transport(chainId: number) {
		if (chainId === 998) return { chain: hyperEvm, rpcUrl: LEARNING_BRIDGE_EVM.rpcUrl, confirmations: LEARNING_BRIDGE_EVM.deploymentConfirmations };
		if (chainId === ETHEREUM_SEPOLIA_CHAIN_ID) return { chain: sepolia(), rpcUrl: environment().sepoliaRpcUrl, confirmations: 6 };
		throw new ConflictException('Automatic Admin activation is restricted to the configured test networks.');
	}

	private actionId(chainId: number, admin: Address, nonce: bigint, target: Address) {
		return keccak256(encodeAbiParameters(parseAbiParameters('uint256,address,uint256,address,bytes32'), [BigInt(chainId), admin, nonce, target, keccak256(unpauseData)]));
	}

	private async state(deployment: BridgeDeployment) {
		if (!deployment.contractAddress) throw new ConflictException('The verified wrapped-token address is missing.');
		const { chain, rpcUrl } = this.transport(deployment.chainId);
		const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		const admin = getAddress(deployment.admin); const target = getAddress(deployment.contractAddress);
		const block = await client.getBlock({ blockTag: 'latest' });
		if (block.number === null || !block.hash) throw new ConflictException('No canonical Admin block is available.');
		const [signer1, signer2, threshold, targetChain, owner, paused] = await Promise.all([
			client.readContract({ address: admin, abi: adminAbi, functionName: 'signer1', blockNumber: block.number }),
			client.readContract({ address: admin, abi: adminAbi, functionName: 'signer2', blockNumber: block.number }),
			client.readContract({ address: admin, abi: adminAbi, functionName: 'threshold', blockNumber: block.number }),
			client.readContract({ address: admin, abi: adminAbi, functionName: 'TARGET_CHAIN_ID', blockNumber: block.number }),
			client.readContract({ address: target, abi: wrappedAbi, functionName: 'owner', blockNumber: block.number }),
			client.readContract({ address: target, abi: wrappedAbi, functionName: 'paused', blockNumber: block.number }),
		]);
		const roles = v15OperatorRoles();
		if (signer1.toLowerCase() !== roles.signer1.toLowerCase() || signer2.toLowerCase() !== roles.signer2.toLowerCase()
			|| threshold !== 2n || targetChain !== BigInt(deployment.chainId) || owner.toLowerCase() !== admin.toLowerCase())
			throw new ConflictException('The target is not owned by the configured chain-bound 2-of-2 Admin.');
		if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash || await client.getChainId() !== deployment.chainId)
			throw new ConflictException('The Admin chain changed during activation verification.');
		return { client, block, admin, target, paused };
	}

	private async sign(deployment: BridgeDeployment, account: PrivateKeyAccount, to: Address, data: Hex): Promise<Signed> {
		const { chain, rpcUrl } = this.transport(deployment.chainId);
		const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		const block = await client.getBlock({ blockTag: 'latest' });
		if (block.number === null || !block.hash) throw new ConflictException('No canonical block is available for Admin fee estimation.');
		const [balance, code, nonce, gasPrice, estimate] = await Promise.all([
			client.getBalance({ address: account.address, blockNumber: block.number }),
			client.getCode({ address: account.address, blockNumber: block.number }),
			client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
			client.getGasPrice(),
			client.estimateGas({ account: account.address, to, data, value: 0n, blockNumber: block.number, prepare: false }),
		]);
		if (code && code !== '0x') throw new ConflictException('Configured Admin signers must be ordinary EVM accounts.');
		if (!Number.isSafeInteger(nonce) || nonce < 0) throw new ConflictException('An Admin signer nonce is outside the supported range.');
		const gasLimit = (estimate * 120n + 99n) / 100n;
		if (estimate <= 0n || gasLimit > block.gasLimit || gasPrice <= 0n || balance < gasLimit * gasPrice) throw new ConflictException('An Admin signer needs more test-network gas before automatic activation can continue.');
		if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash || await client.getChainId() !== deployment.chainId) throw new ConflictException('The Admin block changed during fee estimation.');
		const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		const raw = await wallet.signTransaction({ account, chain, to, data, value: 0n, gas: gasLimit, gasPrice, nonce });
		return { nonce: BigInt(nonce), data, gasLimit, gasPriceWei: gasPrice, raw, txHash: keccak256(raw) };
	}

	private async createProposal(deployment: BridgeDeployment) {
		const { client, admin, target, paused } = await this.state(deployment);
		if (!paused) return;
		const adminNonce = await client.readContract({ address: admin, abi: adminAbi, functionName: 'nonce' });
		const actionId = this.actionId(deployment.chainId, admin, adminNonce, target);
		const data = encodeFunctionData({ abi: adminAbi, functionName: 'propose', args: [target, unpauseData] });
		const signed = await this.sign(deployment, this.signer1!, admin, data);
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`bridge-admin:${deployment.chainId}:${admin.toLowerCase()}`}, 0))`;
			const existing = await tx.bridgeAdminActivation.findUnique({ where: { deploymentId: deployment.id } });
			if (existing) return;
			if (await tx.bridgeAdminActivation.count({ where: { status: { in: active }, chainId: deployment.chainId } })) throw new ConflictException('Another automatic Admin activation must finish before this route.');
			await tx.bridgeAdminActivation.create({ data: {
				deploymentId: deployment.id, identityId: deployment.identityId, chainId: deployment.chainId,
				adminAddress: admin.toLowerCase(), targetAddress: target.toLowerCase(), actionId,
				proposalNonce: signed.nonce, proposalData: signed.data, proposalGasLimit: signed.gasLimit,
				proposalGasPriceWei: signed.gasPriceWei.toString(), proposalRawTransaction: signed.raw,
				proposalTxHash: signed.txHash, checkedAt: new Date(),
			} });
			await tx.auditEvent.create({ data: { identityId: deployment.identityId, action: 'bridge.admin.proposal_signed', data: { deploymentId: deployment.id, actionId, txHash: signed.txHash } } });
		});
	}

	private async createApproval(deployment: BridgeDeployment, row: BridgeAdminActivation) {
		const { client, admin, target, paused } = await this.state(deployment);
		if (!paused) throw new ConflictException('The route became active before the saved approval was created. Review the Admin history.');
		const [action, first, second] = await Promise.all([
			client.readContract({ address: admin, abi: adminAbi, functionName: 'action', args: [row.actionId as Hex] }),
			client.readContract({ address: admin, abi: adminAbi, functionName: 'approved', args: [row.actionId as Hex, this.signer1!.address] }),
			client.readContract({ address: admin, abi: adminAbi, functionName: 'approved', args: [row.actionId as Hex, this.signer2!.address] }),
		]);
		if (action[0].toLowerCase() !== target.toLowerCase() || action[1].toLowerCase() !== unpauseData.toLowerCase() || action[2] || !first || second) throw new ConflictException('The confirmed Admin proposal no longer matches the exact unpause action.');
		const data = encodeFunctionData({ abi: adminAbi, functionName: 'approveAndExecute', args: [row.actionId as Hex] });
		const signed = await this.sign(deployment, this.signer2!, admin, data);
		const changed = await this.db.bridgeAdminActivation.updateMany({ where: { deploymentId: deployment.id, status: 'proposal_verified', approvalTxHash: null, updatedAt: row.updatedAt }, data: {
			status: 'approval_signed', approvalNonce: signed.nonce, approvalData: signed.data, approvalGasLimit: signed.gasLimit,
			approvalGasPriceWei: signed.gasPriceWei.toString(), approvalRawTransaction: signed.raw, approvalTxHash: signed.txHash,
			checkedAt: new Date(), lastError: null,
		} });
		if (changed.count !== 1) throw new ConflictException('The saved Admin proposal changed before approval signing completed.');
		await this.db.auditEvent.create({ data: { identityId: deployment.identityId, action: 'bridge.admin.approval_signed', data: { deploymentId: deployment.id, actionId: row.actionId, txHash: signed.txHash } } });
	}

	private fields(row: BridgeAdminActivation, phase: Phase) {
		if (phase === 'proposal') return { raw: row.proposalRawTransaction as Hex, hash: row.proposalTxHash as Hex, nonce: row.proposalNonce, data: row.proposalData as Hex, status: row.status };
		if (!row.approvalRawTransaction || !row.approvalTxHash || row.approvalNonce === null || !row.approvalData) throw new ConflictException('The saved Admin approval transaction is incomplete.');
		return { raw: row.approvalRawTransaction as Hex, hash: row.approvalTxHash as Hex, nonce: row.approvalNonce, data: row.approvalData as Hex, status: row.status };
	}

	private async broadcast(deployment: BridgeDeployment, row: BridgeAdminActivation, phase: Phase) {
		const saved = this.fields(row, phase); const { chain, rpcUrl } = this.transport(deployment.chainId);
		const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		try {
			const hash = await client.sendRawTransaction({ serializedTransaction: saved.raw });
			if (hash.toLowerCase() !== saved.hash.toLowerCase()) throw new ConflictException('The Admin RPC returned a different transaction hash.');
			const next = phase === 'proposal' ? 'proposal_submitted' : 'approval_submitted';
			await this.db.bridgeAdminActivation.updateMany({ where: { deploymentId: deployment.id, status: phase === 'proposal' ? 'proposal_signed' : 'approval_signed' }, data: { status: next, checkedAt: new Date(), lastError: null } });
		} catch (cause) {
			if (cause instanceof ConflictException) throw cause;
			// An ambiguous submission is safe: the exact signed nonce/hash remains
			// durable and the next pass re-broadcasts only those same bytes.
			await this.db.bridgeAdminActivation.update({ where: { deploymentId: deployment.id }, data: { checkedAt: new Date(), lastError: 'Admin submission is not visible yet; retrying the exact saved transaction only.' } });
		}
	}

	private async observe(deployment: BridgeDeployment, row: BridgeAdminActivation, phase: Phase) {
		const saved = this.fields(row, phase); const { chain, rpcUrl, confirmations: required } = this.transport(deployment.chainId);
		const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		let tx;
		try { tx = await client.getTransaction({ hash: saved.hash }); }
		catch (cause) { if (cause instanceof TransactionNotFoundError) { await this.broadcast(deployment, row, phase); return false; } throw cause; }
		if ((tx.chainId ?? 0) !== deployment.chainId || tx.from.toLowerCase() !== (phase === 'proposal' ? this.signer1!.address : this.signer2!.address).toLowerCase()
			|| tx.to?.toLowerCase() !== row.adminAddress || tx.input.toLowerCase() !== saved.data.toLowerCase() || tx.value !== 0n || BigInt(tx.nonce) !== saved.nonce)
			throw new ConflictException('The saved Admin transaction differs from its frozen signer, nonce, target or calldata.');
		let receipt;
		try { receipt = await client.getTransactionReceipt({ hash: saved.hash }); }
		catch (cause) { if (cause instanceof TransactionReceiptNotFoundError) { await this.broadcast(deployment, row, phase); return false; } throw cause; }
		const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
		if (block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || head < receipt.blockNumber) return false;
		const confirmations = Number(head - receipt.blockNumber + 1n); const actualFee = receipt.gasUsed * receipt.effectiveGasPrice;
		if (receipt.status !== 'success') throw new ConflictException(`The automatic Admin ${phase} transaction reverted.`);
		if (confirmations < required) {
			await this.db.bridgeAdminActivation.update({ where: { deploymentId: deployment.id }, data: phase === 'proposal'
				? { status: 'proposal_confirming', proposalConfirmations: confirmations, proposalReceiptBlockHash: receipt.blockHash, proposalReceiptBlockNumber: receipt.blockNumber, proposalActualFeeWei: actualFee.toString(), checkedAt: new Date(), lastError: null }
				: { status: 'approval_confirming', approvalConfirmations: confirmations, approvalReceiptBlockHash: receipt.blockHash, approvalReceiptBlockNumber: receipt.blockNumber, approvalActualFeeWei: actualFee.toString(), checkedAt: new Date(), lastError: null } });
			return false;
		}
		const events = receipt.logs.filter((log) => log.address.toLowerCase() === row.adminAddress).flatMap((log) => {
			try { return [decodeEventLog({ abi: adminAbi, data: log.data, topics: log.topics, strict: true })]; } catch { return []; }
		});
		if (phase === 'proposal') {
			const proposed = events.filter((event) => event.eventName === 'ActionProposed');
			if (proposed.length !== 1 || proposed[0].args.actionId !== row.actionId || proposed[0].args.target.toLowerCase() !== row.targetAddress || proposed[0].args.data.toLowerCase() !== unpauseData.toLowerCase()) throw new ConflictException('The automatic Admin proposal event does not match the saved action.');
			const [action, first, second] = await Promise.all([
				client.readContract({ address: row.adminAddress as Address, abi: adminAbi, functionName: 'action', args: [row.actionId as Hex], blockNumber: receipt.blockNumber }),
				client.readContract({ address: row.adminAddress as Address, abi: adminAbi, functionName: 'approved', args: [row.actionId as Hex, this.signer1!.address], blockNumber: receipt.blockNumber }),
				client.readContract({ address: row.adminAddress as Address, abi: adminAbi, functionName: 'approved', args: [row.actionId as Hex, this.signer2!.address], blockNumber: receipt.blockNumber }),
			]);
			if (action[0].toLowerCase() !== row.targetAddress || action[1].toLowerCase() !== unpauseData.toLowerCase() || action[2] || !first || second) throw new ConflictException('The confirmed Admin proposal state is invalid.');
			await this.db.bridgeAdminActivation.update({ where: { deploymentId: deployment.id }, data: { status: 'proposal_verified', proposalConfirmations: confirmations, proposalReceiptBlockHash: receipt.blockHash, proposalReceiptBlockNumber: receipt.blockNumber, proposalActualFeeWei: actualFee.toString(), checkedAt: new Date(), lastError: null } });
			return false;
		}
		const executed = events.filter((event) => event.eventName === 'ActionExecuted');
		const approved = events.filter((event) => event.eventName === 'ActionApproved');
		if (executed.length !== 1 || approved.length !== 1 || executed[0].args.actionId !== row.actionId || executed[0].args.target.toLowerCase() !== row.targetAddress || approved[0].args.actionId !== row.actionId || approved[0].args.signer.toLowerCase() !== this.signer2!.address.toLowerCase()) throw new ConflictException('The automatic Admin approval events do not match the saved action.');
		const [action, first, second, paused] = await Promise.all([
			client.readContract({ address: row.adminAddress as Address, abi: adminAbi, functionName: 'action', args: [row.actionId as Hex], blockNumber: receipt.blockNumber }),
			client.readContract({ address: row.adminAddress as Address, abi: adminAbi, functionName: 'approved', args: [row.actionId as Hex, this.signer1!.address], blockNumber: receipt.blockNumber }),
			client.readContract({ address: row.adminAddress as Address, abi: adminAbi, functionName: 'approved', args: [row.actionId as Hex, this.signer2!.address], blockNumber: receipt.blockNumber }),
			client.readContract({ address: row.targetAddress as Address, abi: wrappedAbi, functionName: 'paused', blockNumber: receipt.blockNumber }),
		]);
		if (action[0].toLowerCase() !== row.targetAddress || action[1].toLowerCase() !== unpauseData.toLowerCase() || !action[2] || !first || !second || paused) throw new ConflictException('The confirmed Admin execution did not activate the wrapped-token route.');
		await this.db.$transaction([
			this.db.bridgeAdminActivation.update({ where: { deploymentId: deployment.id }, data: { status: 'completed', approvalConfirmations: confirmations, approvalReceiptBlockHash: receipt.blockHash, approvalReceiptBlockNumber: receipt.blockNumber, approvalActualFeeWei: actualFee.toString(), checkedAt: new Date(), lastError: null } }),
			this.db.auditEvent.create({ data: { identityId: deployment.identityId, action: 'bridge.admin.activation_completed', data: { deploymentId: deployment.id, actionId: row.actionId, proposalTxHash: row.proposalTxHash, approvalTxHash: row.approvalTxHash } } }),
		]);
		return true;
	}

	private async fail(deployment: BridgeDeployment, message: string) {
		await this.db.bridgeAdminActivation.updateMany({ where: { deploymentId: deployment.id, status: { in: active } }, data: { status: 'needs_review', checkedAt: new Date(), lastError: message.slice(0, 1000) } });
	}

	async advance(deployment: BridgeDeployment): Promise<boolean> {
		if (!this.isConfigured()) return false;
		if (this.busy) return false;
		this.busy = true;
		try {
			const current = await this.state(deployment);
			if (!current.paused) {
				await this.db.bridgeAdminActivation.updateMany({ where: { deploymentId: deployment.id, status: { not: 'completed' } }, data: { status: 'completed', checkedAt: new Date(), lastError: null } });
				return true;
			}
			let row = await this.db.bridgeAdminActivation.findUnique({ where: { deploymentId: deployment.id } });
			if (!row) {
				await this.createProposal(deployment);
				row = await this.db.bridgeAdminActivation.findUnique({ where: { deploymentId: deployment.id } });
				if (!row) return false;
			}
			if (row.status === 'needs_review') throw new ConflictException(row.lastError ?? 'Automatic Admin activation needs review.');
			if (row.status === 'completed') throw new ConflictException('The saved Admin activation is complete but the wrapped token is paused. Manual review is required.');
			if (['proposal_signed', 'proposal_submitted', 'proposal_confirming'].includes(row.status)) return this.observe(deployment, row, 'proposal');
			if (row.status === 'proposal_verified') {
				await this.createApproval(deployment, row);
				row = await this.db.bridgeAdminActivation.findUniqueOrThrow({ where: { deploymentId: deployment.id } });
			}
			if (['approval_signed', 'approval_submitted', 'approval_confirming'].includes(row.status)) return this.observe(deployment, row, 'approval');
			return false;
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : 'Automatic Admin activation failed.';
			if (/differs|reverted|invalid|no longer matches|did not activate|needs review|complete but/i.test(message)) await this.fail(deployment, message);
			throw cause;
		} finally { this.busy = false; }
	}
}
