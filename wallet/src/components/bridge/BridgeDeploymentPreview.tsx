import { useState } from 'react';
import { validWrappedName, validWrappedSymbol } from '../../../../shared/src/config/bridgeRoutes';
import type { WalletSession } from '../../types/wallet';
import type { VerifiedBridgeAsset } from '../../types/learningBridge';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeDeploymentRoles from '../../hooks/useBridgeDeploymentRoles';
import BridgeDeploymentActions from './BridgeDeploymentActions';

export default function BridgeDeploymentPreview({ session, evm, asset, active }: { session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; asset: VerifiedBridgeAsset | null; active: boolean }) {
 const [wrappedName, setWrappedName] = useState(`Wrapped ${asset?.name ?? 'Token'}`.slice(0, 64));
 const [wrappedSymbol, setWrappedSymbol] = useState(`w${(asset?.symbol ?? 'FT').replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 11));
 const form = useBridgeDeploymentRoles(session, evm, asset, active);
 return <section className="htlc-section bridge-deployment" aria-labelledby="bridge-deployment-title">
  <h3 id="bridge-deployment-title">Wrapped token setup</h3>
  {!asset && <p>Select and verify your source token first.</p>}
  <BridgeDeploymentActions session={session} evm={evm} active={active && !!asset} canPrepare={form.ready && validWrappedName(wrappedName) && validWrappedSymbol(wrappedSymbol)} input={asset ? { contractId: asset.contractId, destinationChainId: 998, wrappedName, wrappedSymbol, deployer: evm.address ?? '', admin: form.admin, minter: form.minter } : null}>
   <label htmlFor="wrapped-name">Wrapped token name</label>
   <input id="wrapped-name" value={wrappedName} maxLength={64} placeholder="Wrapped Mega Token" onChange={event => setWrappedName(event.target.value)} />
   <label htmlFor="wrapped-symbol">Wrapped token symbol</label>
   <input id="wrapped-symbol" value={wrappedSymbol} maxLength={11} placeholder="wMT" onChange={event => setWrappedSymbol(event.target.value)} />
   <p className="history-note">Name: 1–64 printable English characters. Symbol: 1–11 letters or digits, starting with a letter.</p>
   <p className="history-note">Decimals: {asset?.decimals ?? 'Select a token'} · Matches the source token. Name and symbol are fixed after deployment.</p>
   <p>Wallet paying the deployment fee: <code>{evm.address || 'Connect MetaMask'}</code></p>
   <details className="bridge-flow-history"><summary>Admin and minting wallet</summary>
    <label className="bridge-role-choice"><input type="checkbox" checked={form.sameAccount} onChange={event => form.setSameAccount(event.target.checked)} /> Use my MetaMask account for Admin and Minter</label>
    <label htmlFor="bridge-deployment-admin">Admin wallet</label>
    <input id="bridge-deployment-admin" type="text" value={form.admin} readOnly={form.sameAccount} maxLength={42} spellCheck={false} autoComplete="off" placeholder="0x…" onChange={event => form.setAdmin(event.target.value)} />
    <label htmlFor="bridge-deployment-minter">Minter wallet</label>
    <input id="bridge-deployment-minter" type="text" value={form.minter} readOnly={form.sameAccount} maxLength={42} spellCheck={false} autoComplete="off" placeholder="0x…" onChange={event => form.setMinter(event.target.value)} />
   </details>
  </BridgeDeploymentActions>
 </section>;
}
