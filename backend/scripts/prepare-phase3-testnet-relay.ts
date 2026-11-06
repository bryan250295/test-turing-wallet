import { preparePhase3TestnetRelayPlan } from '../src/bridge/phase3/testnet-relay-plan';

function argument(name: string) {
	const prefix = `--${name}=`;
	return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
	const relay = argument('relay');
	const from = argument('from');
	if (!from) throw new Error('Usage: npm run phase3:testnet-relay-plan -- --from=0x…');
	const plan = await preparePhase3TestnetRelayPlan(from, argument('rpc'));
	if (relay && relay.toLowerCase() !== plan.relay.toLowerCase()) {
		throw new Error(`The requested relay differs from the recorded public deployment ${plan.relay}.`);
	}
	const output = process.argv.includes('--summary') ? {
		schema: plan.schema,
		parent: plan.parent,
		target: plan.target,
		crossCheckedSources: plan.crossCheckedSources,
		witnessCount: plan.witnessCount,
		estimatedGas: plan.estimatedGas,
		maximumFeeWei: plan.maximumFeeWei,
		balanceWei: plan.balanceWei,
		canCoverMaximumFee: plan.canCoverMaximumFee,
		broadcast: plan.broadcast,
	} : plan;
	console.log(JSON.stringify(output, null, 2));
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
