import { useState } from 'react';
import { isAddress } from 'viem';
import { validWrappedName, validWrappedSymbol } from '../../../../shared/src/config/bridgeRoutes';
import type { WalletSession } from '../../types/wallet';
import type { VerifiedBridgeAsset } from '../../types/learningBridge';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import useBridgeDeploymentRoles from '../../hooks/useBridgeDeploymentRoles';
import BridgeDeploymentActions from './BridgeDeploymentActions';

export default function BridgeDeploymentPreview({ session, evm, asset, active, v15 = false, fixedRoles }: { session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; asset: VerifiedBridgeAsset | null; active: boolean; v15?: boolean; fixedRoles?: { admin: string; minter: string } }) {
 const [wrappedName, setWrappedName] = useState(`Wrapped ${asset?.name ?? 'Token'}`.slice(0, 64));
 const [wrappedSymbol, setWrappedSymbol] = useState(`w${(asset?.symbol ?? 'FT').replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 11));
 const form = useBridgeDeploymentRoles(session, evm, asset, active, v15, fixedRoles);
 const separated = !v15 || isAddress(form.admin, { strict: true }) && isAddress(form.minter, { strict: true }) && form.admin.toLowerCase() !== form.minter.toLowerCase();
 const canPrepare = form.ready && validWrappedName(wrappedName) && validWrappedSymbol(wrappedSymbol) && separated;
 return <section className="htlc-section bridge-deployment" aria-labelledby="bridge-deployment-title">
  <h3 id="bridge-deployment-title">{v15 ? 'V1.5 wrapped token deployment' : 'Wrapped token setup'}</h3>
  {!asset && <p>Select and verify your source token first.</p>}
  <BridgeDeploymentActions session={session} evm={evm} active={active && !!asset} canPrepare={canPrepare} input={asset ? { contractId: asset.contractId, destinationChainId: 998, ...(v15 ? { governanceMode: 'multisig-relayer-v1.5' as const } : {}), wrappedName, wrappedSymbol, deployer: evm.address ?? '', admin: form.admin, minter: form.minter } : null}>
   <label htmlFor="wrapped-name">Wrapped token name</label>
   <input id="wrapped-name" value={wrappedName} maxLength={64} placeholder="Wrapped source token" onChange={event => setWrappedName(event.target.value)} />
   <label htmlFor="wrapped-symbol">Wrapped token symbol</label>
   <input id="wrapped-symbol" value={wrappedSymbol} maxLength={11} placeholder="wTOKEN" onChange={event => setWrappedSymbol(event.target.value)} />
   <p className="history-note">Name: 1–64 printable English characters. Symbol: 1–11 letters or digits, starting with a letter.</p>
   <p className="history-note">Decimals: {asset?.decimals ?? 'Select a token'} · Matches the source token. Name and symbol are fixed after deployment.</p>
   <p>Wallet paying the deployment fee: <code>{evm.address || 'Connect MetaMask'}</code></p>
   <details className="bridge-flow-history" open={v15}><summary>Admin and minting wallet</summary>
    {!v15 && <label className="bridge-role-choice"><input type="checkbox" checked={form.sameAccount} onChange={event => form.setSameAccount(event.target.checked)} /> Use my MetaMask account for Admin and Minter</label>}
    <label htmlFor="bridge-deployment-admin">Admin wallet</label>
    <input id="bridge-deployment-admin" type="text" value={form.admin} readOnly={v15 || form.sameAccount} maxLength={42} spellCheck={false} autoComplete="off" placeholder={v15 ? 'Deployed automatically above' : '0x…'} onChange={event => form.setAdmin(event.target.value)} />
    <label htmlFor="bridge-deployment-minter">Minter wallet</label>
    <input id="bridge-deployment-minter" type="text" value={form.minter} readOnly={v15 || form.sameAccount} maxLength={42} spellCheck={false} autoComplete="off" placeholder={v15 ? 'Configured by backend' : '0x…'} onChange={event => form.setMinter(event.target.value)} />
    {v15 && <p className="history-note">These roles are read-only. The backend verifies the Admin bytecode, both configured signers, the 2-of-2 threshold and the separate Minter before preparing deployment.</p>}
   </details>
  </BridgeDeploymentActions>
 </section>;
}
