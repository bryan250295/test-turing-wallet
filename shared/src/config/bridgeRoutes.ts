import { LEARNING_BRIDGE_SOURCE_FT } from './learningBridge';

/** Explicitly enabled destinations; RPCs and chain IDs never come from form input. */
export const BRIDGE_DESTINATIONS = [{ id: 'hyperevm-testnet', chainId: 998, name: 'HyperEVM Testnet', nativeSymbol: 'HYPE' }] as const;

/** Operator-reviewed routes shown by the wallet. Disabled routes remain here
 * for historical receipts, but cannot be selected for a new transfer. */
export const BRIDGE_ROUTE_CATALOG = [{
	id: 'mt-v15-hyperevm-testnet',
	status: 'enabled',
	version: 'V1.5',
	sourceContractId: LEARNING_BRIDGE_SOURCE_FT.contractId,
	sourceName: LEARNING_BRIDGE_SOURCE_FT.name,
	sourceSymbol: LEARNING_BRIDGE_SOURCE_FT.symbol,
	destinationId: 'hyperevm-testnet',
	destinationChainId: 998,
	wrappedName: 'Wrapped Mega Token',
	wrappedSymbol: 'wMT',
	protocol: 'custodial-multisig-v1.5',
	description: 'Confirmation-based custody route with an offline multisig administrator and a limited hot relayer.',
	contracts: { relay: null, gateway: null, wrappedToken: null },
}, {
	id: 'mt-v3-hyperevm-testnet',
	status: 'archived',
	version: 'V3',
	sourceContractId: LEARNING_BRIDGE_SOURCE_FT.contractId,
	sourceName: LEARNING_BRIDGE_SOURCE_FT.name,
	sourceSymbol: LEARNING_BRIDGE_SOURCE_FT.symbol,
	destinationId: 'hyperevm-testnet',
	destinationChainId: 998,
	wrappedName: 'Wrapped Mega Token',
	wrappedSymbol: 'wMT',
	protocol: 'proof-backed-v3',
	description: 'Merkle-proof and header-relay experiment. Disabled for new transfers and retained for inspection only.',
	contracts: {
		relay: '0x6c6d3ceeb5a2faaa1a2eb77fe21cf731830be9b5',
		gateway: '0xfe12f0d8fda6ffebf08fbb262e6d1e6ad8b80554',
		wrappedToken: '0x7bb913f8fbc0c9fe0d2c6df9612d6e11dddd590e',
	},
}, {
	id: 'mt-v2-hyperevm-testnet',
	status: 'archived',
	version: 'V2',
	sourceContractId: LEARNING_BRIDGE_SOURCE_FT.contractId,
	sourceName: LEARNING_BRIDGE_SOURCE_FT.name,
	sourceSymbol: LEARNING_BRIDGE_SOURCE_FT.symbol,
	destinationId: 'hyperevm-testnet',
	destinationChainId: 998,
	wrappedName: 'Proof Wrapped Mega Token',
	wrappedSymbol: 'pwMT',
	protocol: 'proof-backed-v2',
	description: 'Earlier proof-backed public Testnet experiment. Disabled for new transfers and retained for inspection only.',
	contracts: {
		relay: '0xf63cbd4eb7653cfeef1c0704781ca76bf9de1eb7',
		gateway: '0x6c7d8ae7aad6d9711ac8c4af14aacfde7d4dfa4d',
		wrappedToken: '0x770a2bda591ff5a2daed298e0a67490174f7ed5a',
	},
}, {
	id: 'mt-legacy-lwft-hyperevm-testnet',
	status: 'disabled',
	version: 'V1 legacy',
	sourceContractId: LEARNING_BRIDGE_SOURCE_FT.contractId,
	sourceName: LEARNING_BRIDGE_SOURCE_FT.name,
	sourceSymbol: LEARNING_BRIDGE_SOURCE_FT.symbol,
	destinationId: 'hyperevm-testnet',
	destinationChainId: 998,
	wrappedName: 'Learning Wrapped Test FT',
	wrappedSymbol: 'lwFT',
	protocol: 'legacy-custody',
	description: 'Original learning contract. Disabled for new transfers and not reused by V1.5.',
	contracts: { relay: null, gateway: null, wrappedToken: null },
}] as const;
export const ORIGINAL_BRIDGE_ROUTE = 'tbc-testnet-legacy-ft-to-hyperevm-testnet-v1';
export function bridgeRouteId(contractId: string, chainId = 998): string {
 if (!/^(?!0{64}$)[0-9a-f]{64}$/.test(contractId)) throw new Error('Invalid source token contract ID.');
 if (!BRIDGE_DESTINATIONS.some(destination => destination.chainId === chainId)) throw new Error('This destination is not enabled.');
 return contractId === LEARNING_BRIDGE_SOURCE_FT.contractId ? ORIGINAL_BRIDGE_ROUTE : `tbc-ft-${chainId}-${contractId}`;
}
export function validWrappedName(value: unknown): value is string { return typeof value === 'string' && /^[\x20-\x7e]{1,64}$/.test(value) && value.trim() === value; }
export function validWrappedSymbol(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,10}$/.test(value); }
export function wrappedMetadata(quote: unknown): { wrappedName: string; wrappedSymbol: string } {
 if (quote && typeof quote === 'object' && 'wrappedName' in quote && 'wrappedSymbol' in quote && validWrappedName(quote.wrappedName) && validWrappedSymbol(quote.wrappedSymbol)) return { wrappedName: quote.wrappedName, wrappedSymbol: quote.wrappedSymbol };
 if (quote && typeof quote === 'object' && 'contractName' in quote && quote.contractName === 'BridgeWrappedFT') throw new Error('Saved wrapped token metadata is invalid.');
 return { wrappedName: 'Learning Wrapped Test FT', wrappedSymbol: 'lwFT' };
}
