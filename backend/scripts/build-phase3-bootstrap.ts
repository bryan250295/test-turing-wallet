import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TbcScanProofSource } from '../src/bridge/phase1/tbc-proof.sources';
import type { TbcBlockRecord } from '../src/bridge/phase1/tbc-proof.types';
import {
	bootstrapBinarySha256, buildTbcdevBootstrapCommitment, decodeTbcdevBootstrapContext,
	deriveTbcdevBootstrapContext, encodeTbcdevBootstrapContext, tbcdevBootstrapProof,
	verifyTbcdevBootstrapProof, TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN,
	TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH, TBCDEV_BOOTSTRAP_CONTEXT_SCHEMA,
	TBCDEV_BOOTSTRAP_END_HEIGHT, TBCDEV_BOOTSTRAP_POINT_COUNT, TBCDEV_BOOTSTRAP_RECORD_BYTES,
	TBCDEV_BOOTSTRAP_FIRST_VERIFIABLE_DAA_HEIGHT, TBCDEV_BOOTSTRAP_START_HEIGHT,
	TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT,
} from '../src/bridge/phase3/bootstrap-history';
import { TBCDEV_BOOTSTRAP_CHECKPOINT_V1 } from '../src/bridge/phase1/tbc-checkpoints';

const API = 'https://api.tbcdev.org/api/tbc';
const PAGE_SIZE = 100;
const WORKERS = 3;
const cacheRoot = resolve(process.cwd(), '.phase3-cache/tbcdev-bootstrap-v1');
const fixtureRoot = resolve(process.cwd(), 'src/bridge/phase3/fixtures');

type JsonRecord = Record<string, unknown>;
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function record(value: unknown, label: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object.`);
	return value as JsonRecord;
}
function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label} is invalid.`);
	return parsed;
}
function hash(value: unknown, label: string) {
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} is invalid.`);
	return value.toLowerCase();
}
function parseBits(value: unknown) {
	if (typeof value !== 'string' || !/^[0-9a-f]{1,8}$/i.test(value)) throw new Error('Block bits are invalid.');
	return Number.parseInt(value, 16);
}
function parseBlock(value: unknown): TbcBlockRecord {
	const block = record(value, 'Recent block');
	return {
		hash: hash(block.hash, 'Block hash'),
		height: integer(block.height, 'Block height'),
		version: integer(block.version, 'Block version', 0xffffffff),
		previousBlockHash: hash(block.previoushash, 'Previous block hash'),
		merkleRoot: hash(block.merkleroot, 'Merkle root'),
		time: integer(block.time, 'Block time', 0xffffffff),
		bits: parseBits(block.bits),
		nonce: integer(block.nonce, 'Block nonce', 0xffffffff),
		transactionCount: integer(block.txcnt, 'Transaction count', 100_000),
	};
}

async function request(path: string) {
	for (let attempt = 1; attempt <= 4; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 25_000);
		try {
			const response = await fetch(`${API}/${path}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const envelope = record(await response.json(), 'API response');
			if (envelope.code !== '200') throw new Error(`API code ${String(envelope.code)}`);
			return envelope.data;
		} catch (error) {
			if (attempt === 4) throw error;
			await new Promise((done) => setTimeout(done, attempt * 500));
		} finally { clearTimeout(timer); }
	}
	throw new Error('Unreachable request retry state.');
}

interface Range { high: number; low: number }
function exactRange(blocks: TbcBlockRecord[], range: Range) {
	const expected = range.high - range.low + 1;
	if (blocks.length !== expected) return false;
	return blocks.every((block, index) => block.height === range.high - index);
}

async function fetchRange(range: Range) {
	const cachePath = resolve(cacheRoot, `${range.low}-${range.high}.json`);
	try {
		const cached = (JSON.parse(await readFile(cachePath, 'utf8')) as unknown[]).map(parseBlock);
		if (exactRange(cached, range)) return cached;
	} catch { /* Fetch a missing or invalid cache page again. */ }

	for (let attempt = 1; attempt <= 4; attempt++) {
		const info = record(await request('nodeinfo'), 'Node info');
		const tip = integer(info.blocks, 'Tip height');
		if (tip < range.high) throw new Error(`Testnet tip ${tip} is below required height ${range.high}.`);
		const start = tip - range.high;
		const end = start + (range.high - range.low + 1);
		const data = await request(`recentblocks/start/${start}/end/${end}`);
		requireValue(Array.isArray(data), 'Recent blocks response is not an array.');
		const blocks = data.map(parseBlock);
		if (!exactRange(blocks, range)) {
			if (attempt === 4) throw new Error(`Recent-block offset changed while fetching ${range.low}-${range.high}.`);
			continue;
		}
		await mkdir(cacheRoot, { recursive: true });
		await writeFile(cachePath, `${JSON.stringify(data)}\n`);
		return blocks;
	}
	throw new Error('Unreachable page retry state.');
}

async function collectHistory() {
	const ranges: Range[] = [];
	for (let high = TBCDEV_BOOTSTRAP_END_HEIGHT; high > TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT; high -= PAGE_SIZE) {
		ranges.push({ high, low: Math.max(TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT + 1, high - PAGE_SIZE + 1) });
	}
	const pages = new Array<TbcBlockRecord[]>(ranges.length);
	let cursor = 0;
	await Promise.all(Array.from({ length: WORKERS }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= ranges.length) return;
			pages[index] = await fetchRange(ranges[index]);
			if ((index + 1) % 10 === 0 || index + 1 === ranges.length) console.log(`Fetched/loaded ${index + 1}/${ranges.length} bootstrap pages.`);
		}
	}));
	const firstTbcBlock = await new TbcScanProofSource().readBlock(TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT);
	return [firstTbcBlock, ...pages.flat().sort((left, right) => left.height - right.height)];
}

async function crossCheckTbcScan(blocks: readonly TbcBlockRecord[]) {
	const indexed = new Map(blocks.map((block) => [block.height, block]));
	const heights = new Set([TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT, TBCDEV_BOOTSTRAP_START_HEIGHT, TBCDEV_BOOTSTRAP_END_HEIGHT]);
	for (let height = TBCDEV_BOOTSTRAP_START_HEIGHT; height < TBCDEV_BOOTSTRAP_END_HEIGHT; height += 1_000) heights.add(height);
	const scan = new TbcScanProofSource();
	for (const height of heights) {
		const observed = await scan.readBlock(height);
		const expected = indexed.get(height)!;
		if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`TBCScan cross-check differs at height ${height}.`);
	}
	return [...heights].sort((left, right) => left - right);
}

async function main() {
	const blocks = await collectHistory();
	const crossCheckedHeights = await crossCheckTbcScan(blocks);
	const points = deriveTbcdevBootstrapContext(blocks);
	const binary = encodeTbcdevBootstrapContext(points);
	const decoded = decodeTbcdevBootstrapContext(binary);
	const commitment = buildTbcdevBootstrapCommitment(decoded);
	const checkpointPoint = decoded.at(-1)!;
	const checkpointProof = tbcdevBootstrapProof(commitment, checkpointPoint.height);
	if (!verifyTbcdevBootstrapProof(checkpointPoint, checkpointProof, commitment.root)) throw new Error('Checkpoint commitment proof failed self-verification.');

	const binaryName = 'tbcdev-bootstrap-history-v1.bin';
	const manifest = {
		schemaVersion: TBCDEV_BOOTSTRAP_CONTEXT_SCHEMA,
		route: 'tbcdev-testnet',
		checkpointId: TBCDEV_BOOTSTRAP_CHECKPOINT_V1.id,
		checkpointHash: TBCDEV_BOOTSTRAP_CHECKPOINT_V1.block.hash,
		checkpointChainWork: TBCDEV_BOOTSTRAP_CHECKPOINT_V1.chainWork.toString(16).padStart(64, '0'),
		supportStartHeight: TBCDEV_BOOTSTRAP_SUPPORT_START_HEIGHT,
		firstVerifiableDaaHeight: TBCDEV_BOOTSTRAP_FIRST_VERIFIABLE_DAA_HEIGHT,
		verifiedDaaTransitions: TBCDEV_BOOTSTRAP_END_HEIGHT - TBCDEV_BOOTSTRAP_FIRST_VERIFIABLE_DAA_HEIGHT + 1,
		startHeight: TBCDEV_BOOTSTRAP_START_HEIGHT,
		endHeight: TBCDEV_BOOTSTRAP_END_HEIGHT,
		pointCount: TBCDEV_BOOTSTRAP_POINT_COUNT,
		recordBytes: TBCDEV_BOOTSTRAP_RECORD_BYTES,
		binaryFile: binaryName,
		binaryBytes: binary.length,
		binarySha256: bootstrapBinarySha256(binary),
		commitmentDomain: TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN,
		commitmentDomainHash: TBCDEV_BOOTSTRAP_CONTEXT_DOMAIN_HASH,
		commitmentRoot: commitment.root,
		checkpointProof,
		crossCheckedHeights,
		sources: ['https://api.tbcdev.org/api/tbc/recentblocks', 'https://scanapi.tbcdev.org/api/blocks/{height}'],
	};
	await mkdir(fixtureRoot, { recursive: true });
	await writeFile(resolve(fixtureRoot, binaryName), binary);
	await writeFile(resolve(fixtureRoot, 'tbcdev-bootstrap-history-v1.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Validated ${blocks.length} linked/PoW headers and ${manifest.verifiedDaaTransitions} exact DAA transitions.`);
	console.log(`Bootstrap commitment root: ${commitment.root}`);
	console.log(`Binary SHA-256: ${manifest.binarySha256}`);
	console.log('No contract was deployed and no transaction was submitted.');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
