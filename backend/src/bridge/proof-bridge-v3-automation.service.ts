import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import {
	createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256,
	type Hex, type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { ProofBridgeRoute, ProofBridgeTransfer } from '../../generated/prisma/client';
import { LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import { environment } from '../config/environment';
import { buildTbcInclusionProof } from './phase1/tbc-proof.builder';
import { OfficialTbcApiProofSource, TbcScanProofSource } from './phase1/tbc-proof.sources';
import { ProofBridgeV3ProgressService } from './proof-bridge-v3-progress.service';
import { ProofBridgeV3Repository } from './proof-bridge-v3.repository';
import { prepareV3HeaderTransaction, testnetV3RelayAbi } from './phase3/testnet-v3-relay';

const POLL_MS = 60_000;
const SCHEDULER_MS = 5_000;
const MAX_HEADERS_PER_TICK = 2;
const DESTINATION_CONFIRMATIONS = 6n;
const gatewayMintAbi = [{
	type: 'function', name: 'mintFromProof', stateMutability: 'nonpayable',
	inputs: [{ name: 'proof', type: 'tuple', components: [
		{ name: 'blockHash', type: 'bytes32' }, { name: 'rawTransaction', type: 'bytes' },
		{ name: 'transactionIndex', type: 'uint32' }, { name: 'transactionCount', type: 'uint32' },
		{ name: 'displayedSiblings', type: 'bytes32[]' }, { name: 'parentTransactions', type: 'bytes[]' },
		{ name: 'ancestorTransactions', type: 'bytes[][]' },
		{ name: 'signatureWitnesses', type: 'tuple[]', components: [
			{ name: 'signaturePushOffset', type: 'uint32' }, { name: 'publicKeyX', type: 'bytes32' }, { name: 'publicKeyY', type: 'bytes32' },
		] },
		{ name: 'signaturePushOffsets', type: 'uint32[]' },
	] }], outputs: [{ name: 'depositId', type: 'bytes32' }],
}] as const;
const chain = defineChain({
	id: 998, name: 'HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
	rpcUrls: { default: { http: [LEARNING_BRIDGE_EVM.rpcUrl] } }, testnet: true,
});

type TransferWithRoute = ProofBridgeTransfer & { route: ProofBridgeRoute };

@Injectable()
export class ProofBridgeV3AutomationService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(ProofBridgeV3AutomationService.name);
	private readonly publicClient = createPublicClient({ chain, transport: http(LEARNING_BRIDGE_EVM.rpcUrl, { retryCount: 1, timeout: 20_000 }) });
	private account: PrivateKeyAccount | null = null;
	private timer?: NodeJS.Timeout;
	private running = false;

	constructor(
		@Inject(ProofBridgeV3Repository) private readonly repository: ProofBridgeV3Repository,
		@Inject(ProofBridgeV3ProgressService) private readonly progress: ProofBridgeV3ProgressService,
	) {}

	async onModuleInit() {
		await this.loadRelayer();
		this.timer = setInterval(() => { void this.tick(); }, SCHEDULER_MS); this.timer.unref();
		void this.tick();
	}
	onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

	private async loadRelayer() {
		const path = environment().phase3RelayerKeyFile;
		if (!path) {
			this.progress.setRelayer({ mode: 'observe-only', address: null, balanceWei: null });
			this.logger.warn('V3 observer is active, but PHASE3_RELAYER_KEY_FILE is unset; no HyperEVM transaction can be signed.');
			return;
		}
		const metadata = await stat(path);
		const writableByOthers = (metadata.mode & 0o022) !== 0;
		if (!metadata.isFile() || writableByOthers) throw new Error('PHASE3_RELAYER_KEY_FILE must be a regular file that is not group/world writable.');
		const value = (await readFile(path, 'utf8')).trim();
		if (!/^(?:0x)?[0-9a-f]{64}$/i.test(value)) throw new Error('PHASE3_RELAYER_KEY_FILE does not contain one 32-byte private key.');
		this.account = privateKeyToAccount(`0x${value.replace(/^0x/i, '')}`);
		const balance = await this.publicClient.getBalance({ address: this.account.address }).catch(() => null);
		this.progress.setRelayer({ mode: 'automatic', address: this.account.address, balanceWei: balance?.toString() ?? null });
		this.logger.log(`V3 automatic relayer enabled at ${this.account.address}. Private key material was not logged.`);
	}

	private async tick() {
		if (this.running) return;
		this.running = true;
		try {
			const rows = await this.repository.pending(new Date(Date.now() - POLL_MS));
			if (rows[0]) {
				if (this.account) {
					const balance = await this.publicClient.getBalance({ address: this.account.address }).catch(() => null);
					this.progress.setRelayer({ mode: 'automatic', address: this.account.address, balanceWei: balance?.toString() ?? null });
				}
				await this.advance(rows[0]);
			}
		} catch (cause) { this.logger.warn({ error: cause instanceof Error ? cause.message : 'Unknown V3 automation failure' }); }
		finally { this.running = false; }
	}

	private async update(row: TransferWithRoute, data: Parameters<ProofBridgeV3Repository['update']>[1]) {
		const next = await this.repository.update(row.id, data);
		await this.progress.publish(row.identityId);
		return next;
	}

	private async advance(row: TransferWithRoute) {
		try {
			if (row.status === 'mint_submitted' && row.mintTxHash) return await this.observeMint(row);
			const confirmed = await this.observeSource(row);
			if (!confirmed || confirmed.confirmations < 6) return;
			if (!this.account) {
				await this.update(row, { status: 'relaying_headers', checkedAt: new Date(), lastError: 'Automatic relayer is observe-only until an owner-only PHASE3_RELAYER_KEY_FILE is configured.' });
				return;
			}
			const relayed = await this.relayTowardFinality(row, confirmed.blockHeight + 5);
			if (!relayed) return;
			await this.mint(row, confirmed);
		} catch (cause) {
			const failureCount = row.failureCount + 1;
			// Never roll a transfer back to the stale status read at the beginning
			// of this tick. A later persisted state may already contain a signed raw
			// transaction whose nonce/hash must remain authoritative.
			await this.update(row, { failureCount, checkedAt: new Date(), lastError: (cause instanceof Error ? cause.message : 'V3 automation failed').slice(0, 1000) });
			throw cause;
		}
	}

	private async observeSource(row: TransferWithRoute) {
		const officialSource = new OfficialTbcApiProofSource(); const scanSource = new TbcScanProofSource();
		const [official, scan] = await Promise.all([officialSource.locateTransaction(row.sourceTxid), scanSource.locateTransaction(row.sourceTxid)]);
		if (official.confirmed !== scan.confirmed || official.blockHeight !== scan.blockHeight || official.blockHash !== scan.blockHash) throw new Error('Official TBC API and TBCScan disagree on the V3 deposit location.');
		const confirmations = Math.min(official.confirmations ?? 0, scan.confirmations ?? 0);
		if (!official.confirmed || official.blockHeight === null || official.blockHash === null) {
			await this.update(row, { status: 'confirming_source', sourceConfirmations: confirmations, failureCount: 0, checkedAt: new Date(), lastError: null });
			return null;
		}
		await this.update(row, { status: confirmations >= 6 ? 'relaying_headers' : 'confirming_source', sourceConfirmations: confirmations, blockHeight: official.blockHeight, blockHash: `0x${official.blockHash}`, failureCount: 0, checkedAt: new Date(), lastError: null });
		return { confirmations, blockHeight: official.blockHeight, blockHash: `0x${official.blockHash}` as Hex };
	}

	private async relayTowardFinality(row: TransferWithRoute, targetHeight: number) {
		const account = this.account!;
		const wallet = createWalletClient({ account, chain, transport: http(LEARNING_BRIDGE_EVM.rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		if (row.relayPendingTxHash && row.relayPendingRaw && row.relayPendingHeight !== null) {
			let receipt: TransactionReceipt;
			try { receipt = await this.publicClient.getTransactionReceipt({ hash: row.relayPendingTxHash as Hex }); }
			catch {
				await this.publicClient.sendRawTransaction({ serializedTransaction: row.relayPendingRaw as Hex }).catch(() => undefined);
				await this.update(row, { checkedAt: new Date(), lastError: null });
				return false;
			}
			if (receipt.status !== 'success') {
				await this.update(row, { status: 'needs_review', checkedAt: new Date(), lastError: `V3 header ${row.relayPendingHeight} relay reverted. The persisted transaction will not be replaced automatically.` });
				return false;
			}
			await this.update(row, { relayHeight: row.relayPendingHeight, relayPendingHeight: null, relayPendingTxHash: null, relayPendingRaw: null, relayPendingNonce: null, failureCount: 0, checkedAt: new Date(), lastError: null });
		}
		for (let count = 0; count < MAX_HEADERS_PER_TICK; count++) {
			const plan = await prepareV3HeaderTransaction(row.route.relay, account.address);
			if (plan.parentHeight >= targetHeight) break;
			const [balance, gasPrice, block] = await Promise.all([
				this.publicClient.getBalance({ address: account.address, blockTag: 'pending' }),
				this.publicClient.getGasPrice(), this.publicClient.getBlock({ blockTag: 'latest' }),
			]);
			const gas = plan.gas * 120n / 100n;
			if (gas > block.gasLimit) throw new Error(`Verified header ${plan.targetHeight} exceeds the current HyperEVM block gas limit.`);
			if (balance < gas * gasPrice) throw new Error('Automatic relayer HYPE balance is insufficient for the next verified header.');
			const nonce = await this.publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
			const serialized = await wallet.signTransaction({ account, chain, to: plan.relay, data: plan.data, gas, gasPrice, nonce });
			const hash = keccak256(serialized);
			await this.update(row, { relayPendingHeight: plan.targetHeight, relayPendingTxHash: hash, relayPendingRaw: serialized, relayPendingNonce: nonce, checkedAt: new Date(), lastError: null });
			const submittedHash = await this.publicClient.sendRawTransaction({ serializedTransaction: serialized }).catch(() => hash);
			if (submittedHash.toLowerCase() !== hash.toLowerCase()) {
				await this.update(row, { status: 'needs_review', checkedAt: new Date(), lastError: 'HyperEVM returned a different header transaction hash; automation stopped before any replacement transaction.' });
				return false;
			}
			const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
			if (receipt.status !== 'success') {
				await this.update(row, { status: 'needs_review', checkedAt: new Date(), lastError: `V3 header ${plan.targetHeight} relay reverted. The persisted transaction will not be replaced automatically.` });
				return false;
			}
			await this.update(row, { status: 'relaying_headers', relayHeight: plan.targetHeight, relayPendingHeight: null, relayPendingTxHash: null, relayPendingRaw: null, relayPendingNonce: null, failureCount: 0, checkedAt: new Date(), lastError: null });
			if (plan.targetHeight >= targetHeight) break;
		}
		const bestTip = await this.publicClient.readContract({ address: getAddress(row.route.relay), abi: testnetV3RelayAbi, functionName: 'bestTip' });
		const best = await this.publicClient.readContract({ address: getAddress(row.route.relay), abi: testnetV3RelayAbi, functionName: 'header', args: [bestTip] });
		return Number(best.height) >= targetHeight;
	}

	private async mint(row: TransferWithRoute, source: { confirmations: number; blockHeight: number; blockHash: Hex }) {
		const blockHash = source.blockHash;
		const finalized = await this.publicClient.readContract({ address: getAddress(row.route.relay), abi: testnetV3RelayAbi, functionName: 'isFinalized', args: [blockHash] });
		if (!finalized) throw new Error('V3 Relay has not finalized the confirmed source block.');
		const [officialProof, scanProof, block] = await Promise.all([
			buildTbcInclusionProof(new OfficialTbcApiProofSource(), row.sourceTxid, 1),
			buildTbcInclusionProof(new TbcScanProofSource(), row.sourceTxid, 1),
			new OfficialTbcApiProofSource().readBlock(source.blockHeight),
		]);
		if (JSON.stringify(officialProof.proofMaterial) !== JSON.stringify(scanProof.proofMaterial)) throw new Error('TBC proof sources disagree on the V3 inclusion proof.');
		const material = officialProof.proofMaterial;
		if (material.rawTransaction !== row.sourceRaw || material.blockHeight !== source.blockHeight || block.hash !== material.blockHash || `0x${material.blockHash}`.toLowerCase() !== blockHash.toLowerCase()) {
			throw new Error('The independently rebuilt inclusion proof differs from the immutable signed deposit or its finalized source block.');
		}
		const siblings = material.merkleBranch.map((value) => `0x${value.hash}` as Hex);
		await this.update(row, { status: 'ready_to_mint', transactionIndex: material.transactionIndex, transactionCount: block.transactionCount, merkleSiblings: siblings, failureCount: 0, checkedAt: new Date(), lastError: null });
		const account = this.account!; const gateway = getAddress(row.route.gateway);
		const parentTransactions = row.parentTransactions as unknown as string[];
		const ancestorTransactions = row.ancestorTransactions as unknown as string[][];
		const signatureWitnesses = row.signatureWitnesses as unknown as Array<{ signaturePushOffset: number; publicKeyX: Hex; publicKeyY: Hex }>;
		const signaturePushOffsets = row.signaturePushOffsets as unknown as number[];
		const proof = {
			blockHash, rawTransaction: `0x${row.sourceRaw}` as Hex, transactionIndex: material.transactionIndex, transactionCount: block.transactionCount,
			displayedSiblings: siblings,
			parentTransactions: parentTransactions.map((value) => `0x${value}` as Hex),
			ancestorTransactions: ancestorTransactions.map((group) => group.map((value) => `0x${value}` as Hex)),
			signatureWitnesses, signaturePushOffsets,
		};
		const data = encodeFunctionData({ abi: gatewayMintAbi, functionName: 'mintFromProof', args: [proof] });
		await this.publicClient.call({ account: account.address, to: gateway, data });
		const estimate = await this.publicClient.estimateGas({ account: account.address, to: gateway, data });
		const gas = estimate * 120n / 100n;
		const [gasPrice, balance, latestBlock] = await Promise.all([
			this.publicClient.getGasPrice(), this.publicClient.getBalance({ address: account.address, blockTag: 'pending' }),
			this.publicClient.getBlock({ blockTag: 'latest' }),
		]);
		if (gas > latestBlock.gasLimit) throw new Error('Proof mint exceeds the current HyperEVM block gas limit. No transaction was submitted.');
		if (balance < gas * gasPrice) throw new Error('Automatic relayer HYPE balance is insufficient for proof mint.');
		const wallet = createWalletClient({ account, chain, transport: http(LEARNING_BRIDGE_EVM.rpcUrl, { retryCount: 1, timeout: 20_000 }) });
		const nonce = await this.publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
		const serialized = await wallet.signTransaction({ account, chain, to: gateway, data, gas, gasPrice, nonce });
		const hash = keccak256(serialized);
		await this.update(row, { status: 'mint_submitted', mintTxHash: hash, mintRawTransaction: serialized, mintNonce: nonce, checkedAt: new Date(), lastError: null });
		const submittedHash = await this.publicClient.sendRawTransaction({ serializedTransaction: serialized }).catch(() => hash);
		if (submittedHash.toLowerCase() !== hash.toLowerCase()) {
			await this.update(row, { status: 'needs_review', checkedAt: new Date(), lastError: 'HyperEVM returned a different proof-mint transaction hash; automation stopped before any replacement transaction.' });
			return;
		}
		await this.observeMint({ ...row, status: 'mint_submitted', mintTxHash: hash });
	}

	private async observeMint(row: TransferWithRoute) {
		let receipt: TransactionReceipt;
		try { receipt = await this.publicClient.getTransactionReceipt({ hash: row.mintTxHash as Hex }); }
		catch {
			if (row.mintRawTransaction) await this.publicClient.sendRawTransaction({ serializedTransaction: row.mintRawTransaction as Hex }).catch(() => undefined);
			await this.update(row, { checkedAt: new Date(), lastError: null });
			return;
		}
		if (receipt.status !== 'success') {
			await this.update(row, { status: 'needs_review', checkedAt: new Date(), lastError: 'The proof-mint transaction reverted; replay protection prevents blind retries.' });
			return;
		}
		const latestBlock = await this.publicClient.getBlockNumber();
		const confirmations = latestBlock >= receipt.blockNumber ? latestBlock - receipt.blockNumber + 1n : 0n;
		if (confirmations < DESTINATION_CONFIRMATIONS) {
			await this.update(row, { mintBlockNumber: receipt.blockNumber, mintConfirmations: Number(confirmations), mintGasUsed: receipt.gasUsed.toString(), mintFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), checkedAt: new Date(), lastError: null });
			return;
		}
		await this.update(row, { status: 'completed', mintBlockNumber: receipt.blockNumber, mintConfirmations: Number(confirmations), mintGasUsed: receipt.gasUsed.toString(), mintFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), completedAt: new Date(), checkedAt: new Date(), lastError: null });
	}
}
