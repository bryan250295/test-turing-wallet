import { formatDateTime } from './dateTime';

export function localDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const refundTimeOptions = Array.from({ length: 24 * 12 }, (_, index) => {
	const hour = Math.floor(index / 12);
	const minute = index % 12 * 5;
	return {
		value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
		label: `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'a.m.' : 'p.m.'}`,
	};
});

export function getRefundTimestamp(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return 0;
	const date = new Date(value);
	const timestamp = date.getTime();
	// Reject invalid dates, DST gaps and values outside the contract locktime range.
	const roundTrip = `${localDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	return roundTrip === value && timestamp >= 500_000_000_000 && timestamp <= 0xffffffff * 1000 ? timestamp : 0;
}

export function nextRefundTime(minutes: number, now: number): string {
	const date = new Date(now + minutes * 60000);
	const partialMinute = date.getSeconds() || date.getMilliseconds() ? 1 : 0;
	date.setMinutes(Math.ceil((date.getMinutes() + partialMinute) / 5) * 5);
	date.setSeconds(0, 0);
	return `${localDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatRefundDate(value: string): string {
	return formatDateTime(value, Intl.DateTimeFormat().resolvedOptions().timeZone);
}
