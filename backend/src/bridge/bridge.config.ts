import { LEARNING_BRIDGE_SOURCE_FT } from '../../../shared/src/config/learningBridge';

// Operator-approved first asset, selected by the user on 2026-10-28.
// Never derive these bindings from request metadata or a browser-selected RPC.
export const BRIDGE_ASSET_POLICY = Object.freeze({
	routeId: 'tbc-testnet-legacy-ft-to-hyperevm-testnet-v1',
	...LEARNING_BRIDGE_SOURCE_FT,
	sourceNetwork: 'testnet' as const,
	protocol: 'legacy-ft' as const,
	legacyVersion: 3,
	destinationChainId: 998 as const,
	minimumConfirmations: 6,
	// Public reference captured from the dedicated tbcdev API, not a client assertion.
	genesisBlockHeight: 838018,
	genesisBlockHash: '0000000000000368c3bf4aa8c04285cf69917a27c3fcf5d2c2fd24f8756c979c',
	mintSourceTxid: '0756eb73f180ce6abfeaf5f343ffcc63909f6fb4028f7a1e209a045890affdb2',
	mintSourceVout: 0,
	verificationMethod: 'tbc-contract-1.7.3-published-genesis-v1',
});
