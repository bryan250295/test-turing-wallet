import type { LogAction } from '../types/wallet';
import { API_URLS } from '../config/constants';

export async function logAction(action: LogAction, data: unknown) {
	try {
		const response = await fetch(API_URLS.actionLog, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, data }, (_key, value) => {
				if (typeof value === 'bigint') return value.toString();
				if (value instanceof Error) return { name: value.name, message: value.message, code: 'code' in value ? value.code : undefined };
				return value;
			}),
		});
		if (!response.ok) throw new Error(`Log endpoint returned ${response.status}`);
	} catch (error) {
		console.error(`Could not save ${action} log:`, error);
	}
}
