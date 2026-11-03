import assert from 'node:assert/strict';
import test from 'node:test';
import { TBCDEV_BOOTSTRAP_CHECKPOINT_V1 } from './tbc-checkpoints';
import { selectGreatestWorkTip, validateNextTbcPostForkHeader, validateTrustedCheckpoint } from './tbc-header-chain';
import { REAL_MT_DAA_POINTS, REAL_MT_DEPOSIT_BLOCK } from './tbc-test-vectors';

test('validates the official checkpoint and the next real MT deposit header', () => {
	const checkpoint = validateTrustedCheckpoint(TBCDEV_BOOTSTRAP_CHECKPOINT_V1);
	const deposit = validateNextTbcPostForkHeader(checkpoint, REAL_MT_DEPOSIT_BLOCK, REAL_MT_DAA_POINTS);
	assert.equal(deposit.chainWork.toString(16), '14f15b41739c2f494808478');
	assert.equal(deposit.hash, REAL_MT_DEPOSIT_BLOCK.hash);
});

test('rejects broken linkage and an incorrect next difficulty', () => {
	const checkpoint = validateTrustedCheckpoint(TBCDEV_BOOTSTRAP_CHECKPOINT_V1);
	assert.throws(() => validateNextTbcPostForkHeader(checkpoint, {
		...REAL_MT_DEPOSIT_BLOCK, previousBlockHash: '0'.repeat(64),
	}, REAL_MT_DAA_POINTS), /does not link/);
	assert.throws(() => validateNextTbcPostForkHeader(checkpoint, {
		...REAL_MT_DEPOSIT_BLOCK, bits: REAL_MT_DEPOSIT_BLOCK.bits + 1,
	}, REAL_MT_DAA_POINTS), /invalid TBC difficulty/);
});

test('selects greatest cumulative chainwork and refuses an unresolved tie', () => {
	const checkpoint = validateTrustedCheckpoint(TBCDEV_BOOTSTRAP_CHECKPOINT_V1);
	const deposit = validateNextTbcPostForkHeader(checkpoint, REAL_MT_DEPOSIT_BLOCK, REAL_MT_DAA_POINTS);
	assert.equal(selectGreatestWorkTip([checkpoint, deposit]).hash, deposit.hash);
	const taller = { ...deposit, height: deposit.height + 10 };
	const heavier = { ...deposit, height: deposit.height + 1, hash: '2'.repeat(64), chainWork: deposit.chainWork + 1n };
	assert.equal(selectGreatestWorkTip([taller, heavier]).hash, heavier.hash);
	assert.throws(() => selectGreatestWorkTip([
		deposit,
		{ ...deposit, hash: '1'.repeat(64) },
	]), /equal chainwork/);
});
