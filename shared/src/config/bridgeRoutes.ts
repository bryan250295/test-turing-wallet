import { LEARNING_BRIDGE_SOURCE_FT } from './learningBridge';

/** Explicitly enabled destinations; RPCs and chain IDs never come from form input. */
export const BRIDGE_DESTINATIONS = [{ id: 'hyperevm-testnet', chainId: 998, name: 'HyperEVM Testnet', nativeSymbol: 'HYPE' }] as const;
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
