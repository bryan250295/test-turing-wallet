import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import type { Hex } from 'viem';
import { TBCDEV_BOOTSTRAP_CHECKPOINT_V1 } from '../phase1/tbc-checkpoints';
import {
	bootstrapBinarySha256, buildTbcdevBootstrapCommitment, decodeTbcdevBootstrapContext,
	encodeTbcdevBootstrapContext, tbcdevBootstrapProof, verifyTbcdevBootstrapProof,
	TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH, TBCDEV_BOOTSTRAP_END_HEIGHT,
	TBCDEV_BOOTSTRAP_POINT_COUNT, TBCDEV_BOOTSTRAP_START_HEIGHT,
} from './bootstrap-history';

interface Manifest {
	pointCount: number;
	binaryBytes: number;
	binarySha256: string;
	commitmentDomainHash: Hex;
	commitmentRoot: Hex;
	checkpointProof: Hex[];
}

const fixtures = resolve(process.cwd(), 'src/bridge/phase3/fixtures');

async function fixture() {
	const manifest = JSON.parse(await readFile(resolve(fixtures, 'tbcdev-bootstrap-history-v1.json'), 'utf8')) as Manifest;
	const binary = await readFile(resolve(fixtures, 'tbcdev-bootstrap-history-v1.bin'));
	return { manifest, binary, points: decodeTbcdevBootstrapContext(binary) };
}

test('reproduces the frozen tbcdev bootstrap binary and commitment root', async () => {
	const { manifest, binary, points } = await fixture();
	assert.equal(points.length, TBCDEV_BOOTSTRAP_POINT_COUNT);
	assert.equal(manifest.pointCount, points.length);
	assert.equal(manifest.binaryBytes, binary.length);
	assert.equal(bootstrapBinarySha256(binary), manifest.binarySha256);
	assert.equal(encodeTbcdevBootstrapContext(points).equals(binary), true);
	assert.equal(manifest.commitmentDomainHash, TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH);
	assert.equal(buildTbcdevBootstrapCommitment(points).root, manifest.commitmentRoot);
	assert.equal(points[0].height, TBCDEV_BOOTSTRAP_START_HEIGHT);
	assert.equal(points.at(-1)!.height, TBCDEV_BOOTSTRAP_END_HEIGHT);
	assert.equal(points.at(-1)!.blockHash, TBCDEV_BOOTSTRAP_CHECKPOINT_V1.block.hash);
	assert.equal(points.at(-1)!.chainWork, TBCDEV_BOOTSTRAP_CHECKPOINT_V1.chainWork);
});

test('verifies canonical start, middle and duplicated-odd checkpoint proofs', async () => {
	const { manifest, points } = await fixture();
	const commitment = buildTbcdevBootstrapCommitment(points);
	for (const index of [0, Math.floor(points.length / 2), points.length - 1]) {
		const point = points[index];
		const proof = tbcdevBootstrapProof(commitment, point.height);
		assert.equal(proof.length, 13);
		assert.equal(verifyTbcdevBootstrapProof(point, proof, manifest.commitmentRoot), true);
	}
	assert.deepEqual(tbcdevBootstrapProof(commitment, TBCDEV_BOOTSTRAP_END_HEIGHT), manifest.checkpointProof);
	const checkpoint = points.at(-1)!;
	assert.equal(verifyTbcdevBootstrapProof({ ...checkpoint, time: checkpoint.time + 1 }, manifest.checkpointProof, manifest.commitmentRoot), false);
	assert.equal(verifyTbcdevBootstrapProof(checkpoint, manifest.checkpointProof.slice(1), manifest.commitmentRoot), false);
});
