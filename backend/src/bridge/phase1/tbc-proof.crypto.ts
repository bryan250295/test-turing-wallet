import { createHash } from 'node:crypto';
import type { TbcBlockRecord, TbcMerkleStep } from './tbc-proof.types';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeHash(value: string, label = 'hash') {
	const normalized = value.toLowerCase();
	if (!HASH_PATTERN.test(normalized)) throw new Error(`${label} must be 32-byte lowercase hexadecimal.`);
	return normalized;
}

export function doubleSha256(value: Uint8Array) {
	const first = createHash('sha256').update(value).digest();
	return createHash('sha256').update(first).digest();
}

function internalHash(displayHash: string) {
	return Buffer.from(normalizeHash(displayHash), 'hex').reverse();
}

function displayHash(internal: Uint8Array) {
	return Buffer.from(internal).reverse().toString('hex');
}

export function serializeBlockHeader(block: Pick<TbcBlockRecord, 'version' | 'previousBlockHash' | 'merkleRoot' | 'time' | 'bits' | 'nonce'>) {
	const header = Buffer.alloc(80);
	header.writeUInt32LE(block.version, 0);
	internalHash(block.previousBlockHash).copy(header, 4);
	internalHash(block.merkleRoot).copy(header, 36);
	header.writeUInt32LE(block.time, 68);
	header.writeUInt32LE(block.bits, 72);
	header.writeUInt32LE(block.nonce, 76);
	return header;
}

export function blockHashFromHeader(header: Uint8Array) {
	if (header.byteLength !== 80) throw new Error('A TBC block header must be exactly 80 bytes.');
	return displayHash(doubleSha256(header));
}

function parent(left: Uint8Array, right: Uint8Array) {
	return doubleSha256(Buffer.concat([left, right]));
}

export function merkleRootFromTransactionIds(transactionIds: readonly string[]) {
	if (transactionIds.length === 0) throw new Error('A Merkle tree requires at least one transaction.');
	let level: Uint8Array[] = transactionIds.map(internalHash);
	while (level.length > 1) {
		if (level.length % 2 === 1) level.push(level[level.length - 1]);
		const next: Uint8Array[] = [];
		for (let index = 0; index < level.length; index += 2) next.push(parent(level[index], level[index + 1]));
		level = next;
	}
	return displayHash(level[0]);
}

export function buildMerkleBranch(transactionIds: readonly string[], transactionIndex: number): TbcMerkleStep[] {
	if (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0 || transactionIndex >= transactionIds.length) throw new Error('Invalid Merkle transaction index.');
	let index = transactionIndex;
	let level: Uint8Array[] = transactionIds.map(internalHash);
	const branch: TbcMerkleStep[] = [];
	while (level.length > 1) {
		if (level.length % 2 === 1) level.push(level[level.length - 1]);
		const siblingIndex = index ^ 1;
		branch.push({ hash: displayHash(level[siblingIndex]), side: siblingIndex < index ? 'left' : 'right' });
		const next: Uint8Array[] = [];
		for (let offset = 0; offset < level.length; offset += 2) next.push(parent(level[offset], level[offset + 1]));
		level = next;
		index = Math.floor(index / 2);
	}
	return branch;
}

export function merkleRootFromBranch(txid: string, branch: readonly TbcMerkleStep[]) {
	let current = internalHash(txid);
	for (const step of branch) {
		const sibling = internalHash(step.hash);
		current = step.side === 'left' ? parent(sibling, current) : parent(current, sibling);
	}
	return displayHash(current);
}
