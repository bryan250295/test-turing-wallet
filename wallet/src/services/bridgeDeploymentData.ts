import { LEARNING_WRAPPED_FT_BUILD as legacy } from '../../../shared/src/contracts/learningWrappedFT';
import { BRIDGE_WRAPPED_FT_BUILD as configurable } from '../../../shared/src/contracts/bridgeWrappedFT';
import { wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import type { BridgeDeploymentPreview } from '../types/learningBridge';
export function expectedDeploymentData(quote: BridgeDeploymentPreview) {
 const word = (value: bigint) => value.toString(16).padStart(64, '0');
 const fixed = `${quote.admin.slice(2).toLowerCase().padStart(64, '0')}${quote.minter.slice(2).toLowerCase().padStart(64, '0')}${quote.contractId}${word(BigInt(quote.decimals))}`;
 const build = quote.contractName === 'BridgeWrappedFT' ? configurable : legacy;
 if (quote.buildInputSha256 !== build.buildInputSha256 || quote.sourceSha256 !== build.sourceSha256) throw new Error('The deployment build is not recognized. Refresh before continuing.');
 if (quote.contractName !== 'BridgeWrappedFT') return `${build.bytecode}${fixed}`;
 function stringData(value: string) {
  const bytes = new TextEncoder().encode(value);
  return word(BigInt(bytes.length)) + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
 }
 const metadata = wrappedMetadata(quote);
 const name = stringData(metadata.wrappedName), symbol = stringData(metadata.wrappedSymbol);
 return `${build.bytecode}${fixed}${word(192n)}${word(192n + BigInt(name.length / 2))}${name}${symbol}`;
}
