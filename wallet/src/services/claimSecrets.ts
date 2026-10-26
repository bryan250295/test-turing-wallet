import type { WalletAddresses, WalletSession } from '../types/wallet';
import { API_URLS } from '../config/constants';
import { postHtlcData } from './unsignedTokenHtlc';
import { hashHtlcSecret } from '../utils/htlc';

export async function retrieveClaimSecret(session: WalletSession, owner: string, lockTxid: string, signal: AbortSignal): Promise<string> {
	async function verifyAccount() {
		const [network, account] = await Promise.all([session.wallet.getNetwork(), session.wallet.getAddress()]);
		signal.throwIfAborted();
		const addresses = account as WalletAddresses | undefined;
		if (network?.network !== 'tbc' || network.type !== 'testnet' || (addresses?.tbcAddress ?? addresses?.addresses?.tbcAddress) !== owner) throw new Error('Select the original sender wallet on TBC Testnet to retrieve this secret.');
	}
	await verifyAccount();
	const challenge = await postHtlcData(API_URLS.htlcSecretChallenge, { lockTxid }, signal);
	if (!challenge || challenge.owner !== owner || challenge.lockTxid !== lockTxid || typeof challenge.challengeId !== 'string' || typeof challenge.message !== 'string' || !challenge.message.startsWith('Reveal my saved TBC Testnet claim secret\n') || !challenge.message.includes(`\nOrigin: ${window.location.origin}\n`) || !challenge.message.includes(`\nSender: ${owner}\n`) || !challenge.message.includes(`\nLock TXID: ${lockTxid}\n`)) throw new Error('Invalid secret recovery challenge.');
	await verifyAccount();
	const response = await session.wallet.signMessage({ message: challenge.message, encoding: 'utf8' });
	signal.throwIfAborted();
	if (response?.error) throw new Error(response.error);
	if (!response?.sig) throw new Error('The wallet did not return an ownership signature.');
	await verifyAccount();
	const result = await postHtlcData(API_URLS.htlcSecretRetrieve, { challengeId: challenge.challengeId, signature: response.sig }, signal);
	if (!result || result.lockTxid !== lockTxid || typeof result.secretHex !== 'string' || !/^[0-9a-f]{64}$/.test(result.secretHex) || typeof result.hashHex !== 'string' || await hashHtlcSecret(result.secretHex) !== result.hashHex) throw new Error('The recovered secret failed its hash check.');
	await verifyAccount();
	return result.secretHex;
}
