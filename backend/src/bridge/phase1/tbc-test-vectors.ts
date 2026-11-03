import type { TbcDifficultyPoint } from './tbc-consensus';
import type { TbcBlockRecord } from './tbc-proof.types';

const point = (height: number, time: number, bits = 0x1d00ffff, chainWork = 0n): TbcDifficultyPoint => ({ height, time, bits, chainWork });

export const REAL_MT_DAA_POINTS: readonly TbcDifficultyPoint[] = Object.freeze([
	point(831100, 1788905936),
	point(839018, 1793250263),
	point(839019, 1793250425, 0x1a045184, BigInt('0x14f15b3f4540ffc03baa5a1')),
	point(839020, 1793251136),
	point(839142, 1793323196), point(839143, 1793324710), point(839144, 1793325384),
	point(839145, 1793325503), point(839146, 1793325893), point(839147, 1793326057),
	point(839148, 1793327448), point(839149, 1793327705), point(839150, 1793328159),
	point(839151, 1793328676), point(839152, 1793330190), point(839153, 1793330808),
	point(839154, 1793331195), point(839155, 1793331898), point(839156, 1793331993),
	point(839157, 1793332079), point(839158, 1793332637), point(839159, 1793333689),
	point(839160, 1793334470), point(839161, 1793334590), point(839162, 1793335341),
	point(839163, 1793335648, 0x1a042cf8, BigInt('0x14f15b416bda00752781167')),
	point(839164, 1793335668, 0x1a041f18, BigInt('0x14f15b416fbbd30a34db4b3')),
]);

export const REAL_MT_DEPOSIT_BLOCK: TbcBlockRecord = Object.freeze({
	height: 839165,
	hash: '0000000000000157b648773dea20cc8addccb3708ec07c330ab711ca033123a9',
	version: 546054144,
	previousBlockHash: '000000000000023f252086d278485a61b6c225ad07213fff329ef5e31e1c256b',
	merkleRoot: 'cf2ac74ae087c96d00f28d2d6b214f2a7d3085c2dd56058721bc1187bef468ff',
	time: 1793340839,
	bits: 0x1a0420a6,
	nonce: 1582390056,
	transactionCount: 3,
});
