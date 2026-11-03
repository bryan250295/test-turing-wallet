import { createHash } from 'node:crypto';
import {
	concat, encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex,
} from 'viem';
import {
	assertProofOfWork, blockWork, expectedTbcPostForkBits, type TbcDifficultyPoint,
} from '../phase1/tbc-consensus';
import { TBCDEV_BOOTSTRAP_CHECKPOINT_V1 } from '../phase1/tbc-checkpoints';
import { blockHashFromHeader, normalizeHash, serializeBlockHeader } from '../phase1/tbc-proof.crypto';
import type { TbcBlockRecord } from '../phase1/tbc-proof.types';

export const TBCDEV_BOOTSTRAP_CONTEXT_SCHEMA = 'learningmaterials/tbc-header-bootstrap/v1' as const;
export const TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN = 'learningmaterials/tbc-hyperevm/v2/header-bootstrap/v1';
export const TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH = keccak256(stringToHex(TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN));
export const TBCDEV_BOOTSTRAP_START_HEIGHT = 831_100;
export const TBCDEV_BOOTSTRAP_END_HEIGHT = TBCDEV_BOOTSTRAP_CHECKPOINT_V1.block.height;
// Neither official testnet API exposes headers before the first TBC block.
export const TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT = 824_190;
export const TBCDEV_BOOTSTRAP_FIRST_VERIFIABLE_DAA_HEIGHT = TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT + 8_065;
export const TBCDEV_BOOTSTRAP_POINT_COUNT = TBCDEV_BOOTSTRAP_END_HEIGHT - TBCDEV_BOOTSTRAP_START_HEIGHT + 1;
export const TBCDEV_BOOTSTRAP_RECORD_BYTES = 112;

const UINT256_MAX = (1n << 256n) - 1n;
const LEAF_PARAMETERS = parseAbiParameters('bytes32, bytes32, uint32, bytes32, uint32, uint32, uint256');

export interface TbcBootstrapContextPoint extends TbcDifficultyPoint {
	blockHash: string;
	rawHeader: string;
}

export interface TbcBootstrapCommitment {
	root: Hex;
	leaves: Hex[];
	levels: Hex[][];
}

function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function requiredDifficultyHeights(previousHeight: number) {
	const heights = new Set<number>([previousHeight - 8_064]);
	for (let height = previousHeight - 146; height <= previousHeight - 144; height++) heights.add(height);
	for (let height = previousHeight - 22; height <= previousHeight; height++) heights.add(height);
	return [...heights];
}

function uint256Bytes(value: bigint) {
	if (value < 0n || value > UINT256_MAX) throw new Error('Chainwork is outside uint256 range.');
	return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

function rawHeaderPoint(rawHeader: Buffer, height: number, chainWork: bigint): TbcBootstrapContextPoint {
	if (rawHeader.length !== 80) throw new Error(`Bootstrap header ${height} is not 80 bytes.`);
	return {
		height,
		blockHash: blockHashFromHeader(rawHeader),
		rawHeader: rawHeader.toString('hex'),
		time: rawHeader.readUInt32LE(68),
		bits: rawHeader.readUInt32LE(72),
		chainWork,
	};
}

export function deriveTbcdevBootstrapContext(blocks: readonly TbcBlockRecord[]) {
	const expectedCount = TBCDEV_BOOTSTRAP_END_HEIGHT - TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT + 1;
	if (blocks.length !== expectedCount) throw new Error(`Bootstrap support history must contain exactly ${expectedCount} blocks.`);
	const indexed = new Map<number, TbcBlockRecord>();
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		const expectedHeight = TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT + index;
		if (block.height !== expectedHeight || indexed.has(block.height)) throw new Error(`Unexpected bootstrap block height ${block.height}.`);
		const header = serializeBlockHeader(block);
		if (blockHashFromHeader(header) !== block.hash) throw new Error(`Bootstrap header ${block.height} does not reproduce its hash.`);
		assertProofOfWork(block.hash, block.bits);
		if (index > 0 && block.previousBlockHash !== blocks[index - 1].hash) throw new Error(`Bootstrap linkage failed at height ${block.height}.`);
		indexed.set(block.height, block);
	}

	const checkpoint = indexed.get(TBCDEV_BOOTSTRAP_END_HEIGHT);
	requireValue(checkpoint, 'Bootstrap history is missing the checkpoint.');
	for (const field of ['hash', 'version', 'previousBlockHash', 'merkleRoot', 'time', 'bits', 'nonce'] as const) {
		if (checkpoint[field] !== TBCDEV_BOOTSTRAP_CHECKPOINT_V1.block[field]) throw new Error(`Bootstrap checkpoint ${field} differs from the frozen anchor.`);
	}

	const points = new Map<number, TbcBootstrapContextPoint>();
	let chainWork = TBCDEV_BOOTSTRAP_CHECKPOINT_V1.chainWork;
	for (let height = TBCDEV_BOOTSTRAP_END_HEIGHT; height >= TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT; height--) {
		const block = indexed.get(height)!;
		points.set(height, {
			height, blockHash: block.hash, rawHeader: serializeBlockHeader(block).toString('hex'),
			time: block.time, bits: block.bits, chainWork,
		});
		const work = blockWork(block.bits);
		if (height > TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT) {
			if (work === 0n || chainWork <= work) throw new Error(`Bootstrap chainwork underflow at height ${height}.`);
			chainWork -= work;
		}
	}

	for (let height = TBCDEV_BOOTSTRAP_FIRST_VERIFIABLE_DAA_HEIGHT; height <= TBCDEV_BOOTSTRAP_END_HEIGHT; height++) {
		const previousHeight = height - 1;
		const difficultyPoints = requiredDifficultyHeights(previousHeight).map((requiredHeight) => {
			const point = points.get(requiredHeight);
			if (!point) throw new Error(`Missing DAA support point ${requiredHeight}.`);
			return point;
		});
		const expectedBits = expectedTbcPostForkBits(difficultyPoints, previousHeight);
		if (points.get(height)!.bits !== expectedBits) throw new Error(`TBC DAA mismatch at height ${height}.`);
	}

	return Array.from({ length: TBCDEV_BOOTSTRAP_POINT_COUNT }, (_, index) => points.get(TBCDEV_BOOTSTRAP_START_HEIGHT + index)!);
}

export function encodeTbcdevBootstrapContext(points: readonly TbcBootstrapContextPoint[]) {
	if (points.length !== TBCDEV_BOOTSTRAP_POINT_COUNT) throw new Error('Bootstrap context has the wrong point count.');
	const encoded = Buffer.alloc(points.length * TBCDEV_BOOTSTRAP_RECORD_BYTES);
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		if (point.height !== TBCDEV_BOOTSTRAP_START_HEIGHT + index) throw new Error('Bootstrap context heights are not consecutive.');
		const rawHeader = Buffer.from(point.rawHeader, 'hex');
		if (rawHeader.length !== 80 || blockHashFromHeader(rawHeader) !== normalizeHash(point.blockHash, 'Bootstrap block hash')
			|| rawHeader.readUInt32LE(68) !== point.time || rawHeader.readUInt32LE(72) !== point.bits) {
			throw new Error(`Bootstrap point ${point.height} differs from its raw header.`);
		}
		rawHeader.copy(encoded, index * TBCDEV_BOOTSTRAP_RECORD_BYTES);
		uint256Bytes(point.chainWork).copy(encoded, index * TBCDEV_BOOTSTRAP_RECORD_BYTES + 80);
	}
	return encoded;
}

export function decodeTbcdevBootstrapContext(encoded: Buffer) {
	if (encoded.length !== TBCDEV_BOOTSTRAP_POINT_COUNT * TBCDEV_BOOTSTRAP_RECORD_BYTES) throw new Error('Bootstrap binary has the wrong byte length.');
	return Array.from({ length: TBCDEV_BOOTSTRAP_POINT_COUNT }, (_, index) => {
		const offset = index * TBCDEV_BOOTSTRAP_RECORD_BYTES;
		const header = encoded.subarray(offset, offset + 80);
		const chainWork = BigInt(`0x${encoded.subarray(offset + 80, offset + 112).toString('hex')}`);
		return rawHeaderPoint(header, TBCDEV_BOOTSTRAP_START_HEIGHT + index, chainWork);
	});
}

export function tbcdevBootstrapLeaf(point: TbcBootstrapContextPoint): Hex {
	return keccak256(encodeAbiParameters(LEAF_PARAMETERS, [
		TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH,
		`0x${TBCDEV_BOOTSTRAP_CHECKPOINT_V1.block.hash}`,
		point.height,
		`0x${normalizeHash(point.blockHash, 'Bootstrap block hash')}`,
		point.time,
		point.bits,
		point.chainWork,
	]));
}

export function buildTbcdevBootstrapCommitment(points: readonly TbcBootstrapContextPoint[]): TbcBootstrapCommitment {
	if (points.length !== TBCDEV_BOOTSTRAP_POINT_COUNT) throw new Error('Bootstrap commitment has the wrong point count.');
	const levels: Hex[][] = [points.map(tbcdevBootstrapLeaf)];
	while (levels.at(-1)!.length > 1) {
		const current = levels.at(-1)!;
		const next: Hex[] = [];
		for (let index = 0; index < current.length; index += 2) {
			const right = current[index + 1] ?? current[index];
			next.push(keccak256(concat([current[index], right])));
		}
		levels.push(next);
	}
	return { root: levels.at(-1)![0], leaves: levels[0], levels };
}

export function tbcdevBootstrapProof(commitment: TbcBootstrapCommitment, height: number) {
	if (!Number.isSafeInteger(height) || height < TBCDEV_BOOTSTRAP_START_HEIGHT || height > TBCDEV_BOOTSTRAP_END_HEIGHT) {
		throw new Error('Bootstrap proof height is outside the committed range.');
	}
	let index = height - TBCDEV_BOOTSTRAP_START_HEIGHT;
	const siblings: Hex[] = [];
	for (const level of commitment.levels.slice(0, -1)) {
		const siblingIndex = index ^ 1;
		siblings.push(level[siblingIndex] ?? level[index]);
		index = Math.floor(index / 2);
	}
	return siblings;
}

export function verifyTbcdevBootstrapProof(point: TbcBootstrapContextPoint, siblings: readonly Hex[], expectedRoot: Hex) {
	let index = point.height - TBCDEV_BOOTSTRAP_START_HEIGHT;
	let width = TBCDEV_BOOTSTRAP_POINT_COUNT;
	let current = tbcdevBootstrapLeaf(point);
	let required = 0;
	for (let count = width; count > 1; count = Math.ceil(count / 2)) required++;
	if (index < 0 || index >= width || siblings.length !== required) return false;
	for (const sibling of siblings) {
		if ((width & 1) === 1 && index === width - 1 && sibling !== current) return false;
		current = (index & 1) === 1 ? keccak256(concat([sibling, current])) : keccak256(concat([current, sibling]));
		index = Math.floor(index / 2);
		width = Math.ceil(width / 2);
	}
	return current === expectedRoot;
}

export function bootstrapBinarySha256(encoded: Buffer) {
	return createHash('sha256').update(encoded).digest('hex');
}
