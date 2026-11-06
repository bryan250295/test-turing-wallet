export interface Phase3TestnetDepositTerms {
	sender: string;
	publicKey: string;
	contractId: string;
	amount: string;
	recipient: `0x${string}`;
}

export interface Phase3TestnetDepositInput {
	txid: string;
	index: number;
	scriptHex: string;
	nativeAmountRaw: string;
	kind: 'token' | 'fee';
}

export interface UnsignedPhase3TestnetDeposit {
	buildId: string;
	signingExpiresAt: string;
	network: 'testnet';
	terms: Phase3TestnetDepositTerms;
	tokenName: string;
	symbol: string;
	decimals: number;
	amountRaw: string;
	depositNonce: string;
	destinationChainId: '998';
	destinationGateway: `0x${string}`;
	reserveController: string;
	rawHex: string;
	unsignedBytes: number;
	feeRaw: string;
	nativeChangeRaw: string;
	tokenChangeRaw: string;
	inputs: Phase3TestnetDepositInput[];
	outputs: Array<{ index: number; purpose: string; nativeAmountRaw: string; tokenAmountRaw?: string; scriptHex: string }>;
	builtAt: string;
}

export interface SignedPhase3TestnetDeposit {
	txid: string;
	rawHex: string;
	signedBytes: number;
	feeRaw: string;
	minimumFeeRaw: string;
	feeSufficient: boolean;
	signaturesVerified: true;
	proofVerified: true;
	depositId: `0x${string}`;
	signedAt: string;
}

export interface Phase3TestnetDepositBroadcast {
	txid: string;
	status: 'submitted' | 'unknown' | 'rejected';
	message: string;
	updatedAt: string;
	scriptChecksVerified: boolean;
}
