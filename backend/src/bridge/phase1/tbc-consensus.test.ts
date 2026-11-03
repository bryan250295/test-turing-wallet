import assert from 'node:assert/strict';
import test from 'node:test';
import {
	addChainWork, assertProofOfWork, blockWork, decodeCompactTarget, encodeCompactTarget,
	expectedTbcPostForkBits, medianTimePast, tbcPostForkTargetSpacing, difficultyLookup,
	TBC_MAIN_POW_LIMIT,
} from './tbc-consensus';
import { REAL_MT_DAA_POINTS } from './tbc-test-vectors';

test('matches the compact powLimit and Bitcoin/TBC genesis block-work vector', () => {
	const decoded = decodeCompactTarget(0x1d00ffff);
	assert.equal(decoded.target.toString(16).padStart(64, '0'), '00000000ffff0000000000000000000000000000000000000000000000000000');
	assert.equal(decoded.negative, false);
	assert.equal(decoded.overflow, false);
	assert.equal(encodeCompactTarget(decoded.target), 0x1d00ffff);
	assert.equal(blockWork(0x1d00ffff), 4_295_032_833n);
	assert.equal(decoded.target <= TBC_MAIN_POW_LIMIT, true);
});

test('accepts the official first TBC main-parameter block proof vector', () => {
	const hash = '0000000058968601042df9b0d57e41b092c76d6f91f333dc231cdd4cc4fd861d';
	const target = assertProofOfWork(hash, 0x1d00efff);
	assert.equal(target.toString(16).padStart(64, '0'), '00000000efff0000000000000000000000000000000000000000000000000000');
	assert.equal(blockWork(0x1d00efff), 4_581_373_015n);
	assert.equal(addChainWork(100n, 0x1d00efff), 4_581_373_115n);
});

test('rejects targets outside consensus range and hashes above target', () => {
	assert.throws(() => assertProofOfWork('f'.repeat(64), 0x1d00efff), /does not satisfy/);
	assert.throws(() => assertProofOfWork('0'.repeat(64), 0x1e00ffff), /Invalid proof-of-work target/);
	assert.equal(blockWork(0), 0n);
});

test('reproduces the pinned TBCNODE post-fork DAA for the real MT deposit parent', () => {
	const lookup = difficultyLookup(REAL_MT_DAA_POINTS);
	assert.equal(tbcPostForkTargetSpacing(lookup(839164), lookup(831100)), 600);
	assert.equal(medianTimePast(lookup, 839164), 1793333689);
	assert.equal(medianTimePast(lookup, 839152), 1793326057);
	assert.equal(expectedTbcPostForkBits(REAL_MT_DAA_POINTS, 839164), 0x1a0420a6);
});
