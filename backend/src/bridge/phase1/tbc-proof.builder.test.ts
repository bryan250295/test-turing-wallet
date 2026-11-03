import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTbcInclusionProof } from './tbc-proof.builder';
import type { TbcBlockRecord, TbcProofDataSource } from './tbc-proof.types';

// Minimal fixed TBC version-10 transaction with one zero-satoshi OP_RETURN output.
const txid = '05d4aa0cea6dd08ed9723f685120b7389a42963760498897e30e12a0cd2e77b7';
const rawTransaction = '0a00000000010000000000000000016a00000000';
const block: TbcBlockRecord = {
	hash: '9b8fe080a39f86719b2ac7f685524a56eb8385ab410959b151d78addc53831bf',
	height: 0,
	version: 559636480,
	previousBlockHash: '0'.repeat(64),
	merkleRoot: txid,
	time: 1792473237,
	bits: 0x2100ffff,
	nonce: 563364325,
	transactionCount: 1,
};

const source: TbcProofDataSource = {
	id: 'offline-vector', network: 'testnet',
	async locateTransaction() { return { confirmed: true, blockHash: block.hash, blockHeight: 0, blockTime: block.time, confirmations: 1 }; },
	async readRawTransaction() { return rawTransaction; },
	async readBlock() { return block; },
	async readOrderedTransactionIds() { return [txid]; },
};

test('builds a self-consistent inclusion bundle and keeps provider metadata outside proof material', async () => {
	const proof = await buildTbcInclusionProof(source, txid, 0, { powLimit: (1n << 256n) - 1n });
	assert.equal(proof.proofMaterial.txid, txid);
	assert.equal(proof.proofMaterial.blockHash, block.hash);
	assert.equal(proof.proofMaterial.blockHeader.raw.length, 160);
	assert.deepEqual(proof.proofMaterial.merkleBranch, []);
	assert.equal(proof.observation.provider, 'offline-vector');
	assert.equal(proof.observation.warning, 'provider metadata is not a canonical-chain proof');
});

test('fails closed when provider block metadata is inconsistent', async () => {
	const inconsistent: TbcProofDataSource = { ...source, async readBlock() { return { ...block, hash: `1${block.hash.slice(1)}` }; } };
	await assert.rejects(buildTbcInclusionProof(inconsistent, txid, 0, { powLimit: (1n << 256n) - 1n }), /disagree on the block hash/);
});
