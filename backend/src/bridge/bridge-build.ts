import { encodeDeployData, type Address } from 'viem';
import { LEARNING_WRAPPED_FT_BUILD as legacy, LEARNING_WRAPPED_FT_RUNTIME as legacyRuntime } from '../../../shared/src/contracts/learningWrappedFT';
import { BRIDGE_WRAPPED_FT_BUILD as configurable, BRIDGE_WRAPPED_FT_RUNTIME as configurableRuntime } from '../../../shared/src/contracts/bridgeWrappedFT';
import { wrappedMetadata } from '../../../shared/src/config/bridgeRoutes';
import type { BridgeDeploymentPreview } from '../../../shared/src/types/learningBridge';
export function deploymentBuild(quote: Pick<BridgeDeploymentPreview, 'contractName'>) {
 return quote.contractName === 'BridgeWrappedFT' ? { build: configurable, runtime: configurableRuntime } : { build: legacy, runtime: legacyRuntime };
}
export function deploymentData(quote: Pick<BridgeDeploymentPreview, 'contractName' | 'admin' | 'minter' | 'contractId' | 'decimals' | 'wrappedName' | 'wrappedSymbol'>) {
 const args = [quote.admin as Address, quote.minter as Address, `0x${quote.contractId}` as const, quote.decimals] as const;
 if (quote.contractName === 'BridgeWrappedFT') {
  const metadata = wrappedMetadata(quote);
  return encodeDeployData({ abi: configurable.abi, bytecode: configurable.bytecode, args: [...args, metadata.wrappedName, metadata.wrappedSymbol] });
 }
 return encodeDeployData({ abi: legacy.abi, bytecode: legacy.bytecode, args });
}
