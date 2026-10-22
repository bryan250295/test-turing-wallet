import { API_URLS } from '../config/constants';

export async function logAction(action, data) {
	try {
		const response = await fetch(API_URLS.actionLog, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, data }, (_key, value) => {
				if (typeof value === 'bigint') return value.toString();
				if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
				return value;
			}),
		});
		if (!response.ok) throw new Error(`Log endpoint returned ${response.status}`);
	} catch (error) {
		console.error(`Could not save ${action} log:`, error);
	}
}
