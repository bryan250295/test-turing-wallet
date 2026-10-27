import type { SignedTokenHtlc, TokenHtlcBroadcast, UnsignedTokenHtlc } from '../../types/htlc';
import { formatRawAmount } from '../../utils/tokenAmounts';
import HtlcSubmission from './HtlcSubmission';
import { formatDateTime, formatTime } from '../../utils/dateTime';

interface PreviewProps {
	transaction: UnsignedTokenHtlc;
	signed: SignedTokenHtlc | null;
	disabled: boolean;
	loading: boolean;
	onSign: () => void;
	receipt: TokenHtlcBroadcast | null;
	onSubmit: (checkOnly: boolean) => void;
}

export default function TokenLockReview({ transaction, signed, disabled, loading, onSign, receipt, onSubmit }: PreviewProps) {
	const { plan } = transaction;
	const tbc = (raw: string) => `${formatRawAmount(raw, 6)} TBC`;

	return <section className="htlc-section" aria-label="Lock review and confirmation">
		<dl className="history-detail-grid">
			<div><dt>Token amount</dt><dd>{formatRawAmount(plan.amountRaw, plan.decimals)} {plan.symbol}</dd></div>
			<div><dt>Recipient</dt><dd><code>{plan.terms.receiver}</code></dd></div>
			<div><dt>Refund eligible after · MYT</dt><dd>{formatDateTime(plan.refundTimestamp)}</dd></div>
			<div><dt>Transaction fee</dt><dd>{tbc(transaction.feeRaw)}</dd></div>
			<div><dt>Native TBC in protocol outputs</dt><dd>{tbc(transaction.protocolOutputRaw)}</dd></div>
		</dl>
		<details className="htlc-raw-preview"><summary>More details</summary><dl className="history-detail-grid">
			<div><dt>Refund address</dt><dd><code>{plan.terms.sender}</code></dd></div>
			<div><dt>Token contract</dt><dd><code>{plan.terms.contractId}</code></dd></div>
			<div><dt>Hashlock</dt><dd><code>{plan.terms.hashHex}</code></dd></div>
			<div><dt>Token change</dt><dd>{formatRawAmount(transaction.tokenChangeRaw, plan.decimals)} {plan.symbol}</dd></div>
			<div><dt>Native TBC change</dt><dd>{tbc(transaction.nativeChangeRaw)}</dd></div>
		</dl></details>
		{!signed && <>
			<button type="button" disabled={disabled || loading || !transaction.buildId} onClick={onSign}>{loading ? 'Waiting for wallet…' : 'Sign with wallet'}</button>
			<p className="history-note">Signing prepares the transaction. Submit it below to lock your tokens.</p>
			{transaction.signingExpiresAt && <p className="history-note">Review valid until {formatTime(transaction.signingExpiresAt)} MYT. If it expires, edit details and review again.</p>}
		</>}
		{signed && <HtlcSubmission transaction={transaction} signed={signed} receipt={receipt} disabled={disabled} loading={loading} onSubmit={onSubmit} />}
	</section>;
}
