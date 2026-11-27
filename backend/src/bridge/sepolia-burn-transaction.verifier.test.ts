import assert from 'node:assert/strict';
import test from 'node:test';
import { concatHex, encodeFunctionData, parseAbi, zeroHash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
	matchesFrozenBurnEnvelope,
	METAMASK_DELEGATION_MANAGER,
	METAMASK_STATELESS_DELEGATOR,
	type FrozenBurnCall,
} from './sepolia-burn-transaction.verifier';

const delegationAbi = parseAbi([
	'function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)',
]);
const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
const other = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002');
const call: FrozenBurnCall = {
	chainId: 11_155_111,
	fromAddress: account.address,
	toAddress: '0x1111111111111111111111111111111111111111',
	data: '0x12345678',
	nonce: 6n,
};

test('accepts the exact direct burn envelope', async () => {
	assert.equal(await matchesFrozenBurnEnvelope({
		chainId: call.chainId, from: account.address, to: call.toAddress, input: call.data,
		value: 0n, nonce: 6, type: 'eip1559',
	}, call), true);
});

async function delegatedEnvelope(signer = account, executions: Hex[] = [concatHex([call.toAddress as Hex, zeroHash, call.data as Hex])]) {
	const authorization = await signer.signAuthorization({ address: METAMASK_STATELESS_DELEGATOR, chainId: call.chainId, nonce: 7 });
	return {
		chainId: call.chainId, from: account.address, to: METAMASK_DELEGATION_MANAGER,
		input: encodeFunctionData({ abi: delegationAbi, functionName: 'redeemDelegations', args: [['0x01'], executions.map(() => zeroHash), executions] }),
		value: 0n, nonce: 6, type: 'eip7702', authorizationList: [authorization],
	};
}

test('accepts one exact MetaMask EIP-7702 delegated burn', async () => {
	assert.equal(await matchesFrozenBurnEnvelope(await delegatedEnvelope(), call), true);
});

test('rejects a delegation signed by a different account', async () => {
	assert.equal(await matchesFrozenBurnEnvelope(await delegatedEnvelope(other), call), false);
});

test('rejects a delegated batch containing any additional execution', async () => {
	const expected = concatHex([call.toAddress as Hex, zeroHash, call.data as Hex]);
	const extra = concatHex(['0x2222222222222222222222222222222222222222', zeroHash, '0xabcdef00']);
	assert.equal(await matchesFrozenBurnEnvelope(await delegatedEnvelope(account, [expected, extra]), call), false);
});
