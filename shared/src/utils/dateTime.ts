type DateTimeValue = string | number | Date;

// Numeric API values are Unix seconds. Dates and ISO strings keep their instant.
function format(value: DateTimeValue, includeDate: boolean, timeZone: string): string {
	const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value * 1000 : value);
	if (!Number.isFinite(date.getTime())) return 'Unavailable';
	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		...(includeDate ? { day: 'numeric', month: 'short', year: 'numeric' } as const : {}),
		hour: 'numeric', minute: '2-digit', hour12: true,
	});
	return formatter.formatToParts(date).map((part) => part.type === 'dayPeriod'
		? (part.value.toLowerCase() === 'am' ? 'a.m.' : 'p.m.') : part.value).join('');
}

export function formatDateTime(value: DateTimeValue, timeZone = 'Asia/Kuala_Lumpur'): string {
	return format(value, true, timeZone);
}

export function formatTime(value: DateTimeValue, timeZone = 'Asia/Kuala_Lumpur'): string {
	return format(value, false, timeZone);
}
