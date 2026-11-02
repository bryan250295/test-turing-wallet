// SDK 1.7.3 exports version detection publicly, but its full identity descriptor
// is internal. Keep this version-pinned adapter in one place; never infer v3
// outpoint offsets from script length alone or rebuild it with a v4 constructor.
interface PublishedFtCode {
	family: string;
	version: number;
	coin: boolean;
	tapeSize: number;
	originalUTXOWire36Hex?: string;
}

const artifacts = require('tbc-contract/lib/validator/ft-artifacts') as {
	decodePublishedFTCode: (code: string) => PublishedFtCode | null;
	isPublishedFTTape: (tape: string) => boolean;
};

export const decodeLegacyFtCode = artifacts.decodePublishedFTCode;
export const isLegacyFtTape = artifacts.isPublishedFTTape;
