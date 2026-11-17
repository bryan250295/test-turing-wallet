import { useCallback, useSyncExternalStore } from 'react';
import { getRecipientCacheSnapshot, subscribeRecipientCache } from '../services/recipientCache';

export default function useRecipientSuggestions(owner: string) {
	const getSnapshot = useCallback(() => getRecipientCacheSnapshot(owner), [owner]);
	return useSyncExternalStore(subscribeRecipientCache, getSnapshot);
}
