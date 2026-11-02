import type { ReactNode } from 'react';

export function BridgeSteps({ steps, current, complete = false }: { steps: string[]; current: number; complete?: boolean }) {
	return <ol className="bridge-flow-steps" aria-label="Bridge progress">
		{steps.map((step, index) => <li key={step} className={complete || index < current ? 'done' : index === current ? 'current' : ''} aria-current={!complete && index === current ? 'step' : undefined}>
			<span aria-hidden="true">{complete || index < current ? '✓' : index + 1}</span>{step}
		</li>)}
	</ol>;
}

/** Current requests remain visible, including errors that require user recovery. */
export function AttemptHistory<T extends { id: string; status: string; lastError?: string | null }>({ rows, render, title = 'Previous wallet steps' }: { rows: T[]; render: (row: T) => ReactNode; title?: string }) {
	const history = rows.filter((row) => ['verified', 'cancelled'].includes(row.status) && !row.lastError);
	const current = rows.filter((row) => !history.includes(row));
	return <>{current.map((row) => <div key={row.id}>{render(row)}</div>)}
		{history.length > 0 && <details className="bridge-flow-history"><summary>{title} ({history.length})</summary>{history.map((row) => <div key={row.id}>{render(row)}</div>)}</details>}
	</>;
}

export function bridgeStatus(status: string) {
	const labels: Record<string, string> = {
		prepared: 'Review setup', quoted: 'Review and confirm', awaiting_wallet: 'Open MetaMask',
		submitted: 'Waiting for confirmations', confirming: 'Waiting for confirmations', verified: 'Confirmed',
		cancelled: 'Cancelled', reverted: 'Transaction failed', invalid: 'Review needed', needs_review: 'Review needed',
		awaiting_fee: 'Waiting for TBC fee payment', funded: 'Ready to approve and lock', locked: 'Ready to authorize MT return',
		signed: 'Ready to submit MT return', broadcasting: 'Submission uncertain · check the same TXID', completed: 'Completed',
	};
	return labels[status] ?? status.replaceAll('_', ' ');
}
