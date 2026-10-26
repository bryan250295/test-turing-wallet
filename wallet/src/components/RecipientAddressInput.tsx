import { useEffect, useRef, useState } from 'react';
import useRecipientSuggestions from '../hooks/useRecipientSuggestions';

interface RecipientAddressInputProps {
	id: string;
	owner: string;
	value: string;
	disabled: boolean;
	onChange: (address: string) => void;
}

export default function RecipientAddressInput({ id, owner, value, disabled, onChange }: RecipientAddressInputProps) {
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(-1);
	const [browseAll, setBrowseAll] = useState(false);
	const cache = useRecipientSuggestions(owner);
	const query = value.trim().toLowerCase();
	const matches = cache.addresses.filter((address) => browseAll || !query || address.toLowerCase().includes(query));
	const listId = `${id}-suggestions`;
	const expanded = open && !disabled;

	useEffect(() => {
		if (expanded && highlight >= 0) list.current?.children[highlight]?.scrollIntoView({ block: 'nearest' });
	}, [highlight, expanded]);

	function choose(address: string) {
		onChange(address);
		input.current?.focus();
		setOpen(false); setBrowseAll(false); setHighlight(-1);
	}

	return <div className="recipient-field" onBlur={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setHighlight(-1); }
	}}>
		<label htmlFor={id}>Recipient address</label>
		<div className="recipient-combobox">
			<div className={`recipient-control${disabled ? ' is-disabled' : ''}`}>
				<input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && matches[highlight] ? `${listId}-${highlight}` : undefined} aria-describedby={`${id}-hint`} value={value} disabled={disabled}
					onFocus={() => { setBrowseAll(cache.addresses.includes(value.trim())); setOpen(true); setHighlight(-1); }}
					onChange={(event) => { onChange(event.target.value); setBrowseAll(false); setOpen(true); setHighlight(-1); }}
					onKeyDown={(event) => {
						if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setHighlight(-1); }
						else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
							event.preventDefault(); setOpen(true);
							setHighlight((previous) => matches.length ? event.key === 'ArrowDown' ? (previous + 1) % matches.length : previous <= 0 ? matches.length - 1 : previous - 1 : -1);
						} else if (event.key === 'Enter' && expanded && matches[highlight]) { event.preventDefault(); choose(matches[highlight]); }
					}}
					placeholder="Enter or choose a TBC address" pattern="[1-9A-HJ-NP-Za-km-z]{26,35}" title="Select a recipient or enter a TBC wallet address" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
				{value && <button type="button" className="recipient-icon" disabled={disabled} aria-label="Clear recipient address" onClick={() => { onChange(''); input.current?.focus(); setBrowseAll(true); setOpen(true); setHighlight(-1); }}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
				</button>}
				<button type="button" className="recipient-icon" disabled={disabled} aria-label={expanded ? 'Close recipient suggestions' : 'Choose a recipient'} aria-expanded={expanded} aria-controls={listId} onClick={() => {
					const next = !expanded; input.current?.focus(); setBrowseAll(true); setOpen(next); setHighlight(-1);
				}}><svg className={expanded ? 'is-open' : ''} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
			</div>
			{expanded && <div className="recipient-suggestions">
				<ul ref={list} id={listId} role="listbox" aria-label="Recent recipients">{matches.map((address, index) => <li key={address} role="presentation">
					<button id={`${listId}-${index}`} type="button" role="option" aria-selected={highlight === index} tabIndex={-1} className={highlight === index ? 'is-highlighted' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(address)}><code>{address}</code></button>
				</li>)}</ul>
				{!matches.length && <p>{cache.addresses.length ? 'No matching recipients. Enter a new address to continue.' : 'No recent recipients yet. Enter a new address to continue.'}</p>}
			</div>}
		</div>
		<p id={`${id}-hint`} className="history-note">New recipients are remembered in this browser after a lock is successfully submitted.</p>
		{cache.error && <p className="amount-error" role="status">{cache.error}</p>}
	</div>;
}
