// Public identity of the first operator-approved learning asset. The backend
// independently checks these terms against its pinned genesis and chain source.
export const LEARNING_BRIDGE_SOURCE_FT = Object.freeze({
	contractId: 'ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c',
	name: 'Mega Token',
	symbol: 'MT',
	decimals: 1,
});

export const LEARNING_BRIDGE_EVM = Object.freeze({
	chainId: 998 as const,
	rpcUrl: 'https://rpc.hyperliquid-testnet.xyz/evm',
	previewLifetimeMs: 60_000,
	assetVerificationLifetimeMs: 10 * 60_000,
	gasBufferPercent: 20,
	deploymentConfirmations: 6,
});

export const LEARNING_BRIDGE_ORDERS = Object.freeze({
	policyVersion: 'mt-custodial-preparation-v1',
	maxOpenOrders: 3,
	sourceConfirmations: 6,
	destinationConfirmations: 6,
});
