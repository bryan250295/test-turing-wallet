import tbc from 'tbc-lib-js';
import { assertProofOfWork, blockWork, TBC_MAIN_POW_LIMIT } from './tbc-consensus';
import { blockHashFromHeader, buildMerkleBranch, merkleRootFromBranch, merkleRootFromTransactionIds, normalizeHash, serializeBlockHeader } from './tbc-proof.crypto';
import type { TbcInclusionProofBundle, TbcProofDataSource } from './tbc-proof.types';

interface ProofBuildOptions { signal?: AbortSignal; powLimit?: bigint }

export async function buildTbcInclusionProof(source: TbcProofDataSource, txidInput: string, vout: number, options: ProofBuildOptions = {}): Promise<TbcInclusionProofBundle> {
	const { signal, powLimit = TBC_MAIN_POW_LIMIT } = options;
	const txid = normalizeHash(txidInput, 'TXID');
	if (!Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('Vout must be an unsigned 32-bit integer.');
	const location = await source.locateTransaction(txid, signal);
	if (!location.confirmed || location.blockHeight === null || location.blockHash === null) throw new Error('Transaction is not in a confirmed block.');
	const rawTransaction = await source.readRawTransaction(txid, signal);
	let transaction: tbc.Transaction;
	try { transaction = new tbc.Transaction(rawTransaction); }
	catch { throw new Error('Raw transaction is not valid TBC transaction encoding.'); }
	if (transaction.hash !== txid || transaction.toBuffer().toString('hex') !== rawTransaction) throw new Error('Raw transaction does not reproduce the requested TBC TXID.');
	if (vout >= transaction.outputs.length) throw new Error('Vout does not exist in the source transaction.');

	const block = await source.readBlock(location.blockHeight, signal);
	if (block.hash !== location.blockHash) throw new Error('Transaction status and block endpoint disagree on the block hash.');
	const header = serializeBlockHeader(block);
	if (blockHashFromHeader(header) !== block.hash) throw new Error('Block fields do not reproduce the reported block hash.');
	assertProofOfWork(block.hash, block.bits, powLimit);
	const ids = await source.readOrderedTransactionIds(block, signal);
	if (ids.length !== block.transactionCount) throw new Error('Ordered transaction count does not match the block header record.');
	const transactionIndex = ids.indexOf(txid);
	if (transactionIndex < 0 || ids.indexOf(txid, transactionIndex + 1) >= 0) throw new Error('Target TXID must appear exactly once in the block transaction list.');
	const computedRoot = merkleRootFromTransactionIds(ids);
	if (computedRoot !== block.merkleRoot) throw new Error('Ordered transaction IDs do not reproduce the block Merkle root.');
	const merkleBranch = buildMerkleBranch(ids, transactionIndex);
	if (merkleRootFromBranch(txid, merkleBranch) !== block.merkleRoot) throw new Error('Generated Merkle branch failed local verification.');

	return {
		schemaVersion: 'learningmaterials/tbc-inclusion-proof/v1',
		network: source.network,
		purpose: 'phase1-proof-material-only',
		proofMaterial: {
			txid, vout, rawTransaction, transactionIndex,
			blockHeight: block.height, blockHash: block.hash, blockWork: blockWork(block.bits).toString(),
			blockHeader: {
				raw: header.toString('hex'), version: block.version,
				previousBlockHash: block.previousBlockHash, merkleRoot: block.merkleRoot,
				time: block.time, bits: block.bits, nonce: block.nonce,
			},
			merkleBranch,
		},
		observation: {
			provider: source.id, confirmations: location.confirmations, blockTime: location.blockTime,
			warning: 'provider metadata is not a canonical-chain proof',
		},
	};
}
