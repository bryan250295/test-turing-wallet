import { Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import { API_URLS, DEVNET_API_BASE } from '../../../shared/src/config/constants';
import { ApiError } from '../../../shared/src/services/apiClient';
import type { VerifiedBridgeAsset } from '../../../shared/src/types/learningBridge';
import { bridgeRouteId } from '../../../shared/src/config/bridgeRoutes';
import { BRIDGE_ASSET_POLICY as policy } from './bridge.config';
import { decodeLegacyFtCode, isLegacyFtTape } from './legacy-ft-code';
import { readBridgeSource } from './bridge-source-read';

function requireMatch(condition: unknown, message: string): asserts condition {
	if (!condition) throw new UnprocessableEntityException(message);
}

function transaction(raw: unknown, txid: string) {
	requireMatch(typeof raw === 'string' && /^(?:[0-9a-f]{2})+$/i.test(raw) && raw.length <= 2_000_000, 'Invalid genesis transaction bytes.');
	try {
		const tx = new tbc.Transaction(raw);
		requireMatch(tx.hash === txid && tx.toBuffer().toString('hex') === raw.toLowerCase(), 'The raw transaction does not match its Contract ID.');
		return tx;
	} catch (cause) {
		if (cause instanceof UnprocessableEntityException) throw cause;
		throw new UnprocessableEntityException('Unsupported genesis transaction encoding.');
	}
}

function metadataText(value: Buffer | undefined, label: string, maxBytes: number) {
	requireMatch(value && value.length > 0 && value.length <= maxBytes, `Invalid FT ${label}.`);
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
		requireMatch(!/[\u0000-\u001f\u007f]/.test(text), `Invalid FT ${label}.`);
		return text;
	} catch (cause) {
		if (cause instanceof UnprocessableEntityException) throw cause;
		throw new UnprocessableEntityException(`Invalid FT ${label} encoding.`);
	}
}

@Injectable()
export class BridgeAssetVerifier {
	async verify(signal: AbortSignal, selectedContractId: string = policy.contractId): Promise<VerifiedBridgeAsset> {
		try {
			const contractId = selectedContractId.toLowerCase();
			const routeId = bridgeRouteId(contractId);
			// A fixed Testnet API and a pinned confirmed genesis block identify this
			// learning route. This API reports chain="main" even for its dev network;
			// that label or a wallet address prefix alone is not network evidence.
			requireMatch(DEVNET_API_BASE === 'https://api.tbcdev.org/api/tbc', 'The approved TBC data source changed.');
			const [node, metadata, decoded, raw] = await Promise.all([
				readBridgeSource(API_URLS.nodeInfo, signal),
				readBridgeSource(API_URLS.tokenInfo(contractId), signal),
				readBridgeSource(API_URLS.transaction(contractId), signal),
				readBridgeSource(API_URLS.rawTransaction(contractId), signal),
			]);
			signal.throwIfAborted();
			requireMatch(node.chain === 'main' && Number.isSafeInteger(node.blocks) && Number(node.blocks) >= policy.genesisBlockHeight, 'The TBC node does not match the approved route.');
			requireMatch(decoded.txid === contractId && typeof decoded.blockhash === 'string' && /^[0-9a-f]{64}$/.test(decoded.blockhash) && Number.isSafeInteger(decoded.blockheight) && Number(decoded.blockheight) >= 0, 'The token genesis needs a confirmed source block.');
			const [checkpoint, genesisBlock] = await Promise.all([
				readBridgeSource(`${DEVNET_API_BASE}/blockByHeight/height/${policy.genesisBlockHeight}`, signal),
				readBridgeSource(`${DEVNET_API_BASE}/blockByHeight/height/${decoded.blockheight}`, signal),
			]);
			requireMatch(checkpoint.hash === policy.genesisBlockHash && checkpoint.height === policy.genesisBlockHeight, 'The configured source network checkpoint changed.');
			requireMatch(genesisBlock.hash === decoded.blockhash && genesisBlock.height === decoded.blockheight && Number.isSafeInteger(genesisBlock.confirmations) && Number(genesisBlock.confirmations) >= policy.minimumConfirmations, 'The token genesis is not in a confirmed canonical block.');
			if (contractId === policy.contractId) requireMatch(decoded.blockhash === policy.genesisBlockHash && decoded.blockheight === policy.genesisBlockHeight, 'The original token checkpoint changed.');
			requireMatch(Number.isSafeInteger(decoded.confirmations) && Number(decoded.confirmations) >= policy.minimumConfirmations, 'The FT genesis needs more source-chain confirmations.');
			const genesis = transaction(raw.txraw, contractId);
			requireMatch(genesis.inputs.length === 1 && genesis.outputs.length >= 2 && genesis.outputs[0].satoshis === 500 && genesis.outputs[1].satoshis === 0, 'Unsupported legacy FT genesis layout.');
			const code = genesis.outputs[0].script;
			const tape = genesis.outputs[1].script;
			const version = sdk.detectFTVersion(code.toHex());
			const descriptor = decodeLegacyFtCode(code.toHex());
			requireMatch(version?.version === 'legacy' && Number.isInteger(version.legacyVersion) && version.legacyVersion! >= 1 && version.legacyVersion! <= 4 && descriptor?.family === 'FT' && !descriptor.coin && descriptor.version === version.legacyVersion, 'This token is not a supported ordinary legacy FT. Choose another token.');
			requireMatch(descriptor.tapeSize === tape.toBuffer().length && isLegacyFtTape(tape.toHex()), 'The FT Code and Tape do not match.');
			const chunks = tape.chunks;
			requireMatch(chunks.length === 7 && chunks[0].opcodenum === tbc.Opcode.OP_0 && chunks[1].opcodenum === tbc.Opcode.OP_RETURN && chunks[2].buf?.length === 48 && chunks[3].buf?.length === 1 && chunks[6].buf?.toString('hex') === '4654617065', 'Unsupported legacy FT metadata layout.');
			const slots = chunks[2].buf!;
			requireMatch(slots.subarray(8).every((byte: number) => byte === 0), 'The selected transaction is not an initial FT mint.');
			const totalSupply = slots.readBigUInt64LE();
			requireMatch(totalSupply > 0n, 'The FT genesis supply is invalid.');
			const name = metadataText(chunks[4].buf, 'name', 1000);
			const symbol = metadataText(chunks[5].buf, 'symbol', 100);
			const decimals = chunks[3].buf![0];
			if (contractId === policy.contractId) requireMatch(name === policy.name && symbol === policy.symbol && decimals === policy.decimals, 'The genesis metadata differs from the selected asset configuration.');
			const amount = metadata.amount;
			requireMatch((typeof amount === 'string' && /^\d+$/.test(amount) || typeof amount === 'number' && Number.isSafeInteger(amount)) && String(amount) === totalSupply.toString(), 'The indexer supply differs from the genesis Tape.');
			requireMatch(metadata.contract_id === contractId && metadata.name === name && metadata.symbol === symbol && metadata.decimal === decimals && metadata.code_script === code.toHex() && metadata.tape_script === tape.toHex(), 'The indexed FT metadata differs from its raw genesis.');
			const mintInput = genesis.inputs[0];
			const sourceId = mintInput.prevTxId.toString('hex');
			if (contractId === policy.contractId) requireMatch(sourceId === policy.mintSourceTxid && mintInput.outputIndex === policy.mintSourceVout, 'The FT mint source does not match the approved asset.');
			const outpoint = Buffer.alloc(36);
			Buffer.from(sourceId, 'hex').reverse().copy(outpoint);
			outpoint.writeUInt32LE(mintInput.outputIndex, 32);
			requireMatch(descriptor.originalUTXOWire36Hex === outpoint.toString('hex'), 'The FT Code is not bound to its genesis mint source.');
			const sourceRaw = await readBridgeSource(API_URLS.rawTransaction(sourceId), signal);
			const source = transaction(sourceRaw.txraw, sourceId);
			const originCode = source.outputs[mintInput.outputIndex];
			const originTape = source.outputs[mintInput.outputIndex + 1];
			requireMatch(originCode?.satoshis === 9900 && originTape?.satoshis === 0 && originTape.script.toHex() === tape.toHex(), 'The mint-source metadata does not match the genesis Tape.');
			const originChunks = originCode.script.chunks;
			requireMatch(originChunks.length === 7 && originChunks[0].opcodenum === tbc.Opcode.OP_DUP && originChunks[1].opcodenum === tbc.Opcode.OP_HASH160 && originChunks[2].buf?.length === 20 && originChunks[3].opcodenum === tbc.Opcode.OP_EQUALVERIFY && originChunks[4].opcodenum === tbc.Opcode.OP_CHECKSIG && originChunks[5].opcodenum === tbc.Opcode.OP_RETURN && originChunks[6].buf?.equals(Buffer.from('for ft mint')), 'Unsupported FT mint-source script.');
			const canonical = await readBridgeSource(`${DEVNET_API_BASE}/blockByHeight/height/${decoded.blockheight}`, signal);
			requireMatch(canonical.hash === decoded.blockhash && canonical.height === decoded.blockheight && Number.isSafeInteger(canonical.confirmations) && Number(canonical.confirmations) >= policy.minimumConfirmations, 'The genesis block changed during verification. Refresh and verify again.');
			signal.throwIfAborted();
			return {
				routeId, sourceNetwork: policy.sourceNetwork, protocol: policy.protocol,
				contractId, name, symbol, decimals, legacyVersion: descriptor.version,
				totalSupplyRaw: totalSupply.toString(),
				genesisCodeHash: createHash('sha256').update(code.toBuffer()).digest('hex'),
				genesisTapeHash: createHash('sha256').update(tape.toBuffer()).digest('hex'),
				mintSourceTxid: sourceId, mintSourceVout: mintInput.outputIndex,
				genesisBlockHash: decoded.blockhash as string, genesisBlockHeight: Number(decoded.blockheight),
				confirmations: Number(decoded.confirmations), destinationChainId: policy.destinationChainId,
				verificationMethod: policy.verificationMethod, verifiedAt: new Date().toISOString(),
			};
		} catch (cause) {
			signal.throwIfAborted();
			if (cause instanceof ApiError) throw new ServiceUnavailableException('TBC asset verification is unavailable. Try again later; no asset configuration was changed.');
			throw cause;
		}
	}
}
