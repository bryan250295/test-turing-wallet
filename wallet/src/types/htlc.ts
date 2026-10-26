export interface HtlcSecretPair {
	secretHex: string;
	hashHex: string;
}

export interface HtlcRecoveryTarget {
	lockTxid: string;
	contractId: string;
}

export interface HtlcInspectionItem extends HtlcRecoveryTarget {
	recoveryTxids: string[];
}

export type HtlcInspectionResult = HtlcRecoveryTarget & (
	{ lock: TokenHtlcLock; error?: never } |
	{ error: string; lock?: never }
);

export interface HtlcTokenLockTerms {
	sender: string;
	receiver: string;
	contractId: string;
	amount: string;
	hashHex: string;
	refundTime: string;
}

export interface HtlcTokenLockPlan {
	terms: HtlcTokenLockTerms;
	tokenName: string;
	symbol: string;
	decimals: number;
	amountRaw: string;
	remainingRaw: string;
	refundTimestamp: number;
	inputs: { txid: string; index: number; amountRaw: string }[];
	checkedAt: string;
}

export interface UnsignedTokenHtlc {
	action?: 'lock' | 'claim' | 'refund';
	signerAddress?: string;
	lockTxid?: string;
	buildId?: string;
	signingExpiresAt?: string;
	network: 'testnet';
	sdkVersion: string;
	plan: HtlcTokenLockPlan;
	rawHex: string;
	unsignedBytes: number;
	feeRaw: string;
	nativeInputRaw: string;
	nativeChangeRaw: string;
	protocolOutputRaw: string;
	tokenChangeRaw: string;
	proofCount: number;
	ancestorCount: number;
	inputs: { txid: string; index: number; scriptHex: string; nativeAmountRaw: string; kind: 'token' | 'fee' | 'control' }[];
	outputs: { index: number; purpose: string; nativeAmountRaw: string; tokenAmountRaw?: string; scriptHex: string }[];
	builtAt: string;
}

export interface SignedTokenHtlc {
	secretStored?: boolean;
	storageWarning?: string;
	txid: string;
	rawHex: string;
	signedBytes: number;
	feeRaw: string;
	minimumFeeRaw: string;
	feeSufficient: boolean;
	signaturesVerified: true;
	termsUnchanged: true;
	signedAt: string;
}

export interface TokenHtlcBroadcast {
	txid: string;
	status: 'submitted' | 'unknown' | 'rejected';
	message: string;
	updatedAt: string;
	scriptChecksVerified: boolean;
}

export interface TokenHtlcLock {
	recovery?: { txid: string; action: 'claim' | 'refund'; confirmations: number; feeRaw?: string };
	feeRaw?: string;
	recoveryWarning?: string;
	chainMedianTime: number;
	refundEligible: boolean;
	lockTxid: string;
	contractId: string;
	sender: string;
	receiver: string;
	hashHex: string;
	refundTimestamp: number;
	amountRaw: string;
	decimals: number;
	symbol: string;
	name: string;
	confirmations: number;
	controlUnspent: boolean;
	tokenUnspent: boolean;
	checkedAt: string;
}
