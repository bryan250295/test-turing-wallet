import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { decodeTbcdevBootstrapContextV2 } from './bootstrap-history-v2';
import {
	bootstrapBinarySha256V3, buildTbcdevBootstrapCommitmentV3,
	decodeTbcdevBootstrapContextV3, encodeTbcdevBootstrapContextV3,
	tbcdevBootstrapProofV3, verifyTbcdevBootstrapProofV3,
} from './bootstrap-history-v3';

const fixtures = resolve(process.cwd(), 'src/bridge/phase3/fixtures');

test('v3 bootstrap encoding is parameterized by its checkpoint and round-trips', async () => {
	const v2 = decodeTbcdevBootstrapContextV2(await readFile(resolve(fixtures, 'tbcdev-bootstrap-history-v2.bin')));
	const checkpoint = v2.at(-1)!;
	const encoded = encodeTbcdevBootstrapContextV3(v2);
	const decoded = decodeTbcdevBootstrapContextV3(encoded, v2[0]!.height);
	assert.deepEqual(decoded, v2);
	assert.match(bootstrapBinarySha256V3(encoded), /^[0-9a-f]{64}$/);

	const commitment = buildTbcdevBootstrapCommitmentV3(decoded, checkpoint.blockHash);
	const proof = tbcdevBootstrapProofV3(commitment, checkpoint.height);
	assert.equal(proof.length, 13);
	assert.equal(verifyTbcdevBootstrapProofV3(checkpoint, proof, commitment), true);
	assert.equal(verifyTbcdevBootstrapProofV3({ ...checkpoint, time: checkpoint.time + 1 }, proof, commitment), false);
});
