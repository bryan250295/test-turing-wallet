import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import { decodeLegacyFtCode, isLegacyFtTape } from '../legacy-ft-code';
import {
	BRIDGE_COVENANT_SATOSHIS, BRIDGE_FT_CODE_SATOSHIS, bridgeCovenantFtController,
	logicalDepositId, parseBridgeCovenantScript, type BridgeCovenantIntent,
} from './bridge-covenant';

export const LEGACY_FT_DEPOSIT_PROOF_SCHEMA = 'learningmaterials/tbc-legacy-ft-deposit-proof/v1' as const;
export const LEGACY_FT_DEPOSIT_VOUT = 1;
export const LEGACY_FT_PROOF_MAX_TRANSACTIONS = 48;
export const LEGACY_FT_PROOF_MAX_BYTES = 8_000_000;
export const LEGACY_FT_PROOF_MAX_TRANSACTION_BYTES = 1_000_000;

export interface LegacyFtInputProofV1 {
	vin: number;
	parentTransaction: string;
	ancestorTransactions: string[];
}

export interface LegacyFtDepositProofV1 {
	schemaVersion: typeof LEGACY_FT_DEPOSIT_PROOF_SCHEMA;
	network: 'testnet';
	depositTransaction: string;
	genesisTransaction: string;
	inputProofs: LegacyFtInputProofV1[];
}

export interface VerifiedLegacyFtDeposit {
	txid: string;
	sourceVout: typeof LEGACY_FT_DEPOSIT_VOUT;
	sourceContractId: string;
	amountRaw: bigint;
	intent: BridgeCovenantIntent;
	covenantScript: string;
	covenantController: string;
	depositId: `0x${string}`;
	feeRaw: bigint;
	proofBytes: number;
}

export interface LegacyFtProofPolicy {
	expectedSourceContractId: string;
	expectedLegacyVersion: 1 | 2 | 3 | 4;
	expectedDestinationChainId: bigint;
	expectedDestinationGateway: `0x${string}`;
	expectedReserveControllerPubKeyHash: string;
}

const hex = /^(?:[0-9a-f]{2})+$/;
function requireProof(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function rawTransaction(value: string, transactions: Map<string, tbc.Transaction>, totals: { bytes: number }) {
	requireProof(typeof value === 'string' && hex.test(value) && value.length / 2 <= LEGACY_FT_PROOF_MAX_TRANSACTION_BYTES, 'Proof contains invalid or oversized raw transaction bytes.');
	totals.bytes += value.length / 2;
	requireProof(totals.bytes <= LEGACY_FT_PROOF_MAX_BYTES, 'Legacy FT proof exceeds the byte limit.');
	const transaction = new tbc.Transaction(value);
	requireProof(transaction.toObject().version === 10 && transaction.toBuffer().toString('hex') === value && transaction.hash.length === 64, 'Raw transaction is not a canonical TBC version-10 transaction.');
	const previous = transactions.get(transaction.hash);
	requireProof(!previous || previous.toBuffer().toString('hex') === value, 'Proof contains conflicting bytes for one TXID.');
	transactions.set(transaction.hash, transaction);
	requireProof(transactions.size <= LEGACY_FT_PROOF_MAX_TRANSACTIONS, 'Legacy FT proof exceeds the transaction-count limit.');
	return transaction;
}

function tapeAmount(output: tbc.Transaction.Output | undefined, genesisTape: string) {
	requireProof(output && output.satoshis === 0 && isLegacyFtTape(output.script.toHex()), 'Invalid legacy FT Tape output.');
	const slots = output.script.chunks[2]?.buf;
	requireProof(slots?.length === 48 && output.script.toHex() === sdk.FT.buildFTtransferTape(genesisTape, slots.toString('hex')).toHex(), 'Legacy FT Tape differs from the pinned genesis metadata.');
	return sdk.getFtBalanceFromTape(output.script.toHex());
}

export function verifyLegacyFtDepositProof(proof: LegacyFtDepositProofV1, policy: LegacyFtProofPolicy): VerifiedLegacyFtDeposit {
	requireProof(proof.schemaVersion === LEGACY_FT_DEPOSIT_PROOF_SCHEMA && proof.network === 'testnet', 'Unsupported legacy FT proof route or schema.');
	requireProof(Array.isArray(proof.inputProofs) && proof.inputProofs.length >= 2 && proof.inputProofs.length <= 7, 'Legacy FT proof must describe every bounded input.');
	const transactions = new Map<string, tbc.Transaction>();
	const totals = { bytes: 0 };
	const genesis = rawTransaction(proof.genesisTransaction, transactions, totals);
	const deposit = rawTransaction(proof.depositTransaction, transactions, totals);
	requireProof(deposit.inputs.length >= 2 && deposit.inputs.length <= 7 && deposit.outputs.length >= 3 && deposit.outputs.length <= 6, 'Deposit is outside the bounded legacy FT transaction shape.');
	requireProof(proof.inputProofs.length === deposit.inputs.length, 'Input proof count differs from the deposit transaction.');

	const genesisCode = genesis.outputs[0]?.script.toHex();
	const genesisTape = genesis.outputs[1]?.script.toHex();
	requireProof(genesisCode && genesisTape && genesis.hash === policy.expectedSourceContractId.toLowerCase(), 'Legacy FT genesis does not match the route policy.');
	const descriptor = decodeLegacyFtCode(genesisCode);
	requireProof(descriptor?.family === 'FT' && descriptor.version === policy.expectedLegacyVersion && descriptor.coin === false, 'Legacy FT format does not match the route policy.');
	requireProof(genesis.outputs[0].satoshis === BRIDGE_FT_CODE_SATOSHIS && genesis.outputs[1].satoshis === 0 && isLegacyFtTape(genesisTape), 'Legacy FT genesis Code/Tape layout is invalid.');

	const covenantOutput = deposit.outputs[0];
	requireProof(covenantOutput?.satoshis === BRIDGE_COVENANT_SATOSHIS, 'Deposit output 0 must be the Bridge Covenant output.');
	const intent = parseBridgeCovenantScript(covenantOutput.script);
	requireProof(intent.sourceContractId === genesis.hash, 'Bridge Covenant source Contract ID differs from the proven FT genesis.');
	requireProof(intent.destinationChainId === policy.expectedDestinationChainId
		&& intent.destinationGateway.toLowerCase() === policy.expectedDestinationGateway.toLowerCase(), 'Bridge Covenant destination differs from the route policy.');
	requireProof(intent.reserveControllerPubKeyHash === policy.expectedReserveControllerPubKeyHash.toLowerCase(), 'Bridge Covenant reserve controller differs from the route policy.');
	const covenantScript = covenantOutput.script.toHex();
	const covenantController = bridgeCovenantFtController(covenantOutput.script);
	const expectedCode = sdk.FT.buildFTtransferCode(genesisCode, covenantController).toHex();
	requireProof(deposit.outputs[LEGACY_FT_DEPOSIT_VOUT]?.satoshis === BRIDGE_FT_CODE_SATOSHIS
		&& deposit.outputs[LEGACY_FT_DEPOSIT_VOUT].script.toHex() === expectedCode, 'Deposit FT Code is not controlled by the committed Bridge Covenant.');
	const paid = tapeAmount(deposit.outputs[2], genesisTape);
	requireProof(paid === intent.amountRaw, 'Bridge Covenant amount differs from the legacy FT Tape amount.');

	const seen = new Set<string>();
	const balances: bigint[] = [];
	let inputControllerCode = '';
	let nativeInputScript = '';
	let nativeIn = 0n;
	const orderedProofs = [...proof.inputProofs].sort((a, b) => a.vin - b.vin);
	for (let vin = 0; vin < deposit.inputs.length; vin++) {
		const input = deposit.inputs[vin];
		const supplied = orderedProofs[vin];
		requireProof(supplied?.vin === vin && Array.isArray(supplied.ancestorTransactions), 'Input proofs must use each vin exactly once in ascending order.');
		const parent = rawTransaction(supplied.parentTransaction, transactions, totals);
		const parentId = input.prevTxId.toString('hex');
		requireProof(parent.hash === parentId, `Parent transaction does not match vin ${vin}.`);
		const key = `${parentId}:${input.outputIndex}`;
		requireProof(!seen.has(key), 'Deposit contains a duplicate source input.'); seen.add(key);
		const output = parent.outputs[input.outputIndex];
		requireProof(output && Number.isSafeInteger(output.satoshis) && output.satoshis >= 0, `Missing source output for vin ${vin}.`);
		input.output = output; nativeIn += BigInt(output.satoshis);
		if (vin === deposit.inputs.length - 1) {
			requireProof(supplied.ancestorTransactions.length === 0 && output.script.isPublicKeyHashOut(), 'Final input must be one ordinary native fee input.');
			nativeInputScript = output.script.toHex();
			continue;
		}
		requireProof(output.satoshis === BRIDGE_FT_CODE_SATOSHIS, 'Legacy FT Code input must carry exactly 500 satoshis.');
		const controller = output.script.chunks[output.script.chunks.length - 2]?.buf;
		requireProof(controller?.length === 21 && controller[20] === 0, 'Initial Bridge deposits only accept address-controlled legacy FT inputs.');
		const expectedInputCode = tbc.Script.fromHex(genesisCode);
		expectedInputCode.chunks[expectedInputCode.chunks.length - 2].buf = Buffer.from(controller);
		requireProof(output.script.toHex() === tbc.Script.fromASM(expectedInputCode.toASM()).toHex(), 'Legacy FT input Code identity differs from the pinned genesis.');
		if (!inputControllerCode) inputControllerCode = output.script.toHex();
		requireProof(output.script.toHex() === inputControllerCode, 'All legacy FT inputs must use the same owner and token identity.');
		const parentTape = parent.outputs[input.outputIndex + 1];
		const balance = tapeAmount(parentTape, genesisTape);
		requireProof(balance > 0n, 'Legacy FT input carries no balance.'); balances.push(balance);
		const ancestors = supplied.ancestorTransactions.map((raw) => rawTransaction(raw, transactions, totals));
		const slots = parentTape.script.chunks[2].buf!;
		const requiredAncestors = Array.from({ length: 6 }, (_, slot) => slots.readBigUInt64LE(slot * 8)).filter((amount) => amount !== 0n).length;
		requireProof(ancestors.length === requiredAncestors, 'Legacy FT ancestor count differs from the Tape allocation.');
		sdk.buildFtPrePreTxData(parent, input.outputIndex, ancestors);
	}

	const total = balances.reduce((sum, amount) => sum + amount, 0n);
	requireProof(total >= paid, 'Legacy FT inputs do not cover the Bridge deposit amount.');
	const { amountHex, changeHex } = sdk.FT.buildTapeAmount(paid, balances);
	requireProof(deposit.outputs[2].script.toHex() === sdk.FT.buildFTtransferTape(genesisTape, amountHex).toHex(), 'Legacy FT Tape slot allocation is invalid.');
	let next = 3;
	if (total > paid) {
		requireProof(deposit.outputs[3]?.satoshis === BRIDGE_FT_CODE_SATOSHIS && deposit.outputs[3].script.toHex() === inputControllerCode
			&& tapeAmount(deposit.outputs[4], genesisTape) === total - paid
			&& deposit.outputs[4].script.toHex() === sdk.FT.buildFTtransferTape(genesisTape, changeHex).toHex(), 'Legacy FT change does not return the exact remainder to the input owner.');
		next = 5;
	}
	requireProof(deposit.outputs.length === next || deposit.outputs.length === next + 1 && deposit.outputs[next].script.toHex() === nativeInputScript, 'Deposit contains an unsupported extra output.');
	const feeRaw = nativeIn - deposit.outputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n);
	requireProof(feeRaw > 0n, 'Deposit network fee must be positive.');
	for (let vin = 0; vin < deposit.inputs.length; vin++) requireProof(deposit.verifyScript(vin).success, `Deposit unlocking script failed at vin ${vin}.`);

	return {
		txid: deposit.hash,
		sourceVout: LEGACY_FT_DEPOSIT_VOUT,
		sourceContractId: genesis.hash,
		amountRaw: paid,
		intent,
		covenantScript,
		covenantController,
		depositId: logicalDepositId(intent, { sourceTxid: deposit.hash, sourceVout: LEGACY_FT_DEPOSIT_VOUT }),
		feeRaw,
		proofBytes: totals.bytes,
	};
}
