import { parseHtlcRequest } from '../../../../shared/src/utils/htlcRequestHistory';
import { storageContext } from './storage-context';

export function saveStoredHtlcRequest(value: unknown) {
	const context = storageContext();
	const record = parseHtlcRequest(value);
	if (record.sender !== context.owner && record.receiver !== context.owner) throw new Error('This lock does not involve the authenticated wallet.');
	return context.requests.save(record);
}
export function listStoredHtlcRequests(address: string) {
	const context = storageContext();
	if (address !== context.owner) throw new Error('This address does not match the authenticated wallet.');
	return context.requests.list(address);
}
