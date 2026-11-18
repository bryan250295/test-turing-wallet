import { useEffect, useState } from 'react';
import type { WalletSession } from '../types/wallet';
import type { VerifiedBridgeAsset } from '../types/learningBridge';
import type useHyperEvmWallet from './useHyperEvmWallet';

export default function useBridgeDeploymentRoles(session: WalletSession, evm: ReturnType<typeof useHyperEvmWallet>, asset: VerifiedBridgeAsset | null, active: boolean, forceSeparate = false, fixed?: { admin: string; minter: string }) {
 const [sameAccount, setSameAccount] = useState(!forceSeparate);
 const [admin, setAdmin] = useState('');
 const [minter, setMinter] = useState('');
 useEffect(() => {
  setSameAccount(!forceSeparate);
  setAdmin('');
  setMinter('');
 }, [active, session.address, evm.address, evm.chainId, forceSeparate]);
 return {
  ready: active && !!asset && session.backendAuth.ready && session.networkIsDevnet && !session.busy && !!evm.address && evm.networkIsTestnet && !evm.loading && !evm.pending,
  sameAccount, setSameAccount: (value: boolean) => setSameAccount(forceSeparate ? false : value),
  admin: fixed?.admin ?? (sameAccount ? evm.address ?? '' : admin), setAdmin,
  minter: fixed?.minter ?? (sameAccount ? evm.address ?? '' : minter), setMinter,
 };
}
