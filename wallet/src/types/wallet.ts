import type { Address, GetNetworkResponse, Info } from 'turing-wallet-provider';
import type useWalletSession from '../hooks/useWalletSession';

// Some wallet versions wrap addresses in an additional `addresses` object.
export type WalletAddresses = Address & { addresses?: Address };
export type WalletNetwork = GetNetworkResponse;
export type WalletInfo = Info & { walletName?: string };
export type WalletResult = { type: 'success'; txid: string } | { type: 'error'; message: string };
export type WalletSession = ReturnType<typeof useWalletSession>;
export interface WalletPageProps {
	session: WalletSession;
	hidden?: boolean;
}
export type LogAction = 'Connect' | 'Mint' | 'Transfer';
