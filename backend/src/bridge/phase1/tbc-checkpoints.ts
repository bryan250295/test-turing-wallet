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
