import { addChainWork, assertProofOfWork, blockWork, expectedTbcPostForkBits, type TbcDifficultyPoint, TBC_MAIN_POW_LIMIT } from './tbc-consensus';
import { blockHashFromHeader, serializeBlockHeader } from './tbc-proof.crypto';
import type { TbcBlockRecord } from './tbc-proof.types';
import type { TrustedTbcCheckpoint } from './tbc-checkpoints';

export interface ValidatedTbcHeader extends TbcBlockRecord {
	chainWork: bigint;
}

function assertHeaderSelfConsistency(block: TbcBlockRecord, powLimit: bigint) {
	const computedHash = blockHashFromHeader(serializeBlockHeader(block));
	if (computedHash !== block.hash) throw new Error(`Header ${block.height} does not reproduce its reported hash.`);
	assertProofOfWork(block.hash, block.bits, powLimit);
}

export function validateTrustedCheckpoint(checkpoint: TrustedTbcCheckpoint, powLimit = TBC_MAIN_POW_LIMIT): ValidatedTbcHeader {
	assertHeaderSelfConsistency(checkpoint.block, powLimit);
	if (checkpoint.chainWork < blockWork(checkpoint.block.bits)) throw new Error('Trusted checkpoint chainwork is invalid.');
	return { ...checkpoint.block, chainWork: checkpoint.chainWork };
}

export function validateNextTbcPostForkHeader(
	parent: ValidatedTbcHeader,
	candidate: TbcBlockRecord,
	difficultyPoints: readonly TbcDifficultyPoint[],
	powLimit = TBC_MAIN_POW_LIMIT,
): ValidatedTbcHeader {
	if (candidate.height !== parent.height + 1) throw new Error('Candidate header height is not consecutive.');
	if (candidate.previousBlockHash !== parent.hash) throw new Error('Candidate header does not link to its parent.');
	const difficultyParent = difficultyPoints.find((point) => point.height === parent.height);
	if (!difficultyParent || difficultyParent.time !== parent.time || difficultyParent.bits !== parent.bits
		|| difficultyParent.chainWork !== parent.chainWork) {
		throw new Error('Difficulty context does not match the validated parent.');
	}
	const expectedBits = expectedTbcPostForkBits(difficultyPoints, parent.height, powLimit);
	if (candidate.bits !== expectedBits) throw new Error('Candidate header has an invalid TBC difficulty target.');
	assertHeaderSelfConsistency(candidate, powLimit);
	return { ...candidate, chainWork: addChainWork(parent.chainWork, candidate.bits) };
}

export function selectGreatestWorkTip(candidates: readonly ValidatedTbcHeader[]) {
	if (candidates.length === 0) throw new Error('At least one validated chain tip is required.');
	let best = candidates[0];
	for (const candidate of candidates.slice(1)) {
		if (candidate.chainWork > best.chainWork) best = candidate;
		else if (candidate.chainWork === best.chainWork && candidate.hash !== best.hash) {
			throw new Error('Competing tips have equal chainwork; canonical selection is unresolved.');
		}
	}
	return best;
}
