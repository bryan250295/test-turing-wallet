// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm
import { LEARNING_BRIDGE_EVM } from '../../../shared/src/config/learningBridge';

export const HYPEREVM_TESTNET = {
	chainId: LEARNING_BRIDGE_EVM.chainId,
	chainIdHex: '0x3e6',
	chainName: 'HyperEVM Testnet',
	rpcUrl: LEARNING_BRIDGE_EVM.rpcUrl,
	nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
} as const;
