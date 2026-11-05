import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import type { Hex } from 'viem';
import {
	TBCDEV_BOOTSTRAP_CHECKPOINT_V1, TBCDEV_BOOTSTRAP_CHECKPOINT_V2,
} from '../phase1/tbc-checkpoints';
import {
	bootstrapBinarySha256V2, buildTbcdevBootstrapCommitmentV2,
	decodeTbcdevBootstrapContextV2, encodeTbcdevBootstrapContextV2,
	tbcdevBootstrapProofV2, verifyTbcdevBootstrapProofV2,
	TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH_V2, TBCDEV_BOOTSTRAP_END_HEIGHT_V2,
	TBCDEV_BOOTSTRAP_POINT_COUNT_V2, TBCDEV_BOOTSTRAP_START_HEIGHT_V2,
} from './bootstrap-history-v2';

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
	const manifest = JSON.parse(await readFile(
		resolve(fixtures, 'tbcdev-bootstrap-history-v2.json'), 'utf8',
	)) as Manifest;
	const binary = await readFile(resolve(fixtures, 'tbcdev-bootstrap-history-v2.bin'));
	return { manifest, binary, points: decodeTbcdevBootstrapContextV2(binary) };
}

test('reproduces the public Testnet v2 bootstrap binary and commitment', async () => {
	const { manifest, binary, points } = await fixture();
	assert.equal(points.length, TBCDEV_BOOTSTRAP_POINT_COUNT_V2);
	assert.equal(manifest.pointCount, points.length);
	assert.equal(manifest.binaryBytes, binary.length);
	assert.equal(bootstrapBinarySha256V2(binary), manifest.binarySha256);
	assert.equal(encodeTbcdevBootstrapContextV2(points).equals(binary), true);
	assert.equal(manifest.commitmentDomainHash, TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH_V2);
	assert.equal(buildTbcdevBootstrapCommitmentV2(points).root, manifest.commitmentRoot);
	assert.equal(points[0].height, TBCDEV_BOOTSTRAP_START_HEIGHT_V2);
	assert.equal(points.at(-1)!.height, TBCDEV_BOOTSTRAP_END_HEIGHT_V2);
	assert.equal(points.at(-1)!.blockHash, TBCDEV_BOOTSTRAP_CHECKPOINT_V2.block.hash);
	assert.equal(points.at(-1)!.chainWork, TBCDEV_BOOTSTRAP_CHECKPOINT_V2.chainWork);
	const prior = points.find((point) => point.height === TBCDEV_BOOTSTRAP_CHECKPOINT_V1.block.height);
	assert.equal(prior?.blockHash, TBCDEV_BOOTSTRAP_CHECKPOINT_V1.block.hash);
	assert.equal(prior?.chainWork, TBCDEV_BOOTSTRAP_CHECKPOINT_V1.chainWork);
});

test('verifies public Testnet v2 start, middle and checkpoint proofs', async () => {
	const { manifest, points } = await fixture();
	const commitment = buildTbcdevBootstrapCommitmentV2(points);
	for (const index of [0, Math.floor(points.length / 2), points.length - 1]) {
		const point = points[index];
		const proof = tbcdevBootstrapProofV2(commitment, point.height);
		assert.equal(proof.length, 13);
		assert.equal(verifyTbcdevBootstrapProofV2(point, proof, manifest.commitmentRoot), true);
	}
	assert.deepEqual(
		tbcdevBootstrapProofV2(commitment, TBCDEV_BOOTSTRAP_END_HEIGHT_V2),
		manifest.checkpointProof,
	);
});
