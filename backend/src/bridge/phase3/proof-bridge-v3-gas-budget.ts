export const V3_GAS_BENCHMARK = Object.freeze({
	relayDeployment: 2_193_010n,
	gatewayDeployment: 1_805_656n,
	headerUpperBound: 1_123_234n,
	mintUpperBound: 2_067_577n,
	gasUsedBufferPercent: 20,
	gasPriceBufferPercent: 25,
	inclusionReserveBlocks: 3,
});

function ceilPercent(value: bigint, percent: number) {
	return (value * BigInt(percent) + 99n) / 100n;
}

export function calculateV3GasBudget(input: {
	routeDeployed: boolean;
	checkpointHeight: number;
	relayHeight: number;
	tbcTipHeight: number;
	gasPriceWei: bigint;
	balanceWei: bigint;
}) {
	const estimatedTargetHeight = input.tbcTipHeight + 6 + V3_GAS_BENCHMARK.inclusionReserveBlocks;
	const estimatedHeaderCount = Math.max(0, estimatedTargetHeight - input.relayHeight);
	const setupGas = input.routeDeployed ? 0n : V3_GAS_BENCHMARK.relayDeployment + V3_GAS_BENCHMARK.gatewayDeployment;
	const headerGas = BigInt(estimatedHeaderCount) * V3_GAS_BENCHMARK.headerUpperBound;
	const mintGas = V3_GAS_BENCHMARK.mintUpperBound;
	const rawGas = setupGas + headerGas + mintGas;
	const bufferedGas = ceilPercent(rawGas, 100 + V3_GAS_BENCHMARK.gasUsedBufferPercent);
	const currentPriceCost = bufferedGas * input.gasPriceWei;
	const requiredWei = ceilPercent(currentPriceCost, 100 + V3_GAS_BENCHMARK.gasPriceBufferPercent);
	return {
		estimatedTargetHeight, estimatedHeaderCount, setupGas, headerGas, mintGas, rawGas, bufferedGas, requiredWei,
		shortfallWei: requiredWei > input.balanceWei ? requiredWei - input.balanceWei : 0n,
		sufficient: input.balanceWei >= requiredWei,
	};
}
