import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateV3GasBudget } from './proof-bridge-v3-gas-budget';

test('budgets setup, catch-up headers and mint with conservative buffers', () => {
	const result = calculateV3GasBudget({
		routeDeployed: false, checkpointHeight: 840761, relayHeight: 840761,
		tbcTipHeight: 840786, gasPriceWei: 100_000_000n, balanceWei: 0n,
	});
	assert.equal(result.estimatedTargetHeight, 840795);
	assert.equal(result.estimatedHeaderCount, 34);
	assert.equal(result.setupGas, 3_998_666n);
	assert.equal(result.sufficient, false);
	assert.equal(result.shortfallWei, result.requiredWei);
});

test('omits setup after deployment and reports sufficient balance', () => {
	const result = calculateV3GasBudget({
		routeDeployed: true, checkpointHeight: 840761, relayHeight: 840786,
		tbcTipHeight: 840786, gasPriceWei: 100_000_000n, balanceWei: 2_000_000_000_000_000n,
	});
	assert.equal(result.estimatedHeaderCount, 9);
	assert.equal(result.setupGas, 0n);
	assert.equal(result.sufficient, true);
	assert.equal(result.shortfallWei, 0n);
});
