import { normalizeHash } from './tbc-proof.crypto';

const UINT256_MAX = (1n << 256n) - 1n;

export const TBC_MAIN_TARGET_SPACING_SECONDS = 600;
export const TBC_POST_FORK_SPACING_WINDOW = 8_064;
export const TBC_DAA_WORK_WINDOW = 144;

export const TBC_MAIN_POW_LIMIT = BigInt('0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

export interface CompactTarget {
	target: bigint;
	negative: boolean;
	overflow: boolean;
}

// Mirrors arith_uint256::SetCompact used by TBCNODE.
export function decodeCompactTarget(compact: number): CompactTarget {
	if (!Number.isSafeInteger(compact) || compact < 0 || compact > 0xffffffff) throw new Error('Compact target must be uint32.');
	const size = compact >>> 24;
	const word = compact & 0x007fffff;
	const target = size <= 3 ? BigInt(word) >> BigInt(8 * (3 - size)) : BigInt(word) << BigInt(8 * (size - 3));
	return {
		target,
		negative: word !== 0 && (compact & 0x00800000) !== 0,
		overflow: word !== 0 && (size > 34 || word > 0xff && size > 33 || word > 0xffff && size > 32),
	};
}

// Mirrors arith_uint256::GetCompact for non-negative targets.
export function encodeCompactTarget(target: bigint) {
	if (target < 0n || target > UINT256_MAX) throw new Error('Target must fit uint256.');
	if (target === 0n) return 0;
	let size = Math.ceil(target.toString(16).length / 2);
	let compact = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
	if ((compact & 0x00800000) !== 0) { compact >>>= 8; size += 1; }
	return ((size << 24) | compact) >>> 0;
}

export function assertProofOfWork(blockHash: string, compact: number, powLimit = TBC_MAIN_POW_LIMIT) {
	const decoded = decodeCompactTarget(compact);
	if (decoded.negative || decoded.overflow || decoded.target === 0n || decoded.target > powLimit) throw new Error('Invalid proof-of-work target.');
	if (BigInt(`0x${normalizeHash(blockHash, 'Block hash')}`) > decoded.target) throw new Error('Block hash does not satisfy its proof-of-work target.');
	return decoded.target;
}

// Mirrors TBCNODE GetBlockProof: (~target / (target + 1)) + 1 in uint256 arithmetic.
export function blockWork(compact: number) {
	const decoded = decodeCompactTarget(compact);
	if (decoded.negative || decoded.overflow || decoded.target === 0n) return 0n;
	return (UINT256_MAX - decoded.target) / (decoded.target + 1n) + 1n;
}

export function addChainWork(previousChainWork: bigint, compact: number) {
	if (previousChainWork < 0n || previousChainWork > UINT256_MAX) throw new Error('Previous chainwork must fit uint256.');
	const next = previousChainWork + blockWork(compact);
	if (next > UINT256_MAX) throw new Error('Chainwork overflow.');
	return next;
}

export interface TbcDifficultyPoint {
	height: number;
	time: number;
	bits: number;
	chainWork: bigint;
}

type DifficultyLookup = (height: number) => TbcDifficultyPoint;

function checkedPoint(point: TbcDifficultyPoint | undefined, height: number) {
	if (!point || point.height !== height) throw new Error(`Missing difficulty point at height ${height}.`);
	if (!Number.isSafeInteger(point.height) || point.height < 0 || !Number.isSafeInteger(point.time)
		|| point.time < 0 || point.time > 0xffffffff || point.chainWork < 0n || point.chainWork > UINT256_MAX) {
		throw new Error(`Invalid difficulty point at height ${height}.`);
	}
	const compact = decodeCompactTarget(point.bits);
	if (compact.negative || compact.overflow || compact.target === 0n) throw new Error(`Invalid compact target at height ${height}.`);
	return point;
}

export function difficultyLookup(points: readonly TbcDifficultyPoint[]): DifficultyLookup {
	const indexed = new Map<number, TbcDifficultyPoint>();
	for (const point of points) {
		if (indexed.has(point.height)) throw new Error(`Duplicate difficulty point at height ${point.height}.`);
		indexed.set(point.height, checkedPoint(point, point.height));
	}
	return (height: number) => checkedPoint(indexed.get(height), height);
}

// Mirrors TBCNODE GetSuitableBlock's median-of-three sorting network, including
// its behavior when timestamps are equal.
export function suitableDifficultyPoint(lookup: DifficultyLookup, height: number) {
	const blocks = [lookup(height - 2), lookup(height - 1), lookup(height)];
	if (blocks[0].time > blocks[2].time) [blocks[0], blocks[2]] = [blocks[2], blocks[0]];
	if (blocks[0].time > blocks[1].time) [blocks[0], blocks[1]] = [blocks[1], blocks[0]];
	if (blocks[1].time > blocks[2].time) [blocks[1], blocks[2]] = [blocks[2], blocks[1]];
	return blocks[1];
}

export function medianTimePast(lookup: DifficultyLookup, height: number) {
	const times: number[] = [];
	for (let cursor = height; cursor >= 0 && times.length < 11; cursor--) times.push(lookup(cursor).time);
	times.sort((left, right) => left - right);
	return times[Math.floor(times.length / 2)];
}

export function tbcPostForkTargetSpacing(previous: TbcDifficultyPoint, windowAncestor: TbcDifficultyPoint) {
	if (previous.height - windowAncestor.height !== TBC_POST_FORK_SPACING_WINDOW) {
		throw new Error('Dynamic-spacing ancestor is not 8,064 blocks behind the previous block.');
	}
	if (previous.time < windowAncestor.time) throw new Error('Dynamic-spacing window has negative elapsed time.');
	let promisedBlocks = Math.floor((previous.time - windowAncestor.time) / TBC_MAIN_TARGET_SPACING_SECONDS);
	if (promisedBlocks <= TBC_POST_FORK_SPACING_WINDOW) return TBC_MAIN_TARGET_SPACING_SECONDS;
	promisedBlocks = Math.min(promisedBlocks, TBC_POST_FORK_SPACING_WINDOW * 2);
	return Math.floor(TBC_MAIN_TARGET_SPACING_SECONDS * TBC_POST_FORK_SPACING_WINDOW / promisedBlocks);
}

export function tbcWorkWindowTarget(first: TbcDifficultyPoint, last: TbcDifficultyPoint, spacing: number) {
	if (!Number.isSafeInteger(spacing) || spacing <= 0) throw new Error('Target spacing must be a positive integer.');
	if (last.height <= first.height || last.chainWork <= first.chainWork) throw new Error('Difficulty work window is not increasing.');
	let work = last.chainWork - first.chainWork;
	work = (work * BigInt(spacing)) & UINT256_MAX;
	let actualTimespan = last.time - first.time;
	actualTimespan = Math.max(72 * spacing, Math.min(288 * spacing, actualTimespan));
	work /= BigInt(actualTimespan);
	if (work === 0n) throw new Error('Difficulty work window produced zero work.');
	return (UINT256_MAX - work + 1n) / work;
}

/**
 * Reproduces TBCNODE v3.3.1's custom main-parameter DAA for the block after
 * `previousHeight`. It intentionally accepts sparse points: callers need the
 * median windows, the 144-block work endpoints and the 8,064-block timestamp
 * ancestor, but do not need transaction data.
 */
export function expectedTbcPostForkBits(points: readonly TbcDifficultyPoint[], previousHeight: number, powLimit = TBC_MAIN_POW_LIMIT) {
	if (!Number.isSafeInteger(previousHeight) || previousHeight < 824_189) {
		throw new Error('Post-fork TBC difficulty requires previous height 824,189 or later.');
	}
	const lookup = difficultyLookup(points);
	const previous = lookup(previousHeight);
	const last = suitableDifficultyPoint(lookup, previousHeight);
	const first = suitableDifficultyPoint(lookup, previousHeight - TBC_DAA_WORK_WINDOW);
	const spacing = tbcPostForkTargetSpacing(previous, lookup(previousHeight - TBC_POST_FORK_SPACING_WINDOW));
	let nextTarget = tbcWorkWindowTarget(first, last, spacing);
	const previousTarget = decodeCompactTarget(previous.bits).target;
	if (previousTarget > powLimit) throw new Error('Previous target exceeds the configured proof-of-work limit.');
	const upper = previousTarget + (previousTarget >> 4n) >= powLimit ? powLimit : previousTarget + (previousTarget >> 4n);
	const lower = previousTarget - (previousTarget >> 4n);
	if (nextTarget > upper) nextTarget = upper;
	else if (medianTimePast(lookup, previousHeight) - medianTimePast(lookup, previousHeight - 12) > 6 * 60 * 60) nextTarget = upper;
	else if (nextTarget < lower) nextTarget = lower;
	return encodeCompactTarget(nextTarget);
}
