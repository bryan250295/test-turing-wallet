import { HYPEREVM_TESTNET } from '../config/hyperevm';
import type { EvmProvider, EvmWalletSnapshot } from '../types/evm';

export function isEvmProvider(value: unknown): value is EvmProvider {
	if (!value || typeof value !== 'object') return false;
	const provider = value as Partial<EvmProvider>;
	return typeof provider.request === 'function'
		&& typeof provider.on === 'function' && typeof provider.removeListener === 'function';
}

// Prefer EIP-6963 announcements. This fallback supports older injected wallets.
export function legacyMetaMask(): EvmProvider | null {
	const injected = (window as Window & { ethereum?: unknown }).ethereum;
	if (!injected || typeof injected !== 'object') return null;
	const legacy = injected as { providers?: unknown[] };
	const candidates = Array.isArray(legacy.providers) ? legacy.providers : [injected];
	return candidates.find((candidate): candidate is EvmProvider => {
		if (!isEvmProvider(candidate)) return false;
		const flags = candidate as EvmProvider & { isMetaMask?: boolean; isRabby?: boolean; isBraveWallet?: boolean; isPhantom?: boolean };
		return flags.isMetaMask === true && !flags.isRabby && !flags.isBraveWallet && !flags.isPhantom;
	}) ?? null;
}

function hexQuantity(value: unknown): bigint {
	if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
		throw new Error('The wallet returned an invalid numeric response. Refresh to try again.');
	}
	return BigInt(value);
}

function accountOf(value: unknown): string {
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && /^0x[0-9a-f]{40}$/i.test(item))) {
		throw new Error('The wallet returned an invalid account response.');
	}
	return value[0] ?? '';
}

export async function readEvmWallet(provider: EvmProvider): Promise<EvmWalletSnapshot> {
	const [accounts, chain] = await Promise.all([
		provider.request({ method: 'eth_accounts' }),
		provider.request({ method: 'eth_chainId' }),
	]);
	const address = accountOf(accounts);
	const chainValue = hexQuantity(chain);
	if (chainValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported wallet chain ID.');
	const chainId = Number(chainValue);
	let balanceWei: string | null = null;
	if (address && chainId === HYPEREVM_TESTNET.chainId) {
		balanceWei = hexQuantity(await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] })).toString();
		// A network/account switch during the request must not label another balance as test HYPE.
		const [latestAccounts, latestChain] = await Promise.all([
			provider.request({ method: 'eth_accounts' }),
			provider.request({ method: 'eth_chainId' }),
		]);
		if (accountOf(latestAccounts).toLowerCase() !== address.toLowerCase() || hexQuantity(latestChain) !== chainValue) {
			throw new Error('The wallet changed while loading. Refresh the wallet details.');
		}
	}
	return { address, chainId, balanceWei, checkedAt: Date.now() };
}

function errorCode(error: unknown): number | undefined {
	return error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
}

export function evmWalletError(error: unknown): string {
	switch (errorCode(error)) {
		case 4001: return 'Request cancelled in MetaMask. You can try again when ready.';
		case -32002: return 'A MetaMask request is already pending. Open the extension to finish it.';
		case 4100: return 'MetaMask access is not authorized. Connect your account again.';
		case 4900: return 'MetaMask is disconnected. Unlock the extension and reconnect.';
		case 4901: return 'MetaMask cannot reach this network. Check the network and refresh.';
	}
	if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
	return 'Unable to read MetaMask. Open the extension and try again.';
}

export async function switchToHyperEvmTestnet(provider: EvmProvider): Promise<void> {
	const switchNetwork = () => provider.request({
		method: 'wallet_switchEthereumChain', params: [{ chainId: HYPEREVM_TESTNET.chainIdHex }],
	});
	try {
		await switchNetwork();
	} catch (error) {
		if (errorCode(error) !== 4902) throw error;
		await provider.request({
			method: 'wallet_addEthereumChain',
			params: [{
				chainId: HYPEREVM_TESTNET.chainIdHex,
				chainName: HYPEREVM_TESTNET.chainName,
				nativeCurrency: HYPEREVM_TESTNET.nativeCurrency,
				rpcUrls: [HYPEREVM_TESTNET.rpcUrl],
			}],
		});
		// Adding a network does not guarantee the wallet selected it.
		await switchNetwork();
	}
}

export function formatHypeBalance(wei: string): string {
	const value = BigInt(wei);
	const unit = 10n ** 18n;
	const fraction = (value % unit).toString().padStart(18, '0').replace(/0+$/, '').padEnd(6, '0');
	return `${(value / unit).toString()}.${fraction}`;
}

// Only read operations time out; an open wallet approval remains pending until answered.
export async function withWalletReadTimeout<T>(operation: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error('Reading MetaMask timed out. Check the extension and refresh.')), 20_000);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}
