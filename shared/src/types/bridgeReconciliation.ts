/** Public, read-only reconciliation data. Amounts are integer strings. */
export interface ReconciliationTransaction {
	id: string;
	label: string;
	network: 'tbc' | 'hyperevm';
	hash: string | null;
	status: string;
	confirmations: number | null;
	required: number;
	actualFeeRaw: string | null;
	checkedAt: string | null;
}
export interface ReconciliationRedemption {
	id: string;
	createdAt: string;
	checkedAt: string | null;
	amountRaw: string;
	recipient: string;
	escrowAddress: string;
	status: string;
	fundingRaw: string | null;
	plannedReleaseFeeRaw: string | null;
	plannedNativeChangeRaw: string | null;
	transactions: ReconciliationTransaction[];
}
export interface ReconciliationOrder {
	id: string;
	amountRaw: string;
	recipient: string;
	createdAt: string;
	status: string;
	checkedAt: string | null;
	transactions: ReconciliationTransaction[];
	redemptions: ReconciliationRedemption[];
}
export interface ReconciliationTotals {
	depositedRaw: string;
	mintedRaw: string;
	lockedRaw: string;
	returnedRaw: string;
	reserveRaw: string;
	circulatingRaw: string;
	differenceRaw: string;
	tbcFeesRaw: string;
	hypeFeesWei: string;
}
export interface ReconciliationRoute {
	deploymentId: string;
	wrappedToken: string;
	contractId: string;
	decimals: number;
	symbol: string;
	wrappedName: string;
	wrappedSymbol: string;
	status: 'empty' | 'balanced' | 'pending' | 'needs_review';
	issues: string[];
	totals: ReconciliationTotals;
	setupTransactions: ReconciliationTransaction[];
	orders: ReconciliationOrder[];
}
export interface BridgeReconciliation {
	identityAddress: string;
	generatedAt: string;
	basis: 'saved_verification';
	routes: ReconciliationRoute[];
}
export interface ReconciliationBalanceCheck {
	deploymentId: string;
	wrappedToken: string;
	startedAt: string;
	checkedAt: string;
	status: 'matching' | 'difference' | 'unavailable';
	message: string;
	/** All app-recorded custody addresses and verified escrows for this token. */
	custodyAddressCount: number;
	escrowCount: number;
	indexedReserveRaw: string | null;
	totalSupplyRaw: string | null;
	permanentlyLockedRaw: string | null;
	circulatingRaw: string | null;
	differenceRaw: string | null;
	targetBlockNumber: string | null;
	targetBlockHash: string | null;
}
