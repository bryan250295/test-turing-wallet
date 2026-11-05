import type { TbcBlockRecord } from './tbc-proof.types';

export interface TrustedTbcCheckpoint {
	id: string;
	route: 'tbcdev-testnet';
	authority: 'official-tbcscan';
	selectedAt: string;
	block: TbcBlockRecord;
	chainWork: bigint;
	sources: readonly string[];
}

/**
 * Parent of the first captured real MT deposit. The project owner confirmed
 * that TBCScan is an official trusted source for this learning/test route.
 * Headers after this trust anchor are still verified locally.
 */
export const TBCDEV_BOOTSTRAP_CHECKPOINT_V1: TrustedTbcCheckpoint = Object.freeze({
	id: 'tbcdev-official-839164-v1',
	route: 'tbcdev-testnet',
	authority: 'official-tbcscan',
	selectedAt: '2026-11-03T13:18:01+08:00',
	block: Object.freeze({
		height: 839164,
		hash: '000000000000023f252086d278485a61b6c225ad07213fff329ef5e31e1c256b',
		version: 558112768,
		previousBlockHash: '000000000000039ec70bf61aed89b6cd6ada52e63f1bc11cf6629541a7740ab2',
		merkleRoot: 'd51c636b8a6959ecc9754595884cf7ce4cd79ffb7a2bee75f714a293310ccc50',
		time: 1793335668,
		bits: 0x1a041f18,
		nonce: 2128804428,
		transactionCount: 1,
	}),
	chainWork: BigInt('0x14f15b416fbbd30a34db4b3'),
	sources: Object.freeze([
		'https://scanapi.tbcdev.org/api/blocks/839164',
		'https://api.tbcdev.org/api/tbc/blockByHeight/height/839164',
	]),
});

/**
 * Public HyperEVM Testnet deployment anchor. This block had six confirmations
 * when selected from the official tbcdev API. Keeping it separate from V1
 * preserves the original Phase 3 evidence while avoiding hundreds of relay
 * transactions before the first public proof-backed mint.
 */
export const TBCDEV_BOOTSTRAP_CHECKPOINT_V2: TrustedTbcCheckpoint = Object.freeze({
	id: 'tbcdev-official-840039-v2',
	route: 'tbcdev-testnet',
	authority: 'official-tbcscan',
	selectedAt: '2026-11-05T16:50:19+08:00',
	block: Object.freeze({
		height: 840039,
		hash: '000000000000005270e8447f4c71c6952ef28e40625fc58ddd38c027f5ef1cda',
		version: 539566080,
		previousBlockHash: '00000000000001427d6c8cae98f6abd5871f85578bdb2f660b3496de70a332fb',
		merkleRoot: '4d6188f659cc62d213cf062d817a3306521d457859af9fedd4a06bee11c15be0',
		time: 1793865664,
		bits: 0x1a043383,
		nonce: 1690531155,
		transactionCount: 12,
	}),
	chainWork: BigInt('0x14f15b4de5118dc88bc13c7'),
	sources: Object.freeze([
		'https://scanapi.tbcdev.org/api/blocks/840039',
		'https://api.tbcdev.org/api/tbc/blockByHeight/height/840039',
		'https://api.tbcdev.org/api/tbc/nodeinfo',
	]),
});
