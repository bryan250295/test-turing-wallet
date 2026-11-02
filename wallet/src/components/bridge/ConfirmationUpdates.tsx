interface Props { automatic: boolean; onChange: (value: boolean) => void; paused: boolean }
export default function ConfirmationUpdates({ automatic, onChange, paused }: Props) {
	return <div className="bridge-confirmation-updates">
		<label className="bridge-role-choice"><input type="checkbox" checked={automatic} onChange={(event) => onChange(event.target.checked)} /> Check confirmations automatically</label>
		<p className="history-note">{paused ? 'Automatic checks paused after an error. Use Check now to retry the saved transaction.' : automatic ? 'Checks about every 30 seconds while this page is visible. You can wait here; no need to keep clicking.' : 'Automatic checks are off. Use Check now when ready.'} Checks never send a transaction.</p>
	</div>;
}
