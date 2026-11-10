import { randomBytes, randomUUID } from 'node:crypto';
import sdk from 'tbc-contract';
import tbc from 'tbc-lib-js';
import { getApiData } from '../../../../shared/src/services/apiClient';
import { getNativeUtxos, getTokenInfo, getTokenUtxos } from '../../../../shared/src/services/tbcApi';
import { API_URLS } from '../../../../shared/src/config/constants';
import type {
	Phase3TestnetDepositBroadcast, Phase3TestnetDepositTerms, SignedPhase3TestnetDeposit,
	UnsignedPhase3TestnetDeposit,
} from '../../../../shared/src/types/phase3TestnetDeposit';
import { tokenAmountToRaw } from '../../../../shared/src/utils/tokenAmounts';
import { buildBridgeCovenantScript, bridgeCovenantFtController } from '../phase2/bridge-covenant';
import {
	LEGACY_FT_DEPOSIT_PROOF_SCHEMA, verifyLegacyFtDepositProof, type LegacyFtDepositProofV1,
} from '../phase2/legacy-ft-proof';
import { PINNED_MT_V3_GENESIS_RAW } from '../phase2/pinned-mt-v3.vector';
import { sizingSignatures } from '../../htlc/engine/recoveryFee';

const SOURCE_CONTRACT_ID = 'ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c';
const FEE_RATE_SAT_PER_KB = 80;
const SIGNING_TTL_MS = 15 * 60_000;
const MAX_CONTEXTS = 20;

type Input = UnsignedPhase3TestnetDeposit['inputs'][number];
interface BuildContext {
	owner: string;
	policy: Phase3TestnetRoutePolicy;
	transaction: UnsignedPhase3TestnetDeposit;
	parentsRaw: string[];
	ancestorGroupsRaw: string[][];
	expires: number;
	signed?: SignedPhase3TestnetDeposit;
	broadcast?: Phase3TestnetDepositBroadcast;
	broadcasting?: boolean;
	evidence?: Phase3SignedEvidence;
}
export interface Phase3TestnetRoutePolicy {
	destinationGateway: `0x${string}`;
	reserveController: `0x${string}`;
}
export interface Phase3SignedEvidence {
	buildId: string; sender: string; recipient: string; amountRaw: string; depositId: string;
	sourceTxid: string; sourceRaw: string; parentTransactions: string[]; ancestorTransactions: string[][];
	signatureWitnesses: Array<{ signaturePushOffset: number; publicKeyX: string; publicKeyY: string }>;
	signaturePushOffsets: number[];
}
const contexts = new Map<string, BuildContext>();

function requireValue(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function p2pkhOwner(publicKeyHex: string, address: string) {
	requireValue(tbc.PublicKey.isValid(publicKeyHex), 'Turing Wallet returned an invalid TBC public key.');
	const key = new tbc.PublicKey(publicKeyHex);
	requireValue(tbc.crypto.Hash.sha256ripemd160(key.toBuffer()).equals(tbc.Address.fromString(address).hashBuffer), 'The Turing Wallet public key does not belong to the signed-in TBC account.');
	return key;
}
async function rawTransaction(txid: string, signal: AbortSignal, cache: Map<string, tbc.Transaction>) {
	const cached = cache.get(txid); if (cached) return cached;
	const data = await getApiData(API_URLS.rawTransaction(txid), { signal });
	requireValue(typeof data.txraw === 'string' && /^(?:[0-9a-f]{2})+$/i.test(data.txraw), 'TBC Testnet did not return canonical raw transaction bytes.');
	const tx = new tbc.Transaction(data.txraw.toLowerCase());
	requireValue(tx.hash === txid.toLowerCase() && tx.toObject().version === 10, 'Downloaded TBC transaction identity or version differs from the requested transaction.');
	cache.set(txid, tx); return tx;
}
function amountOf(value: { value?: string | number; satoshis?: string | number }) {
	const amount = value.value ?? value.satoshis;
	requireValue(amount !== undefined && /^\d+$/.test(String(amount)) && Number.isSafeInteger(Number(amount)), 'TBC Testnet returned an invalid native UTXO amount.');
	return BigInt(amount);
}
function cloneWithOutputs(inputs: tbc.Transaction.IUnspentOutput[], outputs: Array<{ script: tbc.Script; satoshis: number }>) {
	const tx = new tbc.Transaction().from(inputs);
	for (const output of outputs) tx.addOutput(new tbc.Transaction.Output(output));
	return tx;
}
function attachInputOutputs(tx: tbc.Transaction, inputs: Input[]) {
	for (let index = 0; index < inputs.length; index++) {
		tx.inputs[index].output = new tbc.Transaction.Output({ script: new tbc.Script(inputs[index].scriptHex), satoshis: Number(inputs[index].nativeAmountRaw) });
	}
}

export async function buildUnsignedPhase3TestnetDeposit(owner: string, terms: Phase3TestnetDepositTerms, policy: Phase3TestnetRoutePolicy, signal: AbortSignal) {
	requireValue(terms.sender === owner, 'The deposit sender differs from the signed-in TBC account.');
	requireValue(terms.contractId.toLowerCase() === SOURCE_CONTRACT_ID, 'This Testnet-v3 gateway is pinned to the MT v3 source Contract ID.');
	requireValue(/^0x[0-9a-f]{40}$/i.test(policy.destinationGateway) && /^0x[0-9a-f]{40}$/i.test(policy.reserveController), 'The verified V3 route policy is invalid.');
	requireValue(/^0x[0-9a-f]{40}$/i.test(terms.recipient) && !/^0x0{40}$/i.test(terms.recipient), 'Enter a nonzero HyperEVM recipient.');
	p2pkhOwner(terms.publicKey, owner);
	const cache = new Map<string, tbc.Transaction>();
	const genesis = new tbc.Transaction(PINNED_MT_V3_GENESIS_RAW);
	requireValue(genesis.hash === SOURCE_CONTRACT_ID, 'Pinned MT v3 genesis identity mismatch.');
	cache.set(genesis.hash, genesis);
	const info = await getTokenInfo(SOURCE_CONTRACT_ID, { signal });
	const decimals = Number(info.decimal);
	const amountRaw = tokenAmountToRaw(terms.amount, decimals);
	const [tokenOutputs, nativeOutputs] = await Promise.all([
		getTokenUtxos(owner, SOURCE_CONTRACT_ID, { signal }), getNativeUtxos(owner, { signal }),
	]);
	const expectedOwnerCode = sdk.FT.buildFTtransferCode(genesis.outputs[0].script.toHex(), owner).toHex();
	const candidates = tokenOutputs.map((output) => ({ ...output, balance: BigInt(String(output.ft_value ?? 0)) }))
		.filter((output) => output.balance > 0n)
		.sort((a, b) => a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0);
	const selected: typeof candidates = []; let selectedRaw = 0n;
	for (const candidate of candidates.slice(0, 5)) { selected.push(candidate); selectedRaw += candidate.balance; if (selectedRaw >= amountRaw) break; }
	requireValue(selectedRaw >= amountRaw, 'The MT amount cannot be covered by five source outputs. Consolidate MT or choose a smaller amount.');
	const parents: tbc.Transaction[] = []; const ancestorGroups: tbc.Transaction[][] = [];
	const tokenInputs: tbc.Transaction.IUnspentOutput[] = [];
	for (const selectedOutput of selected) {
		const parent = await rawTransaction(selectedOutput.txid, signal, cache);
		const code = parent.outputs[selectedOutput.index]; const tape = parent.outputs[selectedOutput.index + 1];
		requireValue(code?.script.toHex() === expectedOwnerCode && code.satoshis === 500 && tape?.satoshis === 0, 'A selected MT output is not controlled by this Turing Wallet account.');
		const balance = sdk.getFtBalanceFromTape(tape.script.toHex());
		requireValue(balance === selectedOutput.balance, 'The MT indexer amount differs from the canonical Tape output.');
		const slots = tape.script.chunks[2]?.buf; requireValue(slots?.length === 48, 'Invalid MT Tape allocation.');
		const ancestors: tbc.Transaction[] = [];
		for (let slot = 0; slot < 6; slot++) {
			if (slots.readBigUInt64LE(slot * 8) === 0n) continue;
			const previous = parent.inputs[slot]; requireValue(previous, 'MT ancestor input is missing.');
			const ancestor = await rawTransaction(previous.prevTxId.toString('hex'), signal, cache);
			requireValue(ancestor.outputs[previous.outputIndex], 'MT ancestor output is missing.'); ancestors.push(ancestor);
		}
		parents.push(parent); ancestorGroups.push(ancestors);
		tokenInputs.push({ txId: parent.hash, outputIndex: selectedOutput.index, script: code.script.toHex(), satoshis: code.satoshis, ftBalance: balance });
	}
	const selectedOutpoints = new Set(selected.map((item) => `${item.txid}:${item.index}`));
	const fundingCandidates = nativeOutputs.filter((output) => !selectedOutpoints.has(`${output.txid}:${output.index}`));
	fundingCandidates.sort((a, b) => amountOf(a) > amountOf(b) ? -1 : amountOf(a) < amountOf(b) ? 1 : 0);
	const funding = fundingCandidates[0]; requireValue(funding, 'No native test TBC output is available for the source transaction fee.');
	const fundingParent = await rawTransaction(funding.txid, signal, cache); const fundingOutput = fundingParent.outputs[funding.index];
	const ownerScript = tbc.Script.buildPublicKeyHashOut(owner).toHex();
	requireValue(fundingOutput?.script.toHex() === ownerScript && BigInt(fundingOutput.satoshis) === amountOf(funding), 'The native fee output differs from the signed-in account or indexer amount.');
	const feeInput: tbc.Transaction.IUnspentOutput = { txId: funding.txid, outputIndex: funding.index, script: ownerScript, satoshis: fundingOutput.satoshis };
	parents.push(fundingParent); ancestorGroups.push([]);

	const depositNonce = BigInt(`0x${randomBytes(32).toString('hex')}`);
	const intent = {
		sourceContractId: SOURCE_CONTRACT_ID, destinationChainId: 998n,
		destinationGateway: policy.destinationGateway, recipient: terms.recipient,
		amountRaw, depositNonce, reserveControllerPubKeyHash: policy.reserveController.replace(/^0x/, ''),
	};
	const covenant = buildBridgeCovenantScript(intent);
	const { amountHex, changeHex } = sdk.FT.buildTapeAmount(amountRaw, tokenInputs.map((input) => input.ftBalance!));
	const tokenChange = selectedRaw - amountRaw;
	const protocolOutputs = [
		{ script: covenant, satoshis: 100 },
		{ script: sdk.FT.buildFTtransferCode(genesis.outputs[0].script.toHex(), bridgeCovenantFtController(covenant)), satoshis: 500 },
		{ script: sdk.FT.buildFTtransferTape(genesis.outputs[1].script.toHex(), amountHex), satoshis: 0 },
	];
	if (tokenChange > 0n) protocolOutputs.push(
		{ script: new tbc.Script(expectedOwnerCode), satoshis: 500 },
		{ script: sdk.FT.buildFTtransferTape(genesis.outputs[1].script.toHex(), changeHex), satoshis: 0 },
	);
	const inputs = [...tokenInputs, feeInput];
	const nativeIn = inputs.reduce((sum, input) => sum + BigInt(input.satoshis), 0n);
	const protocolNative = protocolOutputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n);
	function assemble(fee: bigint) {
		const change = nativeIn - protocolNative - fee;
		requireValue(change >= 500n && change <= BigInt(Number.MAX_SAFE_INTEGER), 'The native Testnet TBC input is insufficient for a safe fee and change output.');
		return cloneWithOutputs(inputs, [...protocolOutputs, { script: new tbc.Script(ownerScript), satoshis: Number(change) }]);
	}
	const sizing = assemble(80n);
	const publicKey = terms.publicKey.toLowerCase().replace(/^0x/, '');
	for (let index = 0; index < tokenInputs.length; index++) {
		const proof = sdk.buildFtPrePreTxData(parents[index], tokenInputs[index].outputIndex, ancestorGroups[index]);
		sizing.inputs[index].setScript(sdk.FT.getFTunlock(sizingSignatures[0], publicKey, sizing, parents[index], proof, index, tokenInputs[index].outputIndex, false));
	}
	sizing.inputs[tokenInputs.length].setScript(tbc.Script.fromASM(`${sizingSignatures[0]} ${publicKey}`));
	const estimatedBytes = sizing.toBuffer().length + 128;
	const feeRaw = BigInt(Math.max(80, Math.ceil(estimatedBytes * FEE_RATE_SAT_PER_KB / 1000 * 1.2)));
	const unsigned = assemble(feeRaw);
	requireValue(unsigned.toObject().version === 10 && unsigned.inputs.length >= 2 && unsigned.inputs.length <= 6 && unsigned.outputs.length >= 4 && unsigned.outputs.length <= 6, 'Constructed deposit is outside the bounded V3 shape.');
	const rawHex = unsigned.uncheckedSerialize();
	const buildId = randomUUID(); const expires = Date.now() + SIGNING_TTL_MS;
	const transaction: UnsignedPhase3TestnetDeposit = {
		buildId, signingExpiresAt: new Date(expires).toISOString(), network: 'testnet', terms: { ...terms, publicKey },
		tokenName: info.name || 'MT', symbol: info.symbol || 'MT', decimals, amountRaw: amountRaw.toString(),
		depositNonce: depositNonce.toString(), destinationChainId: '998', destinationGateway: policy.destinationGateway,
		reserveController: policy.reserveController, rawHex, unsignedBytes: rawHex.length / 2,
		feeRaw: feeRaw.toString(), nativeChangeRaw: unsigned.outputs.at(-1)!.satoshis.toString(), tokenChangeRaw: tokenChange.toString(),
		inputs: inputs.map((input, index) => ({ txid: input.txId, index: input.outputIndex, scriptHex: input.script, nativeAmountRaw: String(input.satoshis), kind: index < tokenInputs.length ? 'token' : 'fee' })),
		outputs: unsigned.outputs.map((output, index) => ({ index, purpose: index === 0 ? 'Bridge Covenant' : index === 1 ? 'Covenant-controlled MT Code' : index === 2 ? 'Deposited MT Tape' : tokenChange > 0n && index === 3 ? 'MT change Code → sender' : tokenChange > 0n && index === 4 ? 'MT change Tape → sender' : 'Native TBC change → sender', nativeAmountRaw: String(output.satoshis), scriptHex: output.script.toHex(), ...(index === 2 ? { tokenAmountRaw: amountRaw.toString() } : tokenChange > 0n && index === 4 ? { tokenAmountRaw: tokenChange.toString() } : {}) })),
		builtAt: new Date().toISOString(),
	};
	for (const [id, value] of contexts) if (value.expires <= Date.now()) contexts.delete(id);
	while (contexts.size >= MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
	contexts.set(buildId, { owner, policy, transaction, parentsRaw: parents.map((tx) => tx.uncheckedSerialize()), ancestorGroupsRaw: ancestorGroups.map((group) => group.map((tx) => tx.uncheckedSerialize())), expires });
	return transaction;
}

function contextFor(owner: string, buildId: string, allowExpiredReceipt = false) {
	const context = contexts.get(buildId);
	requireValue(context && context.owner === owner, 'The V3 deposit signing session does not exist for this TBC account.');
	if (!allowExpiredReceipt) requireValue(context.expires > Date.now(), 'The V3 deposit signing session expired. Build and review a new transaction.');
	return context;
}
async function assertInputsUnspent(context: BuildContext, signal: AbortSignal) {
	const { terms } = context.transaction;
	const [tokens, native] = await Promise.all([getTokenUtxos(terms.sender, terms.contractId, { signal }), getNativeUtxos(terms.sender, { signal })]);
	for (const input of context.transaction.inputs) requireValue((input.kind === 'token' ? tokens : native).some((row) => row.txid === input.txid && row.index === input.index), 'A reviewed source input is no longer unspent. Build a new deposit.');
}
export async function phase3DepositSigningRequest(owner: string, buildId: string, signal: AbortSignal) {
	const context = contextFor(owner, buildId); await assertInputsUnspent(context, signal);
	return { txraws: [context.transaction.rawHex], utxos_satoshis: [context.transaction.inputs.map((input) => Number(input.nativeAmountRaw))], script_pubkeys: [context.transaction.inputs.map((input) => input.scriptHex)] };
}
export async function finalizePhase3Deposit(owner: string, buildId: string, publicKeyHex: string, signatures: string[], signal: AbortSignal) {
	const context = contextFor(owner, buildId); const { transaction } = context;
	requireValue(!context.signed && !context.broadcast, 'This V3 deposit signing session has already been finalized.');
	const publicKey = p2pkhOwner(publicKeyHex, owner); requireValue(publicKeyHex.toLowerCase().replace(/^0x/, '') === transaction.terms.publicKey, 'The signing public key differs from the reviewed key.');
	requireValue(signatures.length === transaction.inputs.length, 'Turing Wallet did not sign every V3 deposit input.');
	const unsigned = new tbc.Transaction(transaction.rawHex); attachInputOutputs(unsigned, transaction.inputs);
	for (let index = 0; index < signatures.length; index++) {
		const hex = signatures[index]; requireValue(/^(?:[0-9a-f]{2}){9,80}$/i.test(hex), `Invalid wallet signature ${index}.`);
		const signature = tbc.crypto.Signature.fromTxFormat(Buffer.from(hex, 'hex'));
		requireValue(signature.nhashtype === 0x41, 'Only ALL|FORKID wallet signatures are accepted.');
		requireValue(unsigned.verifySignature(signature, publicKey, index, new tbc.Script(transaction.inputs[index].scriptHex), new tbc.crypto.BN(transaction.inputs[index].nativeAmountRaw), tbc.Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID), `Wallet signature verification failed for input ${index}.`);
	}
	const signed = new tbc.Transaction(transaction.rawHex); attachInputOutputs(signed, transaction.inputs);
	const tokenCount = transaction.inputs.length - 1;
	for (let index = 0; index < tokenCount; index++) {
		const parent = new tbc.Transaction(context.parentsRaw[index]);
		const ancestors = context.ancestorGroupsRaw[index].map((raw) => new tbc.Transaction(raw));
		const proof = sdk.buildFtPrePreTxData(parent, transaction.inputs[index].index, ancestors);
		signed.inputs[index].setScript(sdk.FT.getFTunlock(signatures[index], transaction.terms.publicKey, signed, parent, proof, index, transaction.inputs[index].index, false));
	}
	signed.inputs[tokenCount].setScript(tbc.Script.fromASM(`${signatures[tokenCount]} ${transaction.terms.publicKey}`));
	for (let index = 0; index < signed.inputs.length; index++) requireValue(signed.verifyScript(index).success, `Local TBC script verification failed for input ${index}.`);
	const rawHex = signed.uncheckedSerialize();
	const proof: LegacyFtDepositProofV1 = {
		schemaVersion: LEGACY_FT_DEPOSIT_PROOF_SCHEMA, network: 'testnet', depositTransaction: rawHex,
		genesisTransaction: PINNED_MT_V3_GENESIS_RAW,
		inputProofs: context.parentsRaw.map((parentTransaction, vin) => ({ vin, parentTransaction, ancestorTransactions: context.ancestorGroupsRaw[vin] })),
	};
	const verified = verifyLegacyFtDepositProof(proof, { expectedSourceContractId: SOURCE_CONTRACT_ID, expectedLegacyVersion: 3, expectedDestinationChainId: 998n, expectedDestinationGateway: context.policy.destinationGateway, expectedReserveControllerPubKeyHash: context.policy.reserveController.replace(/^0x/, '') });
	requireValue(verified.txid === signed.hash && verified.amountRaw.toString() === transaction.amountRaw && verified.intent.recipient.toLowerCase() === transaction.terms.recipient.toLowerCase(), 'Final V3 proof differs from the reviewed deposit.');
	await assertInputsUnspent(context, signal);
	const minimumFee = Math.max(80, Math.ceil(rawHex.length / 2 * FEE_RATE_SAT_PER_KB / 1000));
	const result: SignedPhase3TestnetDeposit = { txid: signed.hash, rawHex, signedBytes: rawHex.length / 2, feeRaw: transaction.feeRaw, minimumFeeRaw: String(minimumFee), feeSufficient: BigInt(transaction.feeRaw) >= BigInt(minimumFee), signaturesVerified: true, proofVerified: true, depositId: verified.depositId, signedAt: new Date().toISOString() };
	requireValue(result.feeSufficient, 'The signed V3 deposit is larger than the reviewed fee budget. Nothing was broadcast.');
	const point = publicKey.toObject() as { x: string; y: string };
	const compressedPublicKey = publicKey.toBuffer();
	const signatureWitnesses = signed.inputs.map((input, vin) => {
		const signature = Buffer.from(signatures[vin]!, 'hex');
		const needle = Buffer.concat([Buffer.from([signature.length]), signature, Buffer.from([compressedPublicKey.length]), compressedPublicKey]);
		const signaturePushOffset = input.script.toBuffer().indexOf(needle);
		requireValue(signaturePushOffset >= 0, `Signed V3 input ${vin} does not contain the reviewed signature/public-key pair.`);
		return { signaturePushOffset, publicKeyX: `0x${point.x.padStart(64, '0')}`, publicKeyY: `0x${point.y.padStart(64, '0')}` };
	});
	context.evidence = { buildId, sender: owner, recipient: transaction.terms.recipient, amountRaw: transaction.amountRaw, depositId: verified.depositId, sourceTxid: signed.hash, sourceRaw: rawHex, parentTransactions: context.parentsRaw, ancestorTransactions: context.ancestorGroupsRaw, signatureWitnesses, signaturePushOffsets: signatureWitnesses.map((item) => item.signaturePushOffset) };
	context.signed = result; return result;
}

export function phase3DepositEvidence(owner: string, buildId: string) {
	const context = contextFor(owner, buildId);
	requireValue(context.evidence, 'The V3 deposit evidence has not been finalized.');
	return context.evidence;
}

export async function broadcastPhase3Deposit(owner: string, buildId: string, checkOnly: boolean, signal: AbortSignal) {
	const context = contextFor(owner, buildId, checkOnly); if (context.broadcast) return context.broadcast;
	requireValue(!checkOnly, 'There is no submission receipt for this V3 deposit.');
	const signed = context.signed; requireValue(signed?.proofVerified && signed.feeSufficient, 'Finalize and locally verify this exact V3 deposit before submitting it.');
	requireValue(!context.broadcasting, 'This V3 deposit submission is already in progress.');
	context.broadcasting = true;
	try {
		await assertInputsUnspent(context, signal);
		context.broadcast = { txid: signed.txid, status: 'unknown', message: 'Submission started. Check this TXID before building another deposit if acknowledgement is interrupted.', updatedAt: new Date().toISOString(), scriptChecksVerified: true };
		try {
			const response = await fetch(API_URLS.testnetBroadcast, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ txraw: signed.rawHex }), signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
			const body = await response.json();
			if (response.ok && String(body.code) === '200' && body.data?.txid === signed.txid) context.broadcast = { ...context.broadcast, status: 'submitted', message: 'TBC Testnet accepted the proof-backed V3 deposit. The backend will wait for six confirmations, relay headers and mint automatically.', updatedAt: new Date().toISOString() };
			else if (String(body.code) === '400' || body.error || !response.ok && response.status < 500) context.broadcast = { ...context.broadcast, status: 'rejected', message: String(body.data?.error ?? body.message ?? body.msg ?? 'TBC Testnet rejected the transaction.').slice(0, 600), updatedAt: new Date().toISOString() };
		} catch { /* Unknown is intentional: POST must never be retried automatically. */ }
		return context.broadcast;
	} finally { context.broadcasting = false; }
}
