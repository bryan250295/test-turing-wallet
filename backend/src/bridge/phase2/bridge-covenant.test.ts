import assert from 'node:assert/strict';
import test from 'node:test';
import tbc from 'tbc-lib-js';
import {
	BRIDGE_COVENANT_PAYLOAD_BYTES, TBC_V2_DEPOSIT_DOMAIN_HASH, TBC_V2_SOURCE_DOMAIN_HASH,
	bridgeCovenantFtController, buildBridgeCovenantScript, decodeBridgeCovenantPayload,
	encodeBridgeCovenantPayload, logicalDepositId, parseBridgeCovenantScript, type BridgeCovenantIntent,
} from './bridge-covenant';

const intent: BridgeCovenantIntent = Object.freeze({
	sourceContractId: 'ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c',
	destinationChainId: 998n,
	destinationGateway: '0x1111111111111111111111111111111111111111',
	recipient: '0x8221fae04189f1f2f50268495ed95d1a9b220432',
	amountRaw: 10_000_000n,
	depositNonce: 7n,
	reserveControllerPubKeyHash: '2222222222222222222222222222222222222222',
});

test('freezes the Phase 2 domains and fixed-width Covenant payload', () => {
	assert.equal(TBC_V2_SOURCE_DOMAIN_HASH, '0x170fd6ecf53e485cfe0df6a4e3977ae78d3e1fca9ceb05a79c2bca1c79e45c8b');
	assert.equal(TBC_V2_DEPOSIT_DOMAIN_HASH, '0x17a434e20a40ff4ee406974b50f279ce6f08bc91db025396d92f2871bdaaee46');
	const payload = encodeBridgeCovenantPayload(intent);
	assert.equal(payload.length, BRIDGE_COVENANT_PAYLOAD_BYTES);
	assert.deepEqual(decodeBridgeCovenantPayload(payload), intent);
});

test('builds and parses the canonical contract-controlled legacy FT Covenant', () => {
	const script = buildBridgeCovenantScript(intent);
	assert.deepEqual(parseBridgeCovenantScript(script), intent);
	assert.equal(bridgeCovenantFtController(script), '93ab9dc049f3194db77180742016003505ffbdf8');
	assert.equal(script.chunks[0].buf?.length, BRIDGE_COVENANT_PAYLOAD_BYTES);
	assert.equal(script.chunks[0].opcodenum, tbc.Opcode.OP_PUSHDATA2);
});

test('freezes the Solidity-compatible logical deposit identifier', () => {
	assert.equal(logicalDepositId(intent, {
		sourceTxid: '3bae1fe926e1ac620ad5c0697c6352af7f0b7d26a459122cbb1a8376e1032b1d',
		sourceVout: 1,
	}), '0x994f3874ca78fb6a00712a3a0c6004d1c2bc4685d7db7399ce7bed3a20ddc524');
});

test('rejects payload, controller, script-shape and uint mutations', () => {
	const payload = encodeBridgeCovenantPayload(intent);
	const wrongDomain = Buffer.from(payload); wrongDomain[20] ^= 1;
	assert.throws(() => decodeBridgeCovenantPayload(wrongDomain), /source domain/);
	const script = buildBridgeCovenantScript(intent);
	const wrongController = new tbc.Script().add(script.chunks[0].buf!).add(tbc.Opcode.OP_DROP).add(tbc.Opcode.OP_DUP)
		.add(tbc.Opcode.OP_HASH160).add(Buffer.alloc(20, 3)).add(tbc.Opcode.OP_EQUALVERIFY).add(tbc.Opcode.OP_CHECKSIG);
	assert.throws(() => parseBridgeCovenantScript(wrongController), /controller differs/);
	assert.throws(() => parseBridgeCovenantScript(new tbc.Script().add(payload).add(tbc.Opcode.OP_DROP)), /unsupported shape/);
	assert.throws(() => encodeBridgeCovenantPayload({ ...intent, amountRaw: 0n }), /positive/);
	assert.throws(() => logicalDepositId(intent, { sourceTxid: '00', sourceVout: 1 }), /32 bytes/);
});
