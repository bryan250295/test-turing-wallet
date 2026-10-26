import { useRef, useState } from 'react';
import { formatRefundDate, getRefundTimestamp, localDate, nextRefundTime, refundTimeOptions } from '../../utils/refundDateTime';

interface RefundDateTimePickerProps {
	initialValue?: string;
	disabled: boolean;
	onChange: (value: string) => void;
}

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const shortcuts = [
	{ minutes: 30, label: '+30 min' },
	{ minutes: 60, label: '+1 hour' },
	{ minutes: 1440, label: '+1 day' },
];

export default function RefundDateTimePicker({ disabled, onChange, initialValue = '' }: RefundDateTimePickerProps) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [isOpen, setIsOpen] = useState(false);
	const [selected, setSelected] = useState(initialValue);
	const [draftDate, setDraftDate] = useState('');
	const [draftTime, setDraftTime] = useState('');
	const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
	const [now, setNow] = useState(Date.now);
	const [error, setError] = useState('');
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const today = localDate(new Date(now));
	const draft = draftDate && draftTime ? `${draftDate}T${draftTime}` : '';
	const draftTimestamp = getRefundTimestamp(draft);
	const selectedTimestamp = getRefundTimestamp(selected);
	const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
	const offset = (month.getDay() + 6) % 7;
	const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
	const earliestMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1);
	const remainingMinutes = Math.max(0, Math.ceil((selectedTimestamp - now) / 60000));
	const remaining = remainingMinutes < 60 ? `${remainingMinutes} minutes`
		: `${Math.floor(remainingMinutes / 60)} hours${remainingMinutes % 60 ? ` ${remainingMinutes % 60} minutes` : ''}`;

	function setDraft(value: string) {
		const [date, time] = value.split('T');
		setDraftDate(date);
		setDraftTime(time);
		setMonth(new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1));
		setError('');
	}

	function openPicker() {
		const currentTime = Date.now();
		setNow(currentTime);
		setDraft(getRefundTimestamp(selected) > currentTime ? selected : nextRefundTime(60, currentTime));
		dialog.current?.showModal();
		setIsOpen(true);
	}

	function applySelection() {
		const currentTime = Date.now();
		setNow(currentTime);
		if (disabled || getRefundTimestamp(draft) <= currentTime) {
			setError('Choose a valid date and time in the future.');
			return;
		}
		setSelected(draft);
		onChange(draft);
		dialog.current?.close();
	}

	return (
		<div className="htlc-refund-picker" onFocus={() => setNow(Date.now())}>
			<label htmlFor="htlc-refund-trigger">Refund eligible after</label>
			<button id="htlc-refund-trigger" type="button" className="refund-picker-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={isOpen} aria-controls="htlc-refund-dialog" aria-describedby="htlc-refund-summary" onClick={openPicker}>
				<span>{selected ? formatRefundDate(selected) : 'Choose date and time'}</span>
				<svg className="refund-calendar-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
					<rect x="3" y="5" width="18" height="16" rx="2" />
					<path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2" />
				</svg>
			</button>
			<div id="htlc-refund-summary" className="refund-picker-summary" aria-live="polite">
				{selected && <p>{selectedTimestamp > now ? `Refund available in about ${remaining}.` : 'This time has passed. Choose a new deadline.'}</p>}
				<p>Timezone: {timeZone}</p>
			</div>
			<p className="history-note">Refunds are not automatic. A claim may still compete with a refund after this time.</p>
			<dialog ref={dialog} id="htlc-refund-dialog" className="refund-picker-dialog" aria-labelledby="refund-dialog-title" onClose={() => setIsOpen(false)}>
				<div className="refund-dialog-heading"><h3 id="refund-dialog-title">Choose refund date &amp; time</h3><button type="button" className="refund-icon-button" aria-label="Close date picker" onClick={() => dialog.current?.close()}>×</button></div>
				<div className="refund-shortcuts" aria-label="Quick refund times">
					{shortcuts.map((shortcut) => <button type="button" key={shortcut.minutes} onClick={() => { const currentTime = Date.now(); setNow(currentTime); setDraft(nextRefundTime(shortcut.minutes, currentTime)); }}>{shortcut.label}</button>)}
				</div>
				<div className="refund-calendar-heading">
					<button type="button" className="refund-icon-button" aria-label="Previous month" disabled={month <= earliestMonth} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
					<strong aria-live="polite">{monthLabel}</strong>
					<button type="button" className="refund-icon-button" aria-label="Next month" disabled={month.getFullYear() >= 2106 && month.getMonth() >= 1} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
				</div>
				<div className="refund-calendar" role="group" aria-label={monthLabel}>
					{weekdays.map((day) => <span className="refund-weekday" key={day}>{day}</span>)}
					{Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
					{Array.from({ length: daysInMonth }, (_, index) => {
						const day = new Date(month.getFullYear(), month.getMonth(), index + 1);
						const value = localDate(day);
						const available = value >= today && refundTimeOptions.some((time) => getRefundTimestamp(`${value}T${time.value}`) > now);
						return <button type="button" key={value} className={draftDate === value ? 'is-selected' : ''} disabled={!available} aria-pressed={draftDate === value} aria-current={value === today ? 'date' : undefined} aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} onClick={() => {
							setDraftDate(value);
							if (getRefundTimestamp(`${value}T${draftTime}`) <= Date.now()) setDraftTime('');
							setNow(Date.now());
							setError('');
						}}>{index + 1}</button>;
					})}
				</div>
				<label htmlFor="htlc-refund-time">Time <span className="refund-time-hint">(shortcuts round up to 5-minute intervals)</span></label>
				<select id="htlc-refund-time" value={draftTime} onChange={(event) => { setDraftTime(event.target.value); setNow(Date.now()); setError(''); }}>
					<option value="">Choose time</option>
					{refundTimeOptions.map((time) => <option key={time.value} value={time.value} disabled={getRefundTimestamp(`${draftDate}T${time.value}`) <= now}>{time.label}</option>)}
				</select>
				<p className="refund-draft-summary" role="status">{draftTimestamp > now ? formatRefundDate(draft) : 'Choose a future date and time.'}<br /><small>{timeZone}</small></p>
				{error && <p className="amount-error" role="alert">{error}</p>}
				<div className="refund-picker-actions"><button type="button" className="history-secondary" onClick={() => dialog.current?.close()}>Cancel</button><button type="button" disabled={disabled || draftTimestamp <= now} onClick={applySelection}>Apply</button></div>
			</dialog>
		</div>
	);
}
