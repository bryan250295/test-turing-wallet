// The injected EIP-1193 interface used by this read-only wallet integration.
export interface EvmProvider {
	request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
	on(event: string, listener: (...args: unknown[]) => void): void;
	removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface EvmWalletSnapshot {
	address: string;
	chainId: number;
	balanceWei: string | null;
	checkedAt: number;
}
