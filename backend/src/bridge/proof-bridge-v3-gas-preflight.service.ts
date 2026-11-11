import { Inject, Injectable } from '@nestjs/common';
import { createPublicClient, defineChain, getAddress, http } from 'viem';
import { DEVNET_API_BASE } from '../../../shared/src/config/constants';
import { LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';
import { PHASE3_TESTNET_V3 } from '../../../shared/src/config/phase3TestnetV3';
import type { ProofBridgeV3GasPreflight } from '../../../shared/src/types/proofBridgeV3';
import { ProofBridgeV3ProgressService } from './proof-bridge-v3-progress.service';
import { ProofBridgeV3Repository } from './proof-bridge-v3.repository';
import { calculateV3GasBudget, V3_GAS_BENCHMARK } from './phase3/proof-bridge-v3-gas-budget';
import { testnetV3RelayAbi } from './phase3/testnet-v3-relay';

const chain = defineChain({
	id: 998, name: 'HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
	rpcUrls: { default: { http: [LEARNING_BRIDGE_EVM.rpcUrl] } }, testnet: true,
});

function baseResponse(relayer: ReturnType<ProofBridgeV3ProgressService['info']>, routeDeployed: boolean, checkpointHeight: number): ProofBridgeV3GasPreflight {
	return {
		status: 'unavailable', sufficient: false, reason: null,
		relayerMode: relayer.mode, relayerAddress: relayer.address, balanceWei: null, gasPriceWei: null,
		routeDeployed, checkpointHeight, relayHeight: null, tbcTipHeight: null,
		estimatedTargetHeight: null, estimatedHeaderCount: null,
		setupGas: '0', headerGas: '0', mintGas: V3_GAS_BENCHMARK.mintUpperBound.toString(),
		rawGas: '0', bufferedGas: '0', requiredWei: null, shortfallWei: null,
		gasUsedBufferPercent: V3_GAS_BENCHMARK.gasUsedBufferPercent,
		gasPriceBufferPercent: V3_GAS_BENCHMARK.gasPriceBufferPercent,
		inclusionReserveBlocks: V3_GAS_BENCHMARK.inclusionReserveBlocks,
		checkedAt: new Date().toISOString(),
	};
}

@Injectable()
export class ProofBridgeV3GasPreflightService {
	private readonly client = createPublicClient({ chain, transport: http(LEARNING_BRIDGE_EVM.rpcUrl, { retryCount: 1, timeout: 20_000 }) });

	constructor(
		@Inject(ProofBridgeV3Repository) private readonly repository: ProofBridgeV3Repository,
		@Inject(ProofBridgeV3ProgressService) private readonly progress: ProofBridgeV3ProgressService,
	) {}

	async check(): Promise<ProofBridgeV3GasPreflight> {
		const relayer = this.progress.info();
		const route = await this.repository.route();
		const checkpointHeight = route?.checkpointHeight ?? PHASE3_TESTNET_V3.checkpoint.height;
		const result = baseResponse(relayer, Boolean(route), checkpointHeight);
		if (!route) {
			try {
				const [gasPriceWei, tbcTipHeight, balanceWei] = await Promise.all([
					this.client.getGasPrice(),
					fetch(`${DEVNET_API_BASE}/nodeinfo`, { signal: AbortSignal.timeout(20_000) }).then(async (response) => {
						if (!response.ok) throw new Error(`TBC nodeinfo returned HTTP ${response.status}.`);
						const body = await response.json() as { code?: string; data?: { blocks?: unknown } };
						if (body.code !== '200' || !Number.isSafeInteger(body.data?.blocks)) throw new Error('TBC nodeinfo returned an invalid height.');
						return Number(body.data!.blocks);
					}),
					relayer.address ? this.client.getBalance({ address: getAddress(relayer.address) }) : Promise.resolve(0n),
				]);
				return {
					...result, balanceWei: relayer.address ? balanceWei.toString() : null, gasPriceWei: gasPriceWei.toString(), tbcTipHeight,
					setupGas: (V3_GAS_BENCHMARK.relayDeployment + V3_GAS_BENCHMARK.gatewayDeployment).toString(),
					reason: 'The shared Testnet-v3 route must be deployed once by the operator before runtime gas can be estimated.',
				};
			} catch (cause) {
				return { ...result, reason: cause instanceof Error ? `Candidate freshness check unavailable: ${cause.message}` : 'Candidate freshness check unavailable.' };
			}
		}
		if (route?.status === 'paused') return { ...result, reason: 'The shared Testnet-v3 route is paused.' };

		try {
			const tipPromise = fetch(`${DEVNET_API_BASE}/nodeinfo`, { signal: AbortSignal.timeout(20_000) }).then(async (response) => {
				if (!response.ok) throw new Error(`TBC nodeinfo returned HTTP ${response.status}.`);
				const body = await response.json() as { code?: string; data?: { blocks?: unknown } };
				if (body.code !== '200' || !Number.isSafeInteger(body.data?.blocks) || Number(body.data?.blocks) < 1) throw new Error('TBC nodeinfo returned an invalid height.');
				return Number(body.data!.blocks);
			});
			const relayHeightPromise = (async () => {
				const bestTip = await this.client.readContract({ address: getAddress(route.relay), abi: testnetV3RelayAbi, functionName: 'bestTip' });
				const header = await this.client.readContract({ address: getAddress(route.relay), abi: testnetV3RelayAbi, functionName: 'header', args: [bestTip] });
				if (!header.exists) throw new Error('The shared Header Relay best tip does not exist.');
				return Number(header.height);
			})();
			const [gasPriceWei, tbcTipHeight, relayHeight, balanceWei] = await Promise.all([
				this.client.getGasPrice(), tipPromise, relayHeightPromise,
				relayer.address ? this.client.getBalance({ address: getAddress(relayer.address) }) : Promise.resolve(0n),
			]);
			const budget = calculateV3GasBudget({
				routeDeployed: true, checkpointHeight, relayHeight, tbcTipHeight, gasPriceWei, balanceWei,
			});
			const signerReady = relayer.mode === 'automatic' && Boolean(relayer.address);
			const sufficient = signerReady && budget.sufficient;
			const reason = !signerReady
				? 'The backend relayer is observe-only; operator signing is not enabled.'
				: !budget.sufficient ? 'The operator relayer does not have enough Testnet HYPE for this full flow.' : null;
			return {
				...result, status: sufficient ? 'ready' : signerReady ? 'insufficient' : 'unavailable', sufficient, reason,
				balanceWei: relayer.address ? balanceWei.toString() : null, gasPriceWei: gasPriceWei.toString(),
				relayHeight, tbcTipHeight, estimatedTargetHeight: budget.estimatedTargetHeight,
				estimatedHeaderCount: budget.estimatedHeaderCount, setupGas: budget.setupGas.toString(),
				headerGas: budget.headerGas.toString(), mintGas: budget.mintGas.toString(), rawGas: budget.rawGas.toString(),
				bufferedGas: budget.bufferedGas.toString(), requiredWei: budget.requiredWei.toString(),
				shortfallWei: budget.shortfallWei.toString(), checkedAt: new Date().toISOString(),
			};
		} catch (cause) {
			return { ...result, reason: cause instanceof Error ? `Gas preflight unavailable: ${cause.message}` : 'Gas preflight unavailable.' };
		}
	}
}
