import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { keccak256, type Hex } from 'viem';
import { PHASE3_TESTNET_V3 } from '../../../../shared/src/config/phase3TestnetV3';

test('Testnet-v3 backend pins the exact generated deployment build', async () => {
	const deployment = JSON.parse(await readFile(
		resolve(process.cwd(), '../wallet/src/generated/phase3-testnet-v3-deployment.json'), 'utf8',
	)) as {
		chainId: number;
		checkpoint: { height: number; hash: string };
		bootstrap: { commitmentRoot: string };
		contracts: {
			relay: { runtimeCodeHash: string };
			gateway: { bytecode: Hex; creationCodeHash: string; expectedRelayRuntimeCodeHash: string };
		};
	};

	assert.equal(deployment.chainId, PHASE3_TESTNET_V3.chainId);
	assert.equal(deployment.checkpoint.height, PHASE3_TESTNET_V3.checkpoint.height);
	assert.equal(deployment.checkpoint.hash.toLowerCase(), PHASE3_TESTNET_V3.checkpoint.hash);
	assert.equal(deployment.bootstrap.commitmentRoot.toLowerCase(), PHASE3_TESTNET_V3.checkpoint.bootstrapRoot);
	assert.equal(deployment.contracts.relay.runtimeCodeHash.toLowerCase(), PHASE3_TESTNET_V3.relayRuntimeCodeHash);
	assert.equal(deployment.contracts.gateway.expectedRelayRuntimeCodeHash.toLowerCase(), PHASE3_TESTNET_V3.relayRuntimeCodeHash);
	assert.equal(keccak256(deployment.contracts.gateway.bytecode), PHASE3_TESTNET_V3.gatewayCreationCodeHash);
	assert.equal((deployment.contracts.gateway.bytecode.length - 2) / 2, PHASE3_TESTNET_V3.gatewayCreationCodeBytes);
});
