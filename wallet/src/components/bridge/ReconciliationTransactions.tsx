import { useEffect, useState } from 'react';
import type { ReconciliationTransaction } from '../../../../shared/src/types/bridgeReconciliation';
import { formatDateTime } from '../../utils/dateTime';
import { reconciliationAmount as amount, requestStage, shortReference } from '../../utils/bridgeReconciliation';

export function CopyReference({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
	const [feedback, setFeedback] = useState('');
	useEffect(() => setFeedback(''), [value]);
	return <span className="recon-reference"><code title={value}>{compact ? shortReference(value) : value}</code><button type="button" className="history-secondary recon-copy" aria-label={`Copy ${label}`} onClick={() => {
		if (!navigator.clipboard) { setFeedback('Select the text to copy'); return; }
		void navigator.clipboard.writeText(value).then(() => setFeedback('Copied')).catch(() => setFeedback('Select the text to copy'));
	}}>{feedback || 'Copy'}</button></span>;
}
export default function ReconciliationTransactions({ rows, title }: { rows: ReconciliationTransaction[]; title: string }) {
	const sent = rows.filter((row) => row.hash);
	const unsent = rows.filter((row) => !row.hash);
	function table(transactions: ReconciliationTransaction[], caption: string) {
		return <div className="history-scroll recon-transaction-list" role="region" aria-label={caption} tabIndex={0}>
			<table className="history-table"><caption>{caption}</caption><thead><tr><th scope="col">Action</th><th scope="col">Status</th><th scope="col">Transaction</th><th scope="col">Confirmations</th><th scope="col">Recorded fee</th></tr></thead>
				<tbody>{transactions.map((row) => <tr key={row.id}>
					<td>{row.label}<small>{row.network === 'tbc' ? 'TBC Testnet' : 'HyperEVM Testnet'}</small></td>
					<td>{requestStage(row.status)}{row.checkedAt && <small>{formatDateTime(row.checkedAt)} MYT</small>}</td>
					<td>{row.hash ? <CopyReference value={row.hash} label="transaction hash" compact /> : 'Not sent'}</td>
					<td>{row.confirmations === null ? 'Not recorded' : `${row.confirmations} / ${row.required}`}</td>
					<td>{row.actualFeeRaw === null ? 'Not recorded' : `${amount(row.actualFeeRaw, row.network === 'tbc' ? 6 : 18)} ${row.network === 'tbc' ? 'TBC' : 'HYPE'}`}</td>
				</tr>)}</tbody></table>
		</div>;
	}
	return <>{sent.length ? table(sent, title) : <p className="history-note">No transactions sent for this request.</p>}
		{unsent.length > 0 && <details className="recon-unsent"><summary>Other attempts ({unsent.length})</summary>{table(unsent, 'Unsent attempts')}</details>}
	</>;
}
