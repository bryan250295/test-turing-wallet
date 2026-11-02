export interface BridgeFtAsset {
	contractId: string;
	name: string;
	symbol: string;
	decimals: number;
}

// An asset verification is not a deposit proof, deployment or approval to mint.
export interface VerifiedBridgeAsset extends BridgeFtAsset {
	routeId: string;
	sourceNetwork: 'testnet';
	protocol: 'legacy-ft';
	legacyVersion: number;
	totalSupplyRaw: string;
	genesisCodeHash: string;
	genesisTapeHash: string;
	mintSourceTxid: string;
	mintSourceVout: number;
	genesisBlockHash: string;
	genesisBlockHeight: number;
	confirmations: number;
	destinationChainId: 998;
	verificationMethod: string;
	verifiedAt: string;
}

export interface BridgeDeploymentInput {
	destinationChainId?: 998;
	wrappedName?: string;
	wrappedSymbol?: string;
	contractId: string;
	deployer: string;
	admin: string;
	minter: string;
}

// Read-only quote, never a signed transaction or an approval to deploy/mint.
export interface BridgeDeploymentPreview extends BridgeDeploymentInput {
	chainId: 998;
	contractName: 'LearningWrappedFT' | 'BridgeWrappedFT';
	decimals: number;
	initiallyPaused: true;
	initialSupplyRaw: '0';
	buildInputSha256: string;
	sourceSha256: string;
	initCodeHash: string;
	gasEstimate: string;
	gasLimit: string;
	gasBufferPercent: number;
	gasPriceWei: string;
	estimatedFeeWei: string;
	bufferedFeeWei: string;
	balanceWei: string;
	shortfallWei: string;
	sufficientBalance: boolean;
	blockNumber: string;
	assetVerifiedAt: string;
	quotedAt: string;
	expiresAt: string;
}

export type BridgeDeploymentStatus = 'prepared' | 'awaiting_wallet' | 'submitted' | 'confirming' | 'verified' | 'reverted' | 'invalid' | 'cancelled';

export interface BridgeDeploymentRecord extends BridgeDeploymentInput {
	id: string;
	chainId: 998;
	decimals: number;
	status: BridgeDeploymentStatus;
	nonce: string;
	quote: BridgeDeploymentPreview;
	txHash: string | null;
	contractAddress: string | null;
	confirmations: number;
	requiredConfirmations: number;
	receiptBlockHash: string | null;
	receiptBlockNumber: string | null;
	gasUsed: string | null;
	effectiveGasPriceWei: string | null;
	actualFeeWei: string | null;
	runtimeCodeHash: string | null;
	verifiedAt: string | null;
	checkedAt: string | null;
	lastError: string | null;
	expiresAt: string;
	createdAt: string;
}

export interface BridgeDeploymentTransaction {
	from: string;
	chainId: '0x3e6';
	data: string;
	value: '0x0';
	gas: string;
	gasPrice: string;
	nonce: string;
}

export interface BridgeOrderInput {
	idempotencyKey: string;
	deploymentId: string;
	amount: string;
	recipient: string;
}

export interface BridgeOrder {
	id: string;
	deploymentId: string;
	status: 'prepared' | 'cancelled';
	sourceNetwork: 'testnet';
	contractId: string;
	decimals: number;
	symbol: string;
	wrappedName: string;
	wrappedSymbol: string;
	amountRaw: string;
	sender: string;
	recipient: string;
	destinationChainId: 998;
	destinationContract: string;
	sourceConfirmationsRequired: number;
	destinationConfirmationsRequired: number;
	termsHash: string;
	policyVersion: string;
	custody: { allocated: true; encrypted: true; address: null; paymentEnabled: boolean };
	depositTxHash: null;
	mintTxHash: null;
	paymentDeadline: null;
	createdAt: string;
	cancelledAt: string | null;
	settlementStarted: boolean;
	settlementStatus: BridgeSettlementStatus | null;
}

export type BridgeSettlementStatus = 'awaiting_payment' | 'confirming' | 'ready_to_mint' | 'mint_pending' | 'completed' | 'needs_review';
export type BridgeCallKind = 'unpause' | 'mint';
export interface BridgeCallTransaction extends BridgeDeploymentTransaction { to: string }
export interface BridgeCallAttempt {
	id: string; kind: BridgeCallKind; status: 'quoted' | 'awaiting_wallet' | 'submitted' | 'confirming' | 'verified' | 'reverted' | 'invalid' | 'cancelled';
	transaction: BridgeCallTransaction; estimatedFeeWei: string; budgetWei: string; expiresAt: string; createdAt: string;
	txHash: string | null; confirmations: number; actualFeeWei: string | null; lastError: string | null;
}
export interface BridgeSettlement {
	orderId: string; status: BridgeSettlementStatus; custodyAddress: string; paymentOpenedAt: string;
	checkedAt: string | null; lastError: string | null;
	deposit: { txid: string; vout: number; amountRaw: string; feeRaw: string; confirmations: number; blockHash: string | null; blockHeight: number | null; checkedAt: string } | null;
	attempts: BridgeCallAttempt[];
}

export interface BridgeOrderSetup {
	custodyReady: boolean;
	paymentEnabled: boolean;
	message: string;
	maxOpenOrders: number;
	deployments: { contractId: string; decimals: number; sourceSymbol: string; wrappedName: string; wrappedSymbol: string; id: string; contractAddress: string; deployer: string; verifiedAt: string }[];
}

export interface RedemptionEscrowPreview {
	orderId: string;
	chainId: 998;
	wrappedToken: string;
	admin: string;
	sourceContractId: string;
	decimals: number;
	reserveAmountRaw: string;
	reserveConfirmations: number;
	reserveCheckedAt: string;
	wrappedBalanceRaw: string;
	nonce: string;
	gasEstimate: string;
	gasLimit: string;
	gasPriceWei: string;
	estimatedFeeWei: string;
	budgetWei: string;
	balanceWei: string;
	sufficientBalance: boolean;
	transactionData: string;
	initCodeHash: string;
	buildInputSha256: string;
	quotedAt: string;
	expiresAt: string;
	lockingEnabled: false;
	sourceReleaseEnabled: false;
}

export interface RedemptionEscrowDeployment {
	id: string;
	orderId: string;
	deploymentId: string;
	status: BridgeDeploymentStatus;
	quote: RedemptionEscrowPreview;
	txHash: string | null;
	contractAddress: string | null;
	confirmations: number;
	requiredConfirmations: 6;
	receiptBlockHash: string | null;
	receiptBlockNumber: string | null;
	actualFeeWei: string | null;
	runtimeCodeHash: string | null;
	verifiedAt: string | null;
	checkedAt: string | null;
	lastError: string | null;
	createdAt: string;
}


/** Preparation only. No allowance, lock, release or wallet-send authorization. */
export interface RedemptionOrderInput {
	escrowId: string; idempotencyKey: string; holder: string; tbcRecipient: string; amount: string;
}
export interface RedemptionOrder {
	id: string; orderId: string; escrowId: string; idempotencyKey: string; redemptionId: string;
	chainId: 998; escrowAddress: string; wrappedToken: string; sourceContractId: string; decimals: number;
	holder: string; tbcRecipient: string; amountRaw: string; termsHash: string; policyVersion: 'permanent-escrow-preparation-v1';
	status: 'prepared' | 'cancelled'; createdAt: string; cancelledAt: string | null;
	evidence: { reserveTxid: string; reserveVout: number; reserveAmountRaw: string; reserveBlockHash: string;
		reserveConfirmations: number; reserveCheckedAt: string; targetBlockHash: string; targetBlockNumber: string;
		wrappedBalanceRaw: string; escrowPaused: true; totalLockedRaw: '0'; checkedAt: string };
	lockingEnabled: false; sourceReleaseEnabled: false; releaseStarted: boolean;
}

export interface RedemptionReleaseView {
	redemptionId: string;
	status: 'awaiting_fee' | 'funded' | 'locked' | 'signed' | 'broadcasting' | 'submitted' | 'confirming' | 'completed' | 'needs_review';
	fundingAddress: string; fundingRequiredRaw: string;
	feeQuote: { feeRaw: string; fundingRequiredRaw: string; estimatedBytes: number; feeRateSatPerKb: 80; marginPercent: 20; nativeDecimals: 6 };
	plan: { planHash: string; feeRaw: string; fundingTxid: string; fundingVout: number; fundingValueRaw: string; reserveTxid: string;
		reserveVout: number; recipient: string; amountRaw: string; nativeChangeRaw: string } | null;
	lock: { txHash: string; logIndex: number; confirmations: number; checkedAt: string } | null;
	signed: { txid: string; feeRaw: string; confirmations: number; blockHash: string | null } | null;
	createdAt: string; checkedAt: string | null; lastError: string | null; walletLockingEnabled: true;
}

export type RedemptionWalletKind = 'unpause' | 'reset' | 'approve' | 'lock';
export interface RedemptionWalletCall extends Omit<BridgeCallAttempt, 'kind'> { kind: RedemptionWalletKind; redemptionId: string }
export interface RedemptionWalletState { redemptionId: string; paused: boolean; allowanceRaw: string; balanceRaw: string; nextKind: RedemptionWalletKind; from: string; blockNumber: string; blockHash: string }

/** Wallet-returned transaction receipt; never a verified deposit proof. */
export interface BridgeSourcePayment {
 orderId: string; attemptId: string; status: 'awaiting_wallet' | 'submitted' | 'cancelled'; txid: string | null;
 sender: string; contractId: string; amountRaw: string; decimals: number; custodyAddress: string;
}
