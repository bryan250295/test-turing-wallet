import { useEffect, useState } from 'react';
import type { WalletSession } from '../types/wallet';
import type { VerifiedBridgeAsset } from '../types/learningBridge';
import type useHyperEvmWallet from './useHyperEvmWallet';

export default function useBridgeDeploymentRoles(session: WalletSession, evm: ReturnType<typeof useHyperEvmWallet>, asset: VerifiedBridgeAsset | null, active: boolean) {
 const [sameAccount, setSameAccount] = useState(true);
 const [admin, setAdmin] = useState('');
 const [minter, setMinter] = useState('');
 useEffect(() => {
  setSameAccount(true);
  setAdmin('');
  setMinter('');
 }, [active, session.address, evm.address, evm.chainId]);
 return {
  ready: active && !!asset && session.backendAuth.ready && session.networkIsDevnet && !session.busy && !!evm.address && evm.networkIsTestnet && !evm.loading && !evm.pending,
  sameAccount, setSameAccount,
  admin: sameAccount ? evm.address ?? '' : admin, setAdmin,
  minter: sameAccount ? evm.address ?? '' : minter, setMinter,
 };
}
