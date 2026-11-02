import { storageContext } from './storage-context';

export function saveClaimSecret(owner: string, lockTxid: string, hashHex: string, secretHex: string) {
	const context = storageContext();
	if (context.owner !== owner) throw new Error('The authenticated wallet does not own this secret.');
	return context.secrets.save(owner, lockTxid, hashHex, secretHex);
}
