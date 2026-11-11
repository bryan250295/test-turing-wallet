export type ProofBridgeV3Status =
	| 'signed' | 'source_submitted' | 'confirming_source' | 'relaying_headers'
	| 'ready_to_mint' | 'mint_submitted' | 'completed' | 'needs_review';

export interface ProofBridgeV3Route {
	version: 'testnet-v3';
	chainId: 998;
	sourceAddress: string;
	deployer: `0x${string}`;
	relay: `0x${string}`;
	gateway: `0x${string}`;
	wrappedToken: `0x${string}`;
	relayTxHash: `0x${string}`;
	gatewayTxHash: `0x${string}`;
	reserveController: `0x${string}`;
	checkpointHeight: number;
	checkpointHash: `0x${string}`;
	bootstrapRoot: `0x${string}`;
	status: 'verified' | 'paused';
	verifiedAt: string;
}

export interface ProofBridgeV3Transfer {
	id: string;
	status: ProofBridgeV3Status;
	sender: string;
	recipient: `0x${string}`;
	amountRaw: string;
	depositId: `0x${string}`;
	sourceTxid: string;
	blockHash: `0x${string}` | null;
	blockHeight: number | null;
	sourceConfirmations: number;
	relayHeight: number | null;
	mintTxHash: `0x${string}` | null;
	mintConfirmations: number;
	mintFeeWei: string | null;
	lastError: string | null;
	checkedAt: string | null;
	completedAt: string | null;
	createdAt: string;
}

export interface ProofBridgeV3Snapshot {
	type: 'proof-bridge-v3';
	route: ProofBridgeV3Route | null;
	transfers: ProofBridgeV3Transfer[];
	relayer: { mode: 'automatic' | 'observe-only'; address: `0x${string}` | null; balanceWei: string | null };
	checkedAt: string;
}

export interface ProofBridgeV3GasPreflight {
	status: 'ready' | 'insufficient' | 'unavailable';
	sufficient: boolean;
	reason: string | null;
	relayerMode: 'automatic' | 'observe-only';
	relayerAddress: `0x${string}` | null;
	balanceWei: string | null;
	gasPriceWei: string | null;
	routeDeployed: boolean;
	checkpointHeight: number;
	relayHeight: number | null;
	tbcTipHeight: number | null;
	estimatedTargetHeight: number | null;
	estimatedHeaderCount: number | null;
	setupGas: string;
	headerGas: string;
	mintGas: string;
	rawGas: string;
	bufferedGas: string;
	requiredWei: string | null;
	shortfallWei: string | null;
	gasUsedBufferPercent: number;
	gasPriceBufferPercent: number;
	inclusionReserveBlocks: number;
	checkedAt: string;
}
