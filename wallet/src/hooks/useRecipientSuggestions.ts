import { useSyncExternalStore } from 'react';
import { getRecipientCacheSnapshot, subscribeRecipientCache } from '../services/recipientCache';

export default function useRecipientSuggestions(owner: string) {
	const cache = useSyncExternalStore(subscribeRecipientCache, getRecipientCacheSnapshot);
	return { addresses: cache.addresses.filter((address) => address !== owner), error: cache.error };
}
