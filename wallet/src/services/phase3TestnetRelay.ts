import { getAddress } from 'viem';
import publicDeployment from '../../../shared/src/config/phase3-testnet-v2-public.json';
import type { Phase3TestnetRelayPlan } from '../types/learningBridge';
import { backendData } from './backendClient';

const HASH = /^0x[0-9a-f]{64}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const CALLDATA = /^0x959de493[0-9a-f]+$/i;

function relayPlan(value: unknown, expectedFrom: string): Phase3TestnetRelayPlan {
	if (!value || typeof value !== 'object') throw new Error('The relay planner returned an invalid response.');
	const plan = value as Phase3TestnetRelayPlan;
	const relay = getAddress(publicDeployment.contracts.relay);
	const from = getAddress(expectedFrom);
	if (plan.schema !== 'learningmaterials/phase3-testnet-relay-plan/v1'
		|| plan.network?.tbc !== 'testnet' || plan.network.hyperEvmChainId !== 998
		|| getAddress(plan.relay) !== relay || getAddress(plan.from) !== from
		|| plan.transaction.chainId !== '0x3e6' || plan.transaction.value !== '0x0'
		|| getAddress(plan.transaction.to) !== relay || getAddress(plan.transaction.from) !== from
		|| !CALLDATA.test(plan.transaction.data)
		|| !QUANTITY.test(plan.transaction.gas) || !QUANTITY.test(plan.transaction.gasPrice)
		|| !QUANTITY.test(plan.transaction.nonce)
		|| !Number.isSafeInteger(plan.parent?.height) || plan.parent.height < publicDeployment.checkpoint.height
		|| !Number.isSafeInteger(plan.target?.height) || plan.target.height !== plan.parent.height + 1
		|| !HASH.test(plan.parent.hash) || !HASH.test(plan.target.hash)
		|| !HASH.test(plan.simulationResult) || plan.simulationResult.toLowerCase() !== plan.target.hash.toLowerCase()
		|| plan.crossCheckedSources?.[0] !== 'official-tbc-api'
		|| plan.crossCheckedSources?.[1] !== 'tbcscan-api'
		|| plan.crossCheckedSources.length !== 2
		|| plan.broadcast !== false
		|| !/^\d+$/.test(plan.estimatedGas) || !/^\d+$/.test(plan.maximumFeeWei)
		|| !/^\d+$/.test(plan.balanceWei) || !Number.isSafeInteger(plan.witnessCount)
		|| plan.witnessCount < 0) {
		throw new Error('The relay plan is not bound to the pinned Testnet-v2 route.');
	}
	const maximum = BigInt(plan.transaction.gas) * BigInt(plan.transaction.gasPrice);
	if (maximum.toString() !== plan.maximumFeeWei
		|| plan.canCoverMaximumFee !== (BigInt(plan.balanceWei) >= maximum)) {
		throw new Error('The relay plan fee calculation is inconsistent.');
	}
	const created = Date.parse(plan.createdAt);
	if (!Number.isFinite(created) || created > Date.now() + 60_000 || created < Date.now() - 5 * 60_000) {
		throw new Error('The relay plan expired. Prepare a new plan.');
	}
	return plan;
}

export async function preparePhase3TestnetRelay(from: string, signal?: AbortSignal) {
	const value: unknown = await backendData(
		'/api/bridge/phase3/testnet-relay/plan',
		{ from },
		true,
		signal ?? AbortSignal.timeout(30_000),
	);
	return relayPlan(value, from);
}
