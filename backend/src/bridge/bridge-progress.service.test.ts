import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeProgressService } from './bridge-progress.service';

test('identity subscribers receive only their own bridge progress changes', () => {
	const service = new BridgeProgressService({} as never);
	const received: string[] = [];
	const unsubscribe = service.subscribe('identity-a', (update) => received.push(`${update.orderId}:${update.reason}`));
	service.publish('identity-b', 'order-b', 'unrelated');
	service.publish('identity-a', 'order-a', 'sepolia-release');
	assert.deepEqual(received, ['order-a:sepolia-release']);
	unsubscribe();
	service.publish('identity-a', 'order-a', 'completed');
	assert.deepEqual(received, ['order-a:sepolia-release']);
});
