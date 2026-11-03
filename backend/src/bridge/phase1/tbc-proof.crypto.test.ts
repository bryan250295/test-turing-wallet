import assert from 'node:assert/strict';
import test from 'node:test';
import { blockHashFromHeader, buildMerkleBranch, merkleRootFromBranch, merkleRootFromTransactionIds, serializeBlockHeader } from './tbc-proof.crypto';

const screenshotVector = {
	transactionIds: [
		'fe3434cb82b887d1a097e8971869c3fb2c55adff99a450eac2d71cc0e838c9ff',
		'caa5c8edf30de71042b1e413bfa17eab4aecdf126c49be4466b2d9c940d17d70',
		'e2e00c5afdf5a9be5aeb586b5d60e10231e7e25789e6e2ecd3b4ad7edf24b80e',
		'be766561dd00f7536aa92914e399f7b049f020b89107cf0800b409e5038bbe02',
		'11df2827c98dd5370277b9c2df7e50023ee0f408552770d3217e3fecaf15f6ed',
	],
	merkleRoot: '0089244e1171ecca4c8e780e994cfc06b7a78e33237ab17eb45ee5be20d18118',
};

test('reproduces the TBCScan block 837731 Merkle root and odd-leaf branch', () => {
	assert.equal(merkleRootFromTransactionIds(screenshotVector.transactionIds), screenshotVector.merkleRoot);
	const branch = buildMerkleBranch(screenshotVector.transactionIds, 4);
	assert.deepEqual(branch, [
		{ hash: screenshotVector.transactionIds[4], side: 'right' },
		{ hash: 'c596026e784f908e442b3883ed41e23937921deace27f75ebab9b4e6f7d1f5b4', side: 'right' },
		{ hash: '1a3f798f541c6dca88f46d1ee59041cf2a1336c4bde89b598248ca12dc49c372', side: 'left' },
	]);
	assert.equal(merkleRootFromBranch(screenshotVector.transactionIds[4], branch), screenshotVector.merkleRoot);
});

test('rejects a mutated Merkle branch by producing a different root', () => {
	const branch = buildMerkleBranch(screenshotVector.transactionIds, 4);
	branch[1] = { ...branch[1], hash: `0${branch[1].hash.slice(1)}` };
	assert.notEqual(merkleRootFromBranch(screenshotVector.transactionIds[4], branch), screenshotVector.merkleRoot);
});

test('serializes and hashes the Bitcoin genesis header using the shared TBC header rules', () => {
	const header = serializeBlockHeader({
		version: 1,
		previousBlockHash: '0'.repeat(64),
		merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
		time: 1231006505,
		bits: 0x1d00ffff,
		nonce: 2083236893,
	});
	assert.equal(header.length, 80);
	assert.equal(blockHashFromHeader(header), '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
});

test('reproduces the real supported MT deposit header and Merkle branch', () => {
	const txid = 'd87d9f42f427a7ac1ade5d2896a88a3e99deeec7257ae5df3ae2c013a3823519';
	const merkleRoot = 'cf2ac74ae087c96d00f28d2d6b214f2a7d3085c2dd56058721bc1187bef468ff';
	const header = serializeBlockHeader({
		version: 546054144,
		previousBlockHash: '000000000000023f252086d278485a61b6c225ad07213fff329ef5e31e1c256b',
		merkleRoot,
		time: 1793340839,
		bits: 0x1a0420a6,
		nonce: 1582390056,
	});
	assert.equal(header.toString('hex'), '00208c206b251c1ee3f59e32ff3f2107ad25c2b6615a4878d28620253f02000000000000ff68f4be8711bc21870556ddc285307d2a4f216b2d8df2006dc987e04ac72acfa735e46aa620041a285b515e');
	assert.equal(blockHashFromHeader(header), '0000000000000157b648773dea20cc8addccb3708ec07c330ab711ca033123a9');
	assert.equal(merkleRootFromBranch(txid, [
		{ hash: '0f1f7aad5b51a8de9d37586de34d5271aa6d005dfb966b99602d0b6643ab2aec', side: 'left' },
		{ hash: '4b76fd1b66b74bf268bffb5f7225a2d9e00720dabbd08a7a6449ddca4a8d7d61', side: 'right' },
	]), merkleRoot);
});
