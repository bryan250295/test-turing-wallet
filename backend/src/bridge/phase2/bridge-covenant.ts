import tbc from 'tbc-lib-js';
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';

export const TBC_V2_SOURCE_DOMAIN = 'learningmaterials/tbc-hyperevm/v2/tbc-testnet';
export const TBC_V2_DEPOSIT_DOMAIN = 'learningmaterials/tbc-hyperevm/v2/deposit';
export const TBC_V2_SOURCE_DOMAIN_HASH = keccak256(stringToHex(TBC_V2_SOURCE_DOMAIN));
export const TBC_V2_DEPOSIT_DOMAIN_HASH = keccak256(stringToHex(TBC_V2_DEPOSIT_DOMAIN));

export const BRIDGE_COVENANT_MAGIC = Buffer.from('LMBV2DEP', 'ascii');
export const BRIDGE_COVENANT_VERSION = 1;
export const BRIDGE_COVENANT_PAYLOAD_BYTES = 262;
export const BRIDGE_COVENANT_SATOSHIS = 100;
export const BRIDGE_FT_CODE_SATOSHIS = 500;

const HEX_20 = /^[0-9a-f]{40}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;

export interface BridgeCovenantIntent {
	sourceContractId: string;
	destinationChainId: bigint;
	destinationGateway: Address;
	recipient: Address;
	amountRaw: bigint;
	depositNonce: bigint;
	reserveControllerPubKeyHash: string;
}

export interface LogicalDepositOutpoint {
	sourceTxid: string;
	sourceVout: number;
}

function normalizedHex(value: string, bytes: 20 | 32, field: string) {
	const normalized = value.toLowerCase().replace(/^0x/, '');
	const pattern = bytes === 20 ? HEX_20 : HEX_32;
	if (!pattern.test(normalized)) throw new Error(`${field} must be exactly ${bytes} bytes of hexadecimal data.`);
	return normalized;
}

function uint256(value: bigint, field: string) {
	if (value < 0n || value > UINT256_MAX) throw new Error(`${field} is outside uint256 range.`);
	return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

function readUint256(value: Buffer) { return BigInt(`0x${value.toString('hex')}`); }

export function normalizeBridgeCovenantIntent(intent: BridgeCovenantIntent): BridgeCovenantIntent {
	const destinationChainId = BigInt(intent.destinationChainId);
	if (destinationChainId === 0n) throw new Error('destinationChainId must be positive.');
	const amountRaw = BigInt(intent.amountRaw);
	if (amountRaw === 0n) throw new Error('amountRaw must be positive.');
	return {
		sourceContractId: normalizedHex(intent.sourceContractId, 32, 'sourceContractId'),
		destinationChainId: readUint256(uint256(destinationChainId, 'destinationChainId')),
		destinationGateway: `0x${normalizedHex(intent.destinationGateway, 20, 'destinationGateway')}`,
		recipient: `0x${normalizedHex(intent.recipient, 20, 'recipient')}`,
		amountRaw: readUint256(uint256(amountRaw, 'amountRaw')),
		depositNonce: readUint256(uint256(BigInt(intent.depositNonce), 'depositNonce')),
		reserveControllerPubKeyHash: normalizedHex(intent.reserveControllerPubKeyHash, 20, 'reserveControllerPubKeyHash'),
	};
}

/**
 * Canonical fixed-width covenant payload. Integer fields are unsigned big-endian,
 * matching Solidity ABI words. The source TXID and vout are deliberately absent:
 * a transaction cannot commit to its own TXID, so they are derived from the proven
 * transaction and fixed FT output position instead.
 */
export function encodeBridgeCovenantPayload(value: BridgeCovenantIntent) {
	const intent = normalizeBridgeCovenantIntent(value);
	const version = Buffer.alloc(2); version.writeUInt16BE(BRIDGE_COVENANT_VERSION);
	const payload = Buffer.concat([
		BRIDGE_COVENANT_MAGIC,
		version,
		Buffer.from(TBC_V2_SOURCE_DOMAIN_HASH.slice(2), 'hex'),
		Buffer.from(TBC_V2_DEPOSIT_DOMAIN_HASH.slice(2), 'hex'),
		Buffer.from(intent.sourceContractId, 'hex'),
		uint256(intent.destinationChainId, 'destinationChainId'),
		Buffer.from(intent.destinationGateway.slice(2), 'hex'),
		Buffer.from(intent.recipient.slice(2), 'hex'),
		uint256(intent.amountRaw, 'amountRaw'),
		uint256(intent.depositNonce, 'depositNonce'),
		Buffer.from(intent.reserveControllerPubKeyHash, 'hex'),
	]);
	if (payload.length !== BRIDGE_COVENANT_PAYLOAD_BYTES) throw new Error('Bridge Covenant payload length invariant failed.');
	return payload;
}

export function decodeBridgeCovenantPayload(payload: Buffer): BridgeCovenantIntent {
	if (payload.length !== BRIDGE_COVENANT_PAYLOAD_BYTES) throw new Error('Bridge Covenant payload has the wrong length.');
	let offset = 0;
	const take = (bytes: number) => { const value = payload.subarray(offset, offset + bytes); offset += bytes; return value; };
	if (!take(8).equals(BRIDGE_COVENANT_MAGIC)) throw new Error('Bridge Covenant magic is invalid.');
	if (take(2).readUInt16BE() !== BRIDGE_COVENANT_VERSION) throw new Error('Bridge Covenant version is unsupported.');
	if (`0x${take(32).toString('hex')}` !== TBC_V2_SOURCE_DOMAIN_HASH) throw new Error('Bridge Covenant source domain is invalid.');
	if (`0x${take(32).toString('hex')}` !== TBC_V2_DEPOSIT_DOMAIN_HASH) throw new Error('Bridge Covenant deposit domain is invalid.');
	const result = normalizeBridgeCovenantIntent({
		sourceContractId: take(32).toString('hex'),
		destinationChainId: readUint256(take(32)),
		destinationGateway: `0x${take(20).toString('hex')}`,
		recipient: `0x${take(20).toString('hex')}`,
		amountRaw: readUint256(take(32)),
		depositNonce: readUint256(take(32)),
		reserveControllerPubKeyHash: take(20).toString('hex'),
	});
	if (offset !== payload.length) throw new Error('Bridge Covenant payload has trailing bytes.');
	return result;
}

/** A data-bound P2PKH covenant controlled by the future threshold/MPC key. */
export function buildBridgeCovenantScript(value: BridgeCovenantIntent) {
	const intent = normalizeBridgeCovenantIntent(value);
	return new tbc.Script()
		.add(encodeBridgeCovenantPayload(intent))
		.add(tbc.Opcode.OP_DROP)
		.add(tbc.Opcode.OP_DUP)
		.add(tbc.Opcode.OP_HASH160)
		.add(Buffer.from(intent.reserveControllerPubKeyHash, 'hex'))
		.add(tbc.Opcode.OP_EQUALVERIFY)
		.add(tbc.Opcode.OP_CHECKSIG);
}

export function parseBridgeCovenantScript(script: tbc.Script | string) {
	const parsed = typeof script === 'string' ? tbc.Script.fromHex(script) : script;
	const chunks = parsed.chunks;
	if (chunks.length !== 7 || !chunks[0].buf
		|| chunks[1].opcodenum !== tbc.Opcode.OP_DROP
		|| chunks[2].opcodenum !== tbc.Opcode.OP_DUP
		|| chunks[3].opcodenum !== tbc.Opcode.OP_HASH160
		|| !chunks[4].buf || chunks[4].buf.length !== 20
		|| chunks[5].opcodenum !== tbc.Opcode.OP_EQUALVERIFY
		|| chunks[6].opcodenum !== tbc.Opcode.OP_CHECKSIG) throw new Error('Bridge Covenant locking script has an unsupported shape.');
	const intent = decodeBridgeCovenantPayload(chunks[0].buf);
	if (chunks[4].buf.toString('hex') !== intent.reserveControllerPubKeyHash) throw new Error('Bridge Covenant controller differs from its committed payload.');
	if (buildBridgeCovenantScript(intent).toHex() !== parsed.toHex()) throw new Error('Bridge Covenant script is not canonically encoded.');
	return intent;
}

/** Legacy FT contract-controller convention used by tbc-contract 1.7.3. */
export function bridgeCovenantFtController(script: tbc.Script | string) {
	const parsed = typeof script === 'string' ? tbc.Script.fromHex(script) : script;
	return tbc.crypto.Hash.sha256ripemd160(tbc.crypto.Hash.sha256(parsed.toBuffer())).toString('hex');
}

export function logicalDepositId(intentValue: BridgeCovenantIntent, outpoint: LogicalDepositOutpoint): Hex {
	const intent = normalizeBridgeCovenantIntent(intentValue);
	const sourceTxid = normalizedHex(outpoint.sourceTxid, 32, 'sourceTxid');
	if (!Number.isSafeInteger(outpoint.sourceVout) || outpoint.sourceVout < 0 || outpoint.sourceVout > 0xffffffff) throw new Error('sourceVout is outside uint32 range.');
	return keccak256(encodeAbiParameters(
		parseAbiParameters('bytes32, bytes32, bytes32, bytes32, uint32, uint256, address, address, uint256, uint256'),
		[TBC_V2_DEPOSIT_DOMAIN_HASH, TBC_V2_SOURCE_DOMAIN_HASH, `0x${intent.sourceContractId}`, `0x${sourceTxid}`,
			outpoint.sourceVout, intent.destinationChainId, intent.destinationGateway, intent.recipient, intent.amountRaw, intent.depositNonce],
	));
}

/** Domain-separated physical source-outpoint identity used by the v2 replay guard. */
export function sourceOutpointId(sourceContractIdValue: string, outpoint: LogicalDepositOutpoint): Hex {
	const sourceContractId = normalizedHex(sourceContractIdValue, 32, 'sourceContractId');
	const sourceTxid = normalizedHex(outpoint.sourceTxid, 32, 'sourceTxid');
	if (!Number.isSafeInteger(outpoint.sourceVout) || outpoint.sourceVout < 0 || outpoint.sourceVout > 0xffffffff) throw new Error('sourceVout is outside uint32 range.');
	return keccak256(encodeAbiParameters(
		parseAbiParameters('bytes32, bytes32, bytes32, uint32'),
		[TBC_V2_SOURCE_DOMAIN_HASH, `0x${sourceContractId}`, `0x${sourceTxid}`, outpoint.sourceVout],
	));
}
