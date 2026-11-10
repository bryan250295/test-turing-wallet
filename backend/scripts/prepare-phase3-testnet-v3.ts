import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OfficialTbcApiProofSource, TbcScanProofSource } from '../src/bridge/phase1/tbc-proof.sources';
import { assertProofOfWork, blockWork, expectedTbcPostForkBits } from '../src/bridge/phase1/tbc-consensus';
import { blockHashFromHeader, serializeBlockHeader } from '../src/bridge/phase1/tbc-proof.crypto';
import type { TbcBlockRecord } from '../src/bridge/phase1/tbc-proof.types';
import { decodeTbcdevBootstrapContextV2 } from '../src/bridge/phase3/bootstrap-history-v2';
import {
	bootstrapBinarySha256V3, buildTbcdevBootstrapCommitmentV3,
	encodeTbcdevBootstrapContextV3, tbcdevBootstrapProofV3,
	verifyTbcdevBootstrapProofV3, TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH_V3,
	TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_V3, TBCDEV_BOOTSTRAP_CONTEXT_SCHEMA_V3,
	TBCDEV_BOOTSTRAP_POINT_COUNT_V3, TBCDEV_BOOTSTRAP_RECORD_BYTES_V3,
	type TbcBootstrapContextPointV3,
} from '../src/bridge/phase3/bootstrap-history-v3';

const API = 'https://api.tbcdev.org/api/tbc';
const CONFIRMATIONS = 6;
const WORKERS = 4;
const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');
const sharedConfig = resolve(process.cwd(), '../shared/src/config/phase3-testnet-v3-candidate.json');
const extensionCache = resolve(process.cwd(), '.phase3-cache/tbcdev-bootstrap-v3');

type JsonRecord = Record<string, unknown>;
function record(value: unknown, label: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object.`);
	return value as JsonRecord;
}
function integer(value: unknown, label: string) {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
	return parsed;
}
async function nodeTip() {
	const response = await fetch(`${API}/nodeinfo`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) throw new Error(`TBC nodeinfo returned HTTP ${response.status}.`);
	const envelope = record(await response.json(), 'TBC nodeinfo response');
	if (String(envelope.code) !== '200') throw new Error(`TBC nodeinfo returned code ${String(envelope.code)}.`);
	return integer(record(envelope.data, 'TBC nodeinfo data').blocks, 'TBC tip height');
}
function requiredDifficultyHeights(previousHeight: number) {
	return [
		previousHeight - 8_064,
		previousHeight - 146,
		previousHeight - 145,
		previousHeight - 144,
		...Array.from({ length: 23 }, (_, index) => previousHeight - 22 + index),
	];
}
async function cachedOfficialBlock(source: OfficialTbcApiProofSource, height: number) {
	const path = resolve(extensionCache, `${height}.json`);
	try {
		const cached = JSON.parse(await readFile(path, 'utf8')) as TbcBlockRecord;
		if (cached.height === height) return cached;
	} catch { /* Fetch missing or invalid cache entry again. */ }
	const block = await source.readBlock(height);
	await mkdir(extensionCache, { recursive: true });
	await writeFile(path, `${JSON.stringify(block)}\n`);
	return block;
}
async function collectExtension(startHeight: number, endHeight: number) {
	if (endHeight < startHeight) return [];
	const heights = Array.from({ length: endHeight - startHeight + 1 }, (_, index) => startHeight + index);
	const blocks = new Array<TbcBlockRecord>(heights.length);
	const source = new OfficialTbcApiProofSource();
	let cursor = 0;
	await Promise.all(Array.from({ length: WORKERS }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= heights.length) return;
			blocks[index] = await cachedOfficialBlock(source, heights[index]!);
			if ((index + 1) % 50 === 0 || index + 1 === heights.length) console.log(`Fetched/loaded ${index + 1}/${heights.length} extension blocks.`);
		}
	}));
	return blocks;
}
async function crossCheck(blocks: readonly TbcBlockRecord[]) {
	const scan = new TbcScanProofSource();
	const selected = blocks.filter((_, index) => index === 0 || index === blocks.length - 1 || index % 100 === 0);
	for (const block of selected) {
		const observed = await scan.readBlock(block.height);
		if (JSON.stringify(observed) !== JSON.stringify(block)) throw new Error(`TBCScan differs from the official API at ${block.height}.`);
	}
	return selected.map((block) => block.height);
}

async function main() {
	const v2Manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'tbcdev-bootstrap-history-v2.json'), 'utf8')) as { binaryFile: string; endHeight: number };
	const v2Points = decodeTbcdevBootstrapContextV2(await readFile(resolve(fixtureRoot, v2Manifest.binaryFile)));
	const v2Checkpoint = v2Points.at(-1)!;
	if (v2Checkpoint.height !== v2Manifest.endHeight) throw new Error('V2 bootstrap fixture and manifest disagree.');

	const observedTip = await nodeTip();
	const checkpointHeight = observedTip - (CONFIRMATIONS - 1);
	if (checkpointHeight <= v2Checkpoint.height) throw new Error('The selected V3 checkpoint does not advance V2.');
	if (checkpointHeight - v2Checkpoint.height >= TBCDEV_BOOTSTRAP_POINT_COUNT_V3) throw new Error('V3 preparation is too far beyond V2 to reuse the verified support window.');
	const extension = await collectExtension(v2Checkpoint.height + 1, checkpointHeight);
	const crossCheckedHeights = await crossCheck(extension);

	const points = new Map<number, TbcBootstrapContextPointV3>(v2Points.map((point) => [point.height, point]));
	let previous = v2Checkpoint;
	for (const block of extension) {
		const rawHeader = serializeBlockHeader(block);
		if (block.height !== previous.height + 1 || block.previousBlockHash !== previous.blockHash) throw new Error(`V3 extension linkage failed at ${block.height}.`);
		if (blockHashFromHeader(rawHeader) !== block.hash) throw new Error(`V3 extension header ${block.height} does not reproduce its hash.`);
		assertProofOfWork(block.hash, block.bits);
		const required = requiredDifficultyHeights(previous.height).map((height) => {
			const point = points.get(height);
			if (!point) throw new Error(`V3 extension is missing DAA point ${height}.`);
			return point;
		});
		const expectedBits = expectedTbcPostForkBits(required, previous.height);
		if (block.bits !== expectedBits) throw new Error(`V3 extension DAA mismatch at ${block.height}.`);
		const point: TbcBootstrapContextPointV3 = {
			height: block.height,
			blockHash: block.hash,
			rawHeader: rawHeader.toString('hex'),
			time: block.time,
			bits: block.bits,
			chainWork: previous.chainWork + blockWork(block.bits),
		};
		points.set(point.height, point);
		previous = point;
	}

	const startHeight = checkpointHeight - (TBCDEV_BOOTSTRAP_POINT_COUNT_V3 - 1);
	const context = Array.from({ length: TBCDEV_BOOTSTRAP_POINT_COUNT_V3 }, (_, index) => {
		const point = points.get(startHeight + index);
		if (!point) throw new Error(`V3 commitment is missing point ${startHeight + index}.`);
		return point;
	});
	const checkpoint = extension.at(-1)!;
	const commitment = buildTbcdevBootstrapCommitmentV3(context, checkpoint.hash);
	const proof = tbcdevBootstrapProofV3(commitment, checkpoint.height);
	if (!verifyTbcdevBootstrapProofV3(context.at(-1)!, proof, commitment)) throw new Error('V3 checkpoint proof failed self-verification.');
	const binary = encodeTbcdevBootstrapContextV3(context);
	const binaryFile = `tbcdev-bootstrap-history-v3-${checkpoint.height}.bin`;
	const manifestFile = `tbcdev-bootstrap-history-v3-${checkpoint.height}.json`;
	const preparedAt = new Date().toISOString();
	const manifest = {
		schemaVersion: TBCDEV_BOOTSTRAP_CONTEXT_SCHEMA_V3,
		status: 'candidate-not-deployed',
		route: 'tbcdev-testnet',
		preparedAt,
		observedTip,
		requiredConfirmations: CONFIRMATIONS,
		checkpoint: {
			height: checkpoint.height,
			hash: `0x${checkpoint.hash}`,
			version: checkpoint.version,
			previousBlockHash: `0x${checkpoint.previousBlockHash}`,
			merkleRoot: `0x${checkpoint.merkleRoot}`,
			time: checkpoint.time,
			bits: checkpoint.bits,
			nonce: checkpoint.nonce,
			transactionCount: checkpoint.transactionCount,
			chainWork: `0x${context.at(-1)!.chainWork.toString(16).padStart(64, '0')}`,
		},
		bootstrap: {
			startHeight,
			endHeight: checkpoint.height,
			pointCount: TBCDEV_BOOTSTRAP_POINT_COUNT_V3,
			recordBytes: TBCDEV_BOOTSTRAP_RECORD_BYTES_V3,
			binaryFile,
			binaryBytes: binary.length,
			binarySha256: bootstrapBinarySha256V3(binary),
			commitmentDomain: TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_V3,
			commitmentDomainHash: TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH_V3,
			commitmentRoot: commitment.root,
			checkpointProof: proof,
		},
		crossCheckedHeights,
		sources: ['https://api.tbcdev.org/api/tbc', 'https://scanapi.tbcdev.org/api'],
		safety: {
			broadcast: false,
			oldRouteAction: 'paused',
			oldDepositTxid: '96f0d0a76ba406a684537469a269e70a7584a917bb37c9ff7de68ae64aed1caa',
		},
	};
	await mkdir(fixtureRoot, { recursive: true });
	await writeFile(resolve(fixtureRoot, binaryFile), binary);
	await writeFile(resolve(fixtureRoot, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(sharedConfig, `${JSON.stringify({ ...manifest, bootstrap: { ...manifest.bootstrap, manifestFile } }, null, 2)}\n`);
	console.log(`Prepared V3 checkpoint ${checkpoint.height} (${CONFIRMATIONS} confirmations at observed tip ${observedTip}).`);
	console.log(`Verified ${extension.length} linked PoW/DAA transitions beyond V2.`);
	console.log(`Bootstrap commitment root: ${commitment.root}`);
	console.log('No contract was deployed and no transaction was broadcast.');
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
