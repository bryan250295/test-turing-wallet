import { useEffect, useRef, useState } from 'react';
import { toFunctionSelector } from 'viem';
import { HYPEREVM_TESTNET } from '../config/hyperevm';
import { ETHEREUM_SEPOLIA } from '../config/sepolia';
import { evmWalletError, isEvmProvider, legacyMetaMask, parseWalletNonce, readEvmWallet, readEvmWalletIdentity, switchEvmNetwork, withWalletReadTimeout } from '../services/evmWallet';
import type { EvmProvider, EvmWalletSnapshot } from '../types/evm';
import type { BridgeDeploymentTransaction, BridgeCallTransaction } from '../types/learningBridge';

const allowedBridgeCallSelectors = new Set([
	'0x3f4ba83a', '0xbf31ca75', '0x095ea7b3', '0x2b145d57', '0x959de493',
	toFunctionSelector('propose(address,bytes)'),
	toFunctionSelector('approveAndExecute(bytes32)'),
	toFunctionSelector('mintFromDeposit(bytes32,bytes32,uint8,bytes32,uint32,address,uint256)'),
	toFunctionSelector('burnForRedemption(bytes32,string,uint256)'),
]);

export default function useHyperEvmWallet(active: boolean, target: 'hyperevm' | 'sepolia' = 'hyperevm') {
	const network = target === 'sepolia' ? ETHEREUM_SEPOLIA : HYPEREVM_TESTNET;
	const [provider, setProvider] = useState<EvmProvider | null>(null);
	const [snapshot, setSnapshot] = useState<EvmWalletSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [pending, setPending] = useState<'connect' | 'switch' | 'deploy' | 'bridge' | null>(null);
	const [error, setError] = useState('');
	const reader = useRef<{ refresh: () => void } | null>(null);
	const command = useRef(false);
	const lifecycle = useRef(0);
	const mounted = useRef(false);

	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	useEffect(() => {
		if (!active) return;
		function announced(event: Event) {
			const detail: unknown = (event as CustomEvent).detail;
			if (!detail || typeof detail !== 'object' || !('info' in detail) || !('provider' in detail)) return;
			const info = detail.info;
			if (info && typeof info === 'object' && 'rdns' in info && info.rdns === 'io.metamask' && isEvmProvider(detail.provider)) {
				setProvider(detail.provider);
			}
		}
		window.addEventListener('eip6963:announceProvider', announced);
		window.dispatchEvent(new Event('eip6963:requestProvider'));
		setProvider((current) => current ?? legacyMetaMask());
		return () => window.removeEventListener('eip6963:announceProvider', announced);
	}, [active]);

	useEffect(() => {
		const epoch = ++lifecycle.current;
		setSnapshot(null);
		setError('');
		setLoading(false);
		if (!active || !provider) return;
		const walletProvider = provider;
		let alive = true;
		let version = 0;
		let running = false;
		let queued = false;

		// Coalesce overlapping refresh/events into one active read and one latest read.
		async function refresh() {
			if (!alive) return;
			version++;
			setLoading(true);
			setError('');
			if (running) { queued = true; return; }
			running = true;
			do {
				queued = false;
				const requestVersion = version;
				try {
					// Account and chain ID are extension-local reads. Publish them first so a
					// slow destination RPC balance read cannot block non-transaction setup.
					const identity = await withWalletReadTimeout(readEvmWalletIdentity(walletProvider));
					if (alive && version === requestVersion) {
						setSnapshot((previous) => previous?.address.toLowerCase() === identity.address.toLowerCase() && previous.chainId === identity.chainId
							? { ...identity, balanceWei: previous.balanceWei }
							: identity);
						setLoading(false);
					}
					if (identity.address && identity.chainId === network.chainId) {
						try {
							const next = await withWalletReadTimeout(readEvmWallet(walletProvider, network.chainId));
							if (alive && version === requestVersion) setSnapshot(next);
						} catch {
							// Keep the verified account/network snapshot. Transaction methods perform
							// their own strict balance, nonce, account and chain checks before sending.
						}
					}
				} catch (cause) {
					if (alive && version === requestVersion) setError(evmWalletError(cause));
				}
			} while (alive && queued);
			running = false;
			if (alive) setLoading(false);
		}

		const changed = () => { void refresh(); };
		const disconnected = () => {
			version++;
			queued = false;
			setSnapshot(null);
			setLoading(false);
			setError('MetaMask is disconnected. Open the extension and reconnect.');
		};
		reader.current = { refresh: changed };
		provider.on('accountsChanged', changed);
		provider.on('chainChanged', changed);
		provider.on('connect', changed);
		provider.on('disconnect', disconnected);
		void refresh();
		return () => {
			alive = false;
			lifecycle.current = epoch + 1;
			reader.current = null;
			provider.removeListener('accountsChanged', changed);
			provider.removeListener('chainChanged', changed);
			provider.removeListener('connect', changed);
			provider.removeListener('disconnect', disconnected);
		};
	}, [active, provider, network.chainId]);

	async function run(action: 'connect' | 'switch') {
		if (!active || command.current) return;
		if (!provider) {
			window.dispatchEvent(new Event('eip6963:requestProvider'));
			const fallback = legacyMetaMask();
			if (fallback) setProvider(fallback);
			setError('MetaMask was not detected. Install or enable its browser extension, then reload this page.');
			return;
		}
		const epoch = lifecycle.current;
		command.current = true;
		setPending(action);
		setError('');
		try {
			if (action === 'connect') await provider.request({ method: 'eth_requestAccounts' });
			else await switchEvmNetwork(provider, network);
			if (lifecycle.current === epoch) reader.current?.refresh();
		} catch (cause) {
			if (lifecycle.current === epoch) setError(evmWalletError(cause));
		} finally {
			// Tab changes invalidate reads, but must not start a second approval prompt.
			command.current = false;
			if (mounted.current) setPending(null);
		}
	}

	async function sendDeployment(transaction: BridgeDeploymentTransaction): Promise<string> {
		if (!active || !provider || command.current) throw new Error('Finish the current MetaMask request before deploying.');
		if (transaction.chainId !== '0x3e6' || transaction.value !== '0x0'
			|| !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.data)) {
			throw new Error('Unsupported deployment transaction.');
		}
		const epoch = lifecycle.current;
		command.current = true;
		setPending('deploy');
		try {
			const current = await withWalletReadTimeout(readEvmWallet(provider, HYPEREVM_TESTNET.chainId));
			const nonceResponse = await withWalletReadTimeout(provider.request({
				method: 'eth_getTransactionCount', params: [transaction.from, 'pending'],
			}));
			if (lifecycle.current !== epoch || current.chainId !== 998 || current.address.toLowerCase() !== transaction.from.toLowerCase()) throw new Error('MetaMask account, network or page changed before the deployment request.');
			const nonce = parseWalletNonce(nonceResponse);
			if (nonce !== BigInt(transaction.nonce)) throw new Error(`MetaMask reports pending nonce ${nonce}, but this deployment requires ${BigInt(transaction.nonce)}. Refresh before retrying.`);
			if (current.balanceWei === null || BigInt(current.balanceWei) < BigInt(transaction.gas) * BigInt(transaction.gasPrice)) throw new Error('The current MetaMask balance does not cover the reviewed deployment budget.');
			// Whitelist creation fields: deliberately omit "to", approvals and value.
			// No timeout: a wallet approval remains pending until the user answers.
			const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: transaction.from, chainId: '0x3e6', data: transaction.data, value: '0x0', gas: transaction.gas, gasPrice: transaction.gasPrice, nonce: transaction.nonce }] });
			if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('MetaMask did not return a transaction hash. Check its activity before trying another deployment.');
			return hash.toLowerCase();
		} finally {
			command.current = false;
			if (mounted.current) setPending(null);
		}
	}

	async function sendBridgeCall(transaction: BridgeCallTransaction): Promise<string> {
		if (!active || !provider || command.current) throw new Error('Finish the current MetaMask request first.');
		if (transaction.chainId !== network.chainIdHex || transaction.value !== '0x0' || !/^0x[0-9a-f]{40}$/i.test(transaction.to) || !allowedBridgeCallSelectors.has(transaction.data.slice(0, 10).toLowerCase())) throw new Error('Unsupported bridge wallet call.');
		const epoch = lifecycle.current; command.current = true; setPending('bridge');
		try {
			const current = await withWalletReadTimeout(readEvmWallet(provider, network.chainId));
			const nonceResponse = await withWalletReadTimeout(provider.request({ method: 'eth_getTransactionCount', params: [transaction.from, 'pending'] }));
			if (lifecycle.current !== epoch) throw new Error('The page or wallet provider changed before sending. No transaction request was opened. Refresh saved progress before preparing a new quote.');
			if (current.chainId !== network.chainId) throw new Error(`MetaMask is on chain ${current.chainId}; this call requires ${network.chainName} (${network.chainId}). No transaction request was opened.`);
			if (current.address.toLowerCase() !== transaction.from.toLowerCase()) throw new Error(`MetaMask selected ${current.address || 'no account'}; this call requires ${transaction.from}. No transaction request was opened.`);
			const nonce = parseWalletNonce(nonceResponse);
			if (nonce !== BigInt(transaction.nonce)) throw new Error(`MetaMask reports pending nonce ${nonce}, but the reviewed quote requires ${BigInt(transaction.nonce)}. No transaction request was opened. Check Activity and refresh the wallet connection before preparing a new quote.`);
			if (current.balanceWei === null || BigInt(current.balanceWei) < BigInt(transaction.gas) * BigInt(transaction.gasPrice)) throw new Error(`The current ${network.nativeCurrency.symbol} balance does not cover this call budget.`);
			const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: transaction.from, to: transaction.to, chainId: network.chainIdHex, data: transaction.data, value: '0x0', gas: transaction.gas, gasPrice: transaction.gasPrice, nonce: transaction.nonce }] });
			if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('No transaction hash was returned. Check MetaMask Activity before doing anything again.');
			return hash.toLowerCase();
		} finally { command.current = false; if (mounted.current) setPending(null); }
	}
	async function watchWrappedToken(address: string, symbol: string, decimals: number) {
		if (!active || !provider || command.current || !/^0x[0-9a-f]{40}$/.test(address) || !/^[A-Za-z][A-Za-z0-9]{0,10}$/.test(symbol) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Connect MetaMask before importing the wrapped token.');
		command.current = true; setPending('bridge');
		try {
			if ((await withWalletReadTimeout(readEvmWallet(provider, network.chainId))).chainId !== network.chainId) throw new Error(`Select ${network.chainName} before importing the wrapped token.`);
			return await provider.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address, symbol, decimals } } });
		} finally { command.current = false; if (mounted.current) setPending(null); }
	}
	return {
		...snapshot,
		detected: provider !== null,
		loading,
		pending,
		error,
		sendDeployment,
		sendBridgeCall,
		watchWrappedToken,
		readCurrent: async () => {
			if (!active || !provider) throw new Error('Connect MetaMask on HyperEVM Testnet first.');
			return withWalletReadTimeout(readEvmWallet(provider, network.chainId));
		},
		networkIsTestnet: snapshot?.chainId === network.chainId,
		targetNetwork: network,
		connect: () => run('connect'),
		switchNetwork: () => run('switch'),
		refresh: () => reader.current?.refresh(),
	};
}
