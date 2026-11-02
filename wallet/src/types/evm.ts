// Injected EIP-1193 interface. Sending requires an explicit reviewed wallet action.
export interface EvmProvider {
	request(args: { method: string; params?: readonly unknown[] | Record<string, unknown> }): Promise<unknown>;
	on(event: string, listener: (...args: unknown[]) => void): void;
	removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface EvmWalletSnapshot {
	address: string;
	chainId: number;
	balanceWei: string | null;
	checkedAt: number;
}
