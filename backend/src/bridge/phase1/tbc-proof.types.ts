// Phase 1 is intentionally hard-locked to the official tbcdev test route.
export type TbcNetwork = 'testnet';

export interface TbcTransactionLocation {
	confirmed: boolean;
	blockHash: string | null;
	blockHeight: number | null;
	blockTime: number | null;
	confirmations: number | null;
}

export interface TbcBlockRecord {
	hash: string;
	height: number;
	version: number;
	previousBlockHash: string;
	merkleRoot: string;
	time: number;
	bits: number;
	nonce: number;
	transactionCount: number;
}

export interface TbcProofDataSource {
	readonly id: string;
	readonly network: TbcNetwork;
	locateTransaction(txid: string, signal?: AbortSignal): Promise<TbcTransactionLocation>;
	readRawTransaction(txid: string, signal?: AbortSignal): Promise<string>;
	readBlock(height: number, signal?: AbortSignal): Promise<TbcBlockRecord>;
	readOrderedTransactionIds(block: TbcBlockRecord, signal?: AbortSignal): Promise<string[]>;
}

export interface TbcMerkleStep {
	hash: string;
	side: 'left' | 'right';
}

export interface TbcInclusionProofBundle {
	schemaVersion: 'learningmaterials/tbc-inclusion-proof/v1';
	network: TbcNetwork;
	purpose: 'phase1-proof-material-only';
	proofMaterial: {
		txid: string;
		vout: number;
		rawTransaction: string;
		transactionIndex: number;
		blockHeight: number;
		blockHash: string;
		blockWork: string;
		blockHeader: {
			raw: string;
			version: number;
			previousBlockHash: string;
			merkleRoot: string;
			time: number;
			bits: number;
			nonce: number;
		};
		merkleBranch: TbcMerkleStep[];
	};
	observation: {
		provider: string;
		confirmations: number | null;
		blockTime: number | null;
		warning: 'provider metadata is not a canonical-chain proof';
	};
}
