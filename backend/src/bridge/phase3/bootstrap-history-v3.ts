import { createHash } from 'node:crypto';
import {
	concat, encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex,
} from 'viem';
import { blockHashFromHeader, normalizeHash } from '../phase1/tbc-proof.crypto';
import type { TbcDifficultyPoint } from '../phase1/tbc-consensus';

export const TBCDEV_BOOTSTRAP_CONTEXT_SCHEMA_V3 = 'learningmaterials/tbc-header-bootstrap/v3' as const;
export const TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_V3 = 'learningmaterials/tbc-hyperevm/v3/header-bootstrap/v3';
export const TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH_V3 = keccak256(stringToHex(TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_V3));
export const TBCDEV_BOOTSTRAP_POINT_COUNT_V3 = 8_065;
export const TBCDEV_BOOTSTRAP_RECORD_BYTES_V3 = 112;

const UINT256_MAX = (1n << 256n) - 1n;
const LEAF_PARAMETERS = parseAbiParameters('bytes32, bytes32, uint32, bytes32, uint32, uint32, uint256');

export interface TbcBootstrapContextPointV3 extends TbcDifficultyPoint {
	blockHash: string;
	rawHeader: string;
}

export interface TbcBootstrapCommitmentV3 {
	checkpointHash: Hex;
	startHeight: number;
	root: Hex;
	leaves: Hex[];
	levels: Hex[][];
}

function requireHeight(value: number, label: string) {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${label} is invalid.`);
	return value;
}

function uint256Bytes(value: bigint) {
	if (value < 0n || value > UINT256_MAX) throw new Error('Chainwork is outside uint256 range.');
	return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

function validatePoints(points: readonly TbcBootstrapContextPointV3[]) {
	if (points.length !== TBCDEV_BOOTSTRAP_POINT_COUNT_V3) throw new Error('V3 bootstrap context must contain exactly 8,065 points.');
	const startHeight = requireHeight(points[0]!.height, 'Bootstrap start height');
	for (let index = 0; index < points.length; index++) {
		const point = points[index]!;
		if (point.height !== startHeight + index) throw new Error('V3 bootstrap context heights are not consecutive.');
		const rawHeader = Buffer.from(point.rawHeader, 'hex');
		if (rawHeader.length !== 80
			|| blockHashFromHeader(rawHeader) !== normalizeHash(point.blockHash, 'Bootstrap block hash')
			|| rawHeader.readUInt32LE(68) !== point.time
			|| rawHeader.readUInt32LE(72) !== point.bits) {
			throw new Error(`V3 bootstrap point ${point.height} differs from its raw header.`);
		}
		if (index > 0 && point.chainWork <= points[index - 1]!.chainWork) throw new Error(`V3 chainwork did not increase at ${point.height}.`);
	}
	return startHeight;
}

export function encodeTbcdevBootstrapContextV3(points: readonly TbcBootstrapContextPointV3[]) {
	validatePoints(points);
	const encoded = Buffer.alloc(points.length * TBCDEV_BOOTSTRAP_RECORD_BYTES_V3);
	for (let index = 0; index < points.length; index++) {
		const point = points[index]!;
		Buffer.from(point.rawHeader, 'hex').copy(encoded, index * TBCDEV_BOOTSTRAP_RECORD_BYTES_V3);
		uint256Bytes(point.chainWork).copy(encoded, index * TBCDEV_BOOTSTRAP_RECORD_BYTES_V3 + 80);
	}
	return encoded;
}

export function decodeTbcdevBootstrapContextV3(encoded: Buffer, startHeight: number) {
	requireHeight(startHeight, 'Bootstrap start height');
	if (encoded.length !== TBCDEV_BOOTSTRAP_POINT_COUNT_V3 * TBCDEV_BOOTSTRAP_RECORD_BYTES_V3) throw new Error('V3 bootstrap binary has the wrong byte length.');
	return Array.from({ length: TBCDEV_BOOTSTRAP_POINT_COUNT_V3 }, (_, index): TbcBootstrapContextPointV3 => {
		const offset = index * TBCDEV_BOOTSTRAP_RECORD_BYTES_V3;
		const rawHeader = encoded.subarray(offset, offset + 80);
		return {
			height: startHeight + index,
			blockHash: blockHashFromHeader(rawHeader),
			rawHeader: rawHeader.toString('hex'),
			time: rawHeader.readUInt32LE(68),
			bits: rawHeader.readUInt32LE(72),
			chainWork: BigInt(`0x${encoded.subarray(offset + 80, offset + 112).toString('hex')}`),
		};
	});
}

export function tbcdevBootstrapLeafV3(point: TbcBootstrapContextPointV3, checkpointHash: Hex): Hex {
	return keccak256(encodeAbiParameters(LEAF_PARAMETERS, [
		TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH_V3,
		checkpointHash,
		point.height,
		`0x${normalizeHash(point.blockHash, 'Bootstrap block hash')}`,
		point.time,
		point.bits,
		point.chainWork,
	]));
}

export function buildTbcdevBootstrapCommitmentV3(points: readonly TbcBootstrapContextPointV3[], checkpointHashValue: string): TbcBootstrapCommitmentV3 {
	const startHeight = validatePoints(points);
	const checkpointHash = `0x${normalizeHash(checkpointHashValue, 'Checkpoint hash')}` as Hex;
	if (points.at(-1)!.blockHash !== checkpointHash.slice(2)) throw new Error('The final V3 bootstrap point is not the selected checkpoint.');
	const levels: Hex[][] = [points.map((point) => tbcdevBootstrapLeafV3(point, checkpointHash))];
	while (levels.at(-1)!.length > 1) {
		const current = levels.at(-1)!;
		const next: Hex[] = [];
		for (let index = 0; index < current.length; index += 2) {
			const right = current[index + 1] ?? current[index]!;
			next.push(keccak256(concat([current[index]!, right])));
		}
		levels.push(next);
	}
	return { checkpointHash, startHeight, root: levels.at(-1)![0]!, leaves: levels[0]!, levels };
}

export function tbcdevBootstrapProofV3(commitment: TbcBootstrapCommitmentV3, height: number) {
	const indexValue = height - commitment.startHeight;
	if (!Number.isSafeInteger(indexValue) || indexValue < 0 || indexValue >= TBCDEV_BOOTSTRAP_POINT_COUNT_V3) throw new Error('V3 bootstrap proof height is outside the committed range.');
	let index = indexValue;
	const siblings: Hex[] = [];
	for (const level of commitment.levels.slice(0, -1)) {
		const siblingIndex = index ^ 1;
		siblings.push(level[siblingIndex] ?? level[index]!);
		index = Math.floor(index / 2);
	}
	return siblings;
}

export function verifyTbcdevBootstrapProofV3(point: TbcBootstrapContextPointV3, siblings: readonly Hex[], commitment: Pick<TbcBootstrapCommitmentV3, 'checkpointHash' | 'startHeight' | 'root'>) {
	let index = point.height - commitment.startHeight;
	let width = TBCDEV_BOOTSTRAP_POINT_COUNT_V3;
	let current = tbcdevBootstrapLeafV3(point, commitment.checkpointHash);
	let required = 0;
	for (let count = width; count > 1; count = Math.ceil(count / 2)) required++;
	if (index < 0 || index >= width || siblings.length !== required) return false;
	for (const sibling of siblings) {
		if ((width & 1) === 1 && index === width - 1 && sibling !== current) return false;
		current = (index & 1) === 1 ? keccak256(concat([sibling, current])) : keccak256(concat([current, sibling]));
		index = Math.floor(index / 2);
		width = Math.ceil(width / 2);
	}
	return current === commitment.root;
}

export function bootstrapBinarySha256V3(encoded: Buffer) {
	return createHash('sha256').update(encoded).digest('hex');
}
