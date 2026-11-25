import { useEffect, useRef, useState } from 'react';
import {
	decodeFunctionResult,
	encodeAbiParameters,
	encodeDeployData,
	encodeFunctionData,
	getAddress,
	getContractAddress,
	keccak256,
	parseAbi,
	stringToHex,
	toHex,
} from 'viem';
import { ETHEREUM_BRIDGE_ADMIN_MULTISIG_BUILD as build } from '../../../../shared/src/contracts/ethereumBridgeAdminMultisig';
import { TBC_ETHEREUM_BURN_WRAPPED_ASSET_BUILD as wrappedBuild } from '../../../../shared/src/contracts/tbcEthereumBurnWrappedAsset';
import { sepoliaWrappedMetadata, TURING_TOKEN_TESTNET } from '../../../../shared/src/config/bridgeRoutes';
import useBridgeFtAsset from '../../hooks/useBridgeFtAsset';
import { legacyMetaMask, parseWalletNonce } from '../../services/evmWallet';
import { registerEthereumSepoliaFtRoute } from '../../services/ethereumSepoliaRoute';
import { getV15Roles } from '../../services/v15Multisig';
import type { EvmProvider } from '../../types/evm';
import type { V15OperatorRoles, VerifiedBridgeAsset } from '../../types/learningBridge';
import type { WalletSession } from '../../types/wallet';
import { getErrorMessage } from '../../utils/errors';
import WalletConnection from '../WalletConnection';

const CHAIN_ID = 11_155_111;
const CHAIN_ID_HEX = '0xaa36a7';
const CONFIRMATIONS_REQUIRED = 6;
// Native TBC uses satoshis with six display decimals throughout Turing Wallet
// and the TBC Testnet APIs. The wrapped contract deliberately preserves those
// raw units 1:1, so this value must never be inferred from an EVM default.
const NATIVE_TBC_DECIMALS = 6;
const STORAGE_KEY = 'ethereum-sepolia-burn-admin-v1';
const NATIVE_STORAGE_KEY = 'ethereum-sepolia-burn-native-v1';
const NATIVE_ACTIVATION_STORAGE_KEY = 'ethereum-sepolia-burn-native-activation-v1';
const NATIVE_SOURCE_ASSET_ID = keccak256(stringToHex('tbc/testnet/native-tbc'));
const NATIVE_WRAPPED_SOURCE: WrappedSourceSetup = {
	contractId: NATIVE_SOURCE_ASSET_ID.slice(2), name: 'Native TBC', symbol: 'TBC', decimals: NATIVE_TBC_DECIMALS,
	sourceAssetId: NATIVE_SOURCE_ASSET_ID, sourceAssetKind: 0, wrappedName: 'Wrapped TBC', wrappedSymbol: 'wTBC',
	storageKey: NATIVE_STORAGE_KEY, activationStorageKey: NATIVE_ACTIVATION_STORAGE_KEY,
};
const readAbi = parseAbi([
	'function signer1() view returns (address)',
	'function signer2() view returns (address)',
	'function threshold() view returns (uint256)',
	'function TARGET_CHAIN_ID() view returns (uint256)',
	'function owner() view returns (address)',
	'function minter() view returns (address)',
	'function sourceAssetId() view returns (bytes32)',
	'function sourceDecimals() view returns (uint8)',
	'function sourceAssetKind() view returns (uint8)',
	'function paused() view returns (bool)',
	'function totalSupply() view returns (uint256)',
	'function name() view returns (string)',
	'function symbol() view returns (string)',
]);
type ReadFunction = 'signer1' | 'signer2' | 'threshold' | 'TARGET_CHAIN_ID' | 'owner' | 'minter' | 'sourceAssetId' | 'sourceDecimals' | 'sourceAssetKind' | 'paused' | 'totalSupply' | 'name' | 'symbol';
const activationAbi = parseAbi([
	'function nonce() view returns (uint256)',
	'function action(bytes32) view returns (address target, bytes data, bool executed)',
	'function approved(bytes32,address) view returns (bool)',
	'function propose(address,bytes) returns (bytes32)',
	'function approveAndExecute(bytes32) returns (bytes)',
]);
const wrappedAdminAbi = parseAbi(['function unpause()']);
const UNPAUSE_DATA = encodeFunctionData({ abi: wrappedAdminAbi, functionName: 'unpause' });

interface WalletState { address: string; chainId: number; balanceWei: bigint }
interface Review {
	from: `0x${string}`;
	nonce: bigint;
	predictedAddress: `0x${string}`;
	data: `0x${string}`;
	gas: bigint;
	gasPrice: bigint;
	maximumFeeWei: bigint;
}
interface SavedDeployment {
	txHash: `0x${string}`;
	from: `0x${string}`;
	predictedAddress: `0x${string}`;
}
interface DeploymentStatus extends SavedDeployment {
	status: 'submitted' | 'confirming' | 'verified' | 'reverted' | 'invalid';
	confirmations: number;
	actualFeeWei: bigint | null;
	lastError: string | null;
}
interface ActivationSaved { actionId: `0x${string}`; proposalHash: `0x${string}`; approvalHash?: `0x${string}` }
interface ActivationReview {
	kind: 'propose' | 'approve'; actionId: `0x${string}`; from: `0x${string}`; to: `0x${string}`; nonce: bigint;
	data: `0x${string}`; gas: bigint; gasPrice: bigint; maximumFeeWei: bigint;
}
interface ActivationStatus {
	kind: 'propose' | 'approve'; status: 'submitted' | 'confirming' | 'verified' | 'reverted' | 'invalid';
	confirmations: number; actualFeeWei: bigint | null; lastError: string | null;
}
interface WrappedSourceSetup {
	contractId: string;
	name: string;
	symbol: string;
	decimals: number;
	sourceAssetId: `0x${string}`;
	sourceAssetKind: 0 | 1;
	wrappedName: string;
	wrappedSymbol: string;
	storageKey: string;
	activationStorageKey: string;
}

function hexQuantity(value: unknown, label: string): bigint {
	if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`MetaMask returned an invalid ${label}.`);
	return BigInt(value);
}

function address(value: unknown, label: string): `0x${string}` {
	if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`MetaMask returned an invalid ${label}.`);
	return getAddress(value);
}

function hash(value: unknown, label: string): `0x${string}` {
	if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`MetaMask returned an invalid ${label}.`);
	return value.toLowerCase() as `0x${string}`;
}

function formatEth(value: bigint): string {
	const unit = 10n ** 18n;
	const fraction = (value % unit).toString().padStart(18, '0').slice(0, 8).replace(/0+$/, '');
	if (value > 0n && value < 10n ** 10n) return '<0.00000001';
	return `${value / unit}${fraction ? `.${fraction}` : ''}`;
}

function savedDeployment(key = STORAGE_KEY): SavedDeployment | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
		if (!value || typeof value !== 'object') return null;
		const row = value as Record<string, unknown>;
		return { txHash: hash(row.txHash, 'saved transaction hash'), from: address(row.from, 'saved deployer'), predictedAddress: address(row.predictedAddress, 'saved contract address') };
	} catch { return null; }
}

function savedActivation(storageKey: string): ActivationSaved | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
		if (!value || typeof value !== 'object') return null;
		const row = value as Record<string, unknown>;
		return {
			actionId: hash(row.actionId, 'saved action ID'), proposalHash: hash(row.proposalHash, 'saved proposal hash'),
			...(row.approvalHash ? { approvalHash: hash(row.approvalHash, 'saved approval hash') } : {}),
		};
	} catch { return null; }
}

async function walletState(provider: EvmProvider, requestAccess = false): Promise<WalletState> {
	const accounts = await provider.request({ method: requestAccess ? 'eth_requestAccounts' : 'eth_accounts' });
	if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new Error('Connect the Sepolia deployment account in MetaMask.');
	const selected = address(accounts[0], 'selected account');
	const chainId = Number(hexQuantity(await provider.request({ method: 'eth_chainId' }), 'chain ID'));
	const balanceWei = hexQuantity(await provider.request({ method: 'eth_getBalance', params: [selected, 'latest'] }), 'Sepolia ETH balance');
	return { address: selected, chainId, balanceWei };
}

async function readContract(provider: EvmProvider, contract: `0x${string}`, functionName: ReadFunction) {
	const data = encodeFunctionData({ abi: readAbi, functionName });
	const result = await provider.request({ method: 'eth_call', params: [{ to: contract, data }, 'latest'] });
	if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) throw new Error(`Sepolia returned an invalid ${functionName} result.`);
	return decodeFunctionResult({ abi: readAbi, functionName, data: result as `0x${string}` });
}

async function ethCall(provider: EvmProvider, to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`> {
	const result = await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
	if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) throw new Error('Sepolia returned an invalid contract result.');
	return result as `0x${string}`;
}

async function readAdminNonce(provider: EvmProvider, admin: `0x${string}`): Promise<bigint> {
	const functionName = 'nonce' as const;
	const data = encodeFunctionData({ abi: activationAbi, functionName });
	return decodeFunctionResult({ abi: activationAbi, functionName, data: await ethCall(provider, admin, data) });
}

async function readAdminAction(provider: EvmProvider, admin: `0x${string}`, actionId: `0x${string}`) {
	const functionName = 'action' as const;
	const data = encodeFunctionData({ abi: activationAbi, functionName, args: [actionId] });
	return decodeFunctionResult({ abi: activationAbi, functionName, data: await ethCall(provider, admin, data) });
}

async function readAdminApproval(provider: EvmProvider, admin: `0x${string}`, actionId: `0x${string}`, signer: `0x${string}`): Promise<boolean> {
	const functionName = 'approved' as const;
	const data = encodeFunctionData({ abi: activationAbi, functionName, args: [actionId, signer] });
	return decodeFunctionResult({ abi: activationAbi, functionName, data: await ethCall(provider, admin, data) });
}

function EthereumWrappedActivation({ provider, roles, admin, wrapped, wallet, storageKey, sourceLabel, wrappedLabel, onActive }: {
	provider: EvmProvider; roles: V15OperatorRoles; admin: `0x${string}`; wrapped: `0x${string}`; wallet: WalletState | null;
	storageKey: string; sourceLabel: string; wrappedLabel: string; onActive?: () => void;
}) {
	const [saved, setSaved] = useState<ActivationSaved | null>(null);
	const [review, setReview] = useState<ActivationReview | null>(null);
	const [status, setStatus] = useState<ActivationStatus | null>(null);
	const [active, setActive] = useState(false);
	const [checked, setChecked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const poll = useRef(false);

	async function checkActivation(nextSaved: ActivationSaved, kind: 'propose' | 'approve'): Promise<ActivationStatus> {
		const txHash = kind === 'approve' ? nextSaved.approvalHash! : nextSaved.proposalHash;
		const receiptValue = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
		if (receiptValue === null) return { kind, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null };
		if (!receiptValue || typeof receiptValue !== 'object') throw new Error('Sepolia returned an invalid activation receipt.');
		const receipt = receiptValue as Record<string, unknown>;
		if (hexQuantity(receipt.status, 'activation receipt status') !== 1n) return { kind, status: 'reverted', confirmations: 0, actualFeeWei: null, lastError: `The Signer ${kind === 'propose' ? '1 proposal' : '2 approval'} reverted.` };
		const blockNumber = hexQuantity(receipt.blockNumber, 'activation receipt block number');
		const head = hexQuantity(await provider.request({ method: 'eth_blockNumber' }), 'latest block number');
		const confirmations = Number(head >= blockNumber ? head - blockNumber + 1n : 0n);
		const gasUsed = hexQuantity(receipt.gasUsed, 'activation gas used');
		const gasPrice = receipt.effectiveGasPrice ? hexQuantity(receipt.effectiveGasPrice, 'activation effective gas price') : 0n;
		const base = { kind, confirmations, actualFeeWei: gasUsed * gasPrice };
		if (confirmations < CONFIRMATIONS_REQUIRED) return { ...base, status: 'confirming', lastError: null };
		const [action, signer1Approved, signer2Approved, paused] = await Promise.all([
			readAdminAction(provider, admin, nextSaved.actionId),
			readAdminApproval(provider, admin, nextSaved.actionId, roles.signer1 as `0x${string}`),
			readAdminApproval(provider, admin, nextSaved.actionId, roles.signer2 as `0x${string}`),
			readContract(provider, wrapped, 'paused'),
		]);
		const [target, data, executed] = action;
		if (target.toLowerCase() !== wrapped.toLowerCase() || data.toLowerCase() !== UNPAUSE_DATA.toLowerCase()) return { ...base, status: 'invalid', lastError: `The saved Admin action does not contain the exact reviewed ${wrappedLabel} unpause call.` };
		if (kind === 'propose' && (!signer1Approved || executed || paused !== true)) return { ...base, status: 'invalid', lastError: 'The proposal approval, execution or wrapped-token pause state is inconsistent.' };
		if (kind === 'approve' && (!signer1Approved || !signer2Approved || !executed || paused !== false)) return { ...base, status: 'invalid', lastError: 'The 2-of-2 approval did not execute the exact unpause call.' };
		if (kind === 'approve') { setActive(true); onActive?.(); }
		return { ...base, status: 'verified', lastError: null };
	}

	useEffect(() => {
		let cancelled = false;
		setReview(null); setChecked(false); setError('');
		void (async () => {
			try {
				const paused = await readContract(provider, wrapped, 'paused');
				if (cancelled) return;
				if (paused === false) { setActive(true); onActive?.(); return; }
				const stored = savedActivation(storageKey);
				setSaved(stored);
				if (stored) setStatus({ kind: stored.approvalHash ? 'approve' : 'propose', status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null });
			} catch (cause) { if (!cancelled) setError(getErrorMessage(cause)); }
		})();
		return () => { cancelled = true; };
	}, [admin, wrapped, storageKey]);

	useEffect(() => {
		if (!saved || !status || !['submitted', 'confirming'].includes(status.status) || poll.current) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		poll.current = true;
		void (async () => {
			try {
				for (let attempt = 0; attempt < 120 && !stopped; attempt++) {
					if (attempt) await new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); });
					if (stopped) break;
					const next = await checkActivation(saved, status.kind);
					if (!stopped) setStatus(next);
					if (!['submitted', 'confirming'].includes(next.status)) break;
				}
			} catch (cause) { if (!stopped) setError(getErrorMessage(cause)); }
			finally { poll.current = false; }
		})();
		return () => { stopped = true; clearTimeout(timer); poll.current = false; };
	}, [saved?.actionId, saved?.proposalHash, saved?.approvalHash, status?.kind, status?.status]);

	async function prepare(kind: 'propose' | 'approve') {
		if (busy) return;
		setBusy(true); setError(''); setReview(null); setChecked(false);
		try {
			let current = await walletState(provider, true);
			if (current.chainId !== CHAIN_ID) {
				await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
				current = await walletState(provider);
			}
			const required = address(kind === 'propose' ? roles.signer1 : roles.signer2, `Signer ${kind === 'propose' ? '1' : '2'}`);
			if (current.address.toLowerCase() !== required.toLowerCase()) throw new Error(`Select the required Signer ${kind === 'propose' ? '1' : '2'} account ${required} in MetaMask first.`);
			let actionId: `0x${string}`;
			let data: `0x${string}`;
			if (kind === 'propose') {
				const actionNonce = await readAdminNonce(provider, admin);
				actionId = keccak256(encodeAbiParameters(
					[{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
					[BigInt(CHAIN_ID), admin, actionNonce, wrapped, keccak256(UNPAUSE_DATA)],
				));
				data = encodeFunctionData({ abi: activationAbi, functionName: 'propose', args: [wrapped, UNPAUSE_DATA] });
			} else {
				if (!saved || status?.kind !== 'propose' || status.status !== 'verified') throw new Error('Wait until the Signer 1 proposal is verified first.');
				actionId = saved.actionId;
				const [target, actionData, executed] = await readAdminAction(provider, admin, actionId);
				if (target.toLowerCase() !== wrapped.toLowerCase() || actionData.toLowerCase() !== UNPAUSE_DATA.toLowerCase() || executed) throw new Error(`The saved proposal is not the pending reviewed ${wrappedLabel} unpause action.`);
				data = encodeFunctionData({ abi: activationAbi, functionName: 'approveAndExecute', args: [actionId] });
			}
			const nonce = parseWalletNonce(await provider.request({ method: 'eth_getTransactionCount', params: [required, 'pending'] }));
			const estimated = hexQuantity(await provider.request({ method: 'eth_estimateGas', params: [{ from: required, to: admin, data, value: '0x0' }] }), 'activation gas estimate');
			const gas = estimated * 120n / 100n;
			const gasPrice = hexQuantity(await provider.request({ method: 'eth_gasPrice' }), 'activation gas price');
			const maximumFeeWei = gas * gasPrice;
			if (current.balanceWei < maximumFeeWei) throw new Error(`Signer ${kind === 'propose' ? '1' : '2'} needs up to ${formatEth(maximumFeeWei)} SepoliaETH; this account has ${formatEth(current.balanceWei)}.`);
			setReview({ kind, actionId, from: required, to: admin, nonce, data, gas, gasPrice, maximumFeeWei });
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	async function send() {
		if (!review || !checked || busy) return;
		setBusy(true); setError('');
		try {
			const current = await walletState(provider);
			const nonce = parseWalletNonce(await provider.request({ method: 'eth_getTransactionCount', params: [review.from, 'pending'] }));
			if (current.chainId !== CHAIN_ID || current.address.toLowerCase() !== review.from.toLowerCase() || nonce !== review.nonce) throw new Error('The selected signer, network or pending nonce changed. Prepare the activation step again.');
			const txHash = hash(await provider.request({ method: 'eth_sendTransaction', params: [{ from: review.from, to: review.to, chainId: CHAIN_ID_HEX, data: review.data, value: '0x0', gas: toHex(review.gas), gasPrice: toHex(review.gasPrice), nonce: toHex(review.nonce) }] }), 'activation transaction hash');
			const next: ActivationSaved = review.kind === 'propose'
				? { actionId: review.actionId, proposalHash: txHash }
				: { actionId: review.actionId, proposalHash: saved!.proposalHash, approvalHash: txHash };
			localStorage.setItem(storageKey, JSON.stringify(next));
			setSaved(next); setStatus({ kind: review.kind, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null });
			setReview(null); setChecked(false);
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	const proposalVerified = saved && status?.kind === 'propose' && status.status === 'verified';
	const failed = status && ['reverted', 'invalid'].includes(status.status);
	const requiredSigner = proposalVerified ? roles.signer2 : roles.signer1;

	return <section className="htlc-section" aria-labelledby={`ethereum-${storageKey}-activation-title`}>
		<h4 id={`ethereum-${storageKey}-activation-title`}>3. One-time 2-of-2 route activation</h4>
		{active ? <p className="result success"><strong>{sourceLabel} route active.</strong> {wrappedLabel} is unpaused and ready for verified deposit mint instructions.</p> : <>
			<p>Signer 1 proposes only the exact <code>unpause()</code> call. After 6 confirmations, Signer 2 approves and executes that same action. Neither signer receives mint authority.</p>
			<dl className="history-detail-grid"><div><dt>{wrappedLabel}</dt><dd><code>{wrapped}</code></dd></div><div><dt>Admin multisig</dt><dd><code>{admin}</code></dd></div><div><dt>Step 1 · Signer 1</dt><dd><code>{roles.signer1}</code></dd></div><div><dt>Step 2 · Signer 2</dt><dd><code>{roles.signer2}</code></dd></div></dl>
			{status && <p className={`result ${status.status === 'verified' ? 'success' : failed ? 'error' : 'warning'}`}><strong>{status.kind === 'propose' ? 'Signer 1 proposal' : 'Signer 2 approval'}: {status.status}.</strong> {status.confirmations} / {CONFIRMATIONS_REQUIRED} confirmations.{status.actualFeeWei !== null && <> Actual fee: {formatEth(status.actualFeeWei)} SepoliaETH.</>}{status.lastError && <> {status.lastError}</>}</p>}
			{!saved && !review && <button type="button" disabled={busy} onClick={() => { void prepare('propose'); }}>Prepare Signer 1 proposal</button>}
			{proposalVerified && !review && <button type="button" disabled={busy} onClick={() => { void prepare('approve'); }}>Prepare Signer 2 approval</button>}
			{review && <section className="bridge-deployment-review"><h4>{review.kind === 'propose' ? 'Review Signer 1 proposal' : 'Review Signer 2 approval and execution'}</h4><dl className="history-detail-grid"><div><dt>Required account</dt><dd><code>{review.from}</code></dd></div><div><dt>Admin target</dt><dd><code>{review.to}</code></dd></div><div><dt>Action ID</dt><dd><code>{review.actionId}</code></dd></div><div><dt>Maximum reviewed gas budget</dt><dd>{formatEth(review.maximumFeeWei)} SepoliaETH</dd></div></dl><label className="bridge-role-choice"><input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.target.checked)} /> I checked the required signer, {wrappedLabel} target, exact unpause action and gas budget.</label><div><button type="button" disabled={!checked || busy} onClick={() => { void send(); }}>Confirm {review.kind} in MetaMask</button> <button type="button" className="history-secondary" disabled={busy} onClick={() => { setReview(null); setChecked(false); }}>Cancel review</button></div></section>}
			{!review && <p className="history-note">Next required MetaMask account: <code>{requiredSigner}</code>. Selected: <code>{wallet?.address ?? 'not connected'}</code>.</p>}
			{failed && <button type="button" className="history-secondary" onClick={() => { localStorage.removeItem(storageKey); setSaved(null); setStatus(null); setReview(null); setChecked(false); setError(''); }}>Clear failed activation and retry</button>}
		</>}
		{error && <p className="result error" role="alert">{error}</p>}
	</section>;
}

function EthereumWrappedSetup({ provider, roles, admin, wallet, source, onActive }: {
	provider: EvmProvider; roles: V15OperatorRoles; admin: `0x${string}`; wallet: WalletState | null; source: WrappedSourceSetup;
	onActive?: (deployment: DeploymentStatus) => void;
}) {
	const [review, setReview] = useState<Review | null>(null);
	const [status, setStatus] = useState<DeploymentStatus | null>(null);
	const [checked, setChecked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const poll = useRef(false);

	useEffect(() => {
		const saved = savedDeployment(source.storageKey);
		if (saved) setStatus({ ...saved, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null });
	}, [admin, source.storageKey]);

	async function checkDeployment(saved: SavedDeployment): Promise<DeploymentStatus> {
		const receiptValue = await provider.request({ method: 'eth_getTransactionReceipt', params: [saved.txHash] });
		if (receiptValue === null) return { ...saved, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null };
		if (!receiptValue || typeof receiptValue !== 'object') throw new Error('Sepolia returned an invalid wrapped-token deployment receipt.');
		const receipt = receiptValue as Record<string, unknown>;
		if (hexQuantity(receipt.status, 'receipt status') !== 1n) return { ...saved, status: 'reverted', confirmations: 0, actualFeeWei: null, lastError: `The ${source.wrappedName} deployment reverted.` };
		const contractAddress = address(receipt.contractAddress, 'deployed contract address');
		if (contractAddress.toLowerCase() !== saved.predictedAddress.toLowerCase()) return { ...saved, status: 'invalid', confirmations: 0, actualFeeWei: null, lastError: 'Sepolia created a different wrapped-token address than the reviewed deployment.' };
		const blockNumber = hexQuantity(receipt.blockNumber, 'receipt block number');
		const head = hexQuantity(await provider.request({ method: 'eth_blockNumber' }), 'latest block number');
		const confirmations = Number(head >= blockNumber ? head - blockNumber + 1n : 0n);
		const gasUsed = hexQuantity(receipt.gasUsed, 'gas used');
		const gasPrice = receipt.effectiveGasPrice ? hexQuantity(receipt.effectiveGasPrice, 'effective gas price') : 0n;
		const base = { ...saved, confirmations, actualFeeWei: gasUsed * gasPrice };
		if (confirmations < CONFIRMATIONS_REQUIRED) return { ...base, status: 'confirming' as const, lastError: null };
		const code = await provider.request({ method: 'eth_getCode', params: [contractAddress, 'latest'] });
		if (typeof code !== 'string' || code === '0x') return { ...base, status: 'invalid', lastError: `No contract bytecode exists at the reviewed ${source.wrappedName} address.` };
		const [owner, minter, sourceId, decimals, kind, paused, supply, targetChain, name, symbol] = await Promise.all([
			readContract(provider, contractAddress, 'owner'), readContract(provider, contractAddress, 'minter'),
			readContract(provider, contractAddress, 'sourceAssetId'), readContract(provider, contractAddress, 'sourceDecimals'),
			readContract(provider, contractAddress, 'sourceAssetKind'), readContract(provider, contractAddress, 'paused'),
			readContract(provider, contractAddress, 'totalSupply'), readContract(provider, contractAddress, 'TARGET_CHAIN_ID'),
			readContract(provider, contractAddress, 'name'), readContract(provider, contractAddress, 'symbol'),
		]);
		if (String(owner).toLowerCase() !== admin.toLowerCase() || String(minter).toLowerCase() !== roles.minter.toLowerCase()
			|| String(sourceId).toLowerCase() !== source.sourceAssetId.toLowerCase() || decimals !== source.decimals || kind !== source.sourceAssetKind
			|| paused !== true || supply !== 0n || targetChain !== BigInt(CHAIN_ID) || name !== source.wrappedName || symbol !== source.wrappedSymbol) {
			return { ...base, status: 'invalid', lastError: decimals !== source.decimals
				? `This wrapped contract uses ${String(decimals)} decimals, but ${source.symbol} uses ${source.decimals}. Do not deposit to this route; deploy the corrected zero-supply contract below.`
				: `The wrapped contract does not match the reviewed Admin, minter, ${source.symbol} binding, precision, paused state or zero supply.` };
		}
		return { ...base, status: 'verified', lastError: null };
	}

	useEffect(() => {
		if (!status || !['submitted', 'confirming'].includes(status.status) || poll.current) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		poll.current = true;
		void (async () => {
			try {
				for (let attempt = 0; attempt < 120 && !stopped; attempt++) {
					if (attempt) await new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); });
					if (stopped) break;
					const next = await checkDeployment(status);
					if (!stopped) setStatus(next);
					if (!['submitted', 'confirming'].includes(next.status)) break;
				}
			} catch (cause) { if (!stopped) setError(getErrorMessage(cause)); }
			finally { poll.current = false; }
		})();
		return () => { stopped = true; clearTimeout(timer); poll.current = false; };
	}, [status?.txHash, status?.status, source.contractId]);

	async function prepare() {
		if (busy) return;
		setBusy(true); setError(''); setReview(null); setChecked(false);
		try {
			let current = await walletState(provider, true);
			if (current.chainId !== CHAIN_ID) {
				await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
				current = await walletState(provider);
			}
			if (current.chainId !== CHAIN_ID) throw new Error(`MetaMask is on chain ${current.chainId}; select Sepolia (${CHAIN_ID}) first.`);
			const from = address(current.address, 'deployment account');
			const data = encodeDeployData({ abi: wrappedBuild.abi, bytecode: wrappedBuild.bytecode, args: [admin, roles.minter as `0x${string}`, source.sourceAssetId, source.decimals, source.sourceAssetKind, source.wrappedName, source.wrappedSymbol] });
			const nonce = parseWalletNonce(await provider.request({ method: 'eth_getTransactionCount', params: [from, 'pending'] }));
			const estimated = hexQuantity(await provider.request({ method: 'eth_estimateGas', params: [{ from, data, value: '0x0' }] }), 'gas estimate');
			const gas = estimated * 120n / 100n;
			const gasPrice = hexQuantity(await provider.request({ method: 'eth_gasPrice' }), 'gas price');
			const maximumFeeWei = gas * gasPrice;
			if (current.balanceWei < maximumFeeWei) throw new Error(`The deployment needs up to ${formatEth(maximumFeeWei)} SepoliaETH; this account has ${formatEth(current.balanceWei)}.`);
			setReview({ from, nonce, predictedAddress: getContractAddress({ from, nonce }), data, gas, gasPrice, maximumFeeWei });
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	async function deploy() {
		if (!review || !checked || busy) return;
		setBusy(true); setError('');
		try {
			const current = await walletState(provider);
			const nonce = parseWalletNonce(await provider.request({ method: 'eth_getTransactionCount', params: [review.from, 'pending'] }));
			if (current.chainId !== CHAIN_ID || current.address.toLowerCase() !== review.from.toLowerCase() || nonce !== review.nonce) throw new Error('The selected account, network or pending nonce changed. Prepare the wrapped-token deployment again.');
			const txHash = hash(await provider.request({ method: 'eth_sendTransaction', params: [{ from: review.from, chainId: CHAIN_ID_HEX, data: review.data, value: '0x0', gas: toHex(review.gas), gasPrice: toHex(review.gasPrice), nonce: toHex(review.nonce) }] }), 'wrapped-token deployment transaction hash');
			const saved = { txHash, from: review.from, predictedAddress: review.predictedAddress };
			localStorage.setItem(source.storageKey, JSON.stringify(saved));
			// An Admin action is bound to one exact target contract. A replacement
			// token must never reuse the saved proposal for the prior deployment.
			localStorage.removeItem(source.activationStorageKey);
			setStatus({ ...saved, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null });
			setReview(null); setChecked(false);
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	return <section className="bridge-deployment-review" aria-labelledby={`ethereum-${source.contractId}-wrapped-title`}>
		<header className="history-titlebar"><div><h4 id={`ethereum-${source.contractId}-wrapped-title`}>2. Deploy {source.symbol} wrapped token</h4><p>Deploy a paused, zero-supply {source.wrappedName} contract controlled by the verified Admin multisig.</p></div><span className="network-pill">{source.symbol} → {source.wrappedSymbol}</span></header>
		<dl className="history-detail-grid">
			<div><dt>Owner</dt><dd><code>{admin}</code></dd></div><div><dt>Mint-only relayer</dt><dd><code>{roles.minter}</code></dd></div>
			<div><dt>Source asset</dt><dd>{source.name} ({source.symbol}) · {source.decimals} decimals</dd></div><div><dt>Wrapped asset</dt><dd>{source.wrappedName} ({source.wrappedSymbol})</dd></div>
			<div><dt>Source binding</dt><dd><code>{source.sourceAssetId}</code></dd></div><div><dt>Initial state</dt><dd>Paused · supply 0</dd></div>
		</dl>
		{!status && !review && <button type="button" disabled={busy} onClick={() => { void prepare(); }}>{busy ? `Preparing ${source.wrappedName}…` : `Prepare ${source.wrappedName} deployment`}</button>}
		{review && <div>
			<h4>Review {source.wrappedName} deployment</h4>
			<dl className="history-detail-grid"><div><dt>Deployment payer</dt><dd><code>{review.from}</code></dd></div><div><dt>Predicted token contract</dt><dd><code>{review.predictedAddress}</code></dd></div><div><dt>Maximum reviewed gas budget</dt><dd>{formatEth(review.maximumFeeWei)} SepoliaETH</dd></div><div><dt>Value transferred</dt><dd>0 SepoliaETH</dd></div></dl>
			<label className="bridge-role-choice"><input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.target.checked)} /> I checked the Admin owner, mint-only relayer, {source.symbol} Contract ID, token metadata and gas budget.</label>
			<div><button type="button" disabled={!checked || busy} onClick={() => { void deploy(); }}>{busy ? 'Waiting for MetaMask…' : `Confirm ${source.wrappedName} deployment`}</button> <button type="button" className="history-secondary" disabled={busy} onClick={() => { setReview(null); setChecked(false); }}>Cancel review</button></div>
		</div>}
		{status && <p className={`result ${status.status === 'verified' ? 'success' : ['reverted', 'invalid'].includes(status.status) ? 'error' : 'warning'}`}><strong>{status.status === 'verified' ? `${source.wrappedName} contract verified.` : status.status === 'confirming' ? `${source.wrappedName} deployment confirming.` : status.status === 'submitted' ? `${source.wrappedName} deployment submitted.` : `${source.wrappedName} deployment failed.`}</strong>{' '}Contract: <code>{status.predictedAddress}</code>. {status.confirmations} / {CONFIRMATIONS_REQUIRED} confirmations.{status.actualFeeWei !== null && <> Actual fee: {formatEth(status.actualFeeWei)} SepoliaETH.</>}</p>}
		{status?.lastError && <p className="result error" role="alert">{status.lastError}</p>}
		{status && ['reverted', 'invalid'].includes(status.status) && <button type="button" className="history-secondary" onClick={() => { localStorage.removeItem(source.storageKey); setStatus(null); setError(''); }}>Discard failed wrapped-token deployment</button>}
		{status?.status === 'verified' && <p className="result warning">The token is intentionally paused. The next step is one-time 2-of-2 route activation; do not mint until both Admin signers complete it.</p>}
		{error && <p className="result error" role="alert">{error}</p>}
		{status?.status === 'verified' && <EthereumWrappedActivation provider={provider} roles={roles} admin={admin} wrapped={status.predictedAddress} wallet={wallet}
			storageKey={source.activationStorageKey} sourceLabel={source.symbol} wrappedLabel={source.wrappedName} onActive={() => onActive?.(status)} />}
	</section>;
}

function EthereumFtRoutes({ session, active, provider, roles, admin, wallet }: {
	session: WalletSession; active: boolean; provider: EvmProvider; roles: V15OperatorRoles; admin: `0x${string}`; wallet: WalletState | null;
}) {
	const source = useBridgeFtAsset(session, active);
	const loadedWallet = useRef('');
	const verifiedSource = useRef('');
	const registering = useRef('');
	const [routeMessage, setRouteMessage] = useState('');
	const [routeError, setRouteError] = useState('');

	useEffect(() => {
		const owner = active && source.ready ? `${session.address}:${session.backendAuth.ready ? 'authenticated' : 'connecting'}` : '';
		if (!owner || loadedWallet.current === owner) return;
		loadedWallet.current = owner; verifiedSource.current = ''; void source.loadTokens();
	}, [active, session.address, session.backendAuth.ready, source.ready]);

	useEffect(() => {
		if (source.loading || source.selected || source.tokens.length !== 1) return;
		void source.select(source.tokens[0].contract_id);
	}, [source.loading, source.selected, source.tokens]);

	useEffect(() => {
		const contractId = source.selected?.contractId ?? '';
		if (!contractId || source.loading || source.verified || source.error || !session.backendAuth.ready || verifiedSource.current === contractId) return;
		verifiedSource.current = contractId; void source.verify();
	}, [session.backendAuth.ready, source.error, source.loading, source.selected, source.verified]);

	async function registerRoute(deployment: DeploymentStatus, asset: VerifiedBridgeAsset) {
		const key = `${asset.contractId}:${deployment.txHash}`;
		if (registering.current === key) return;
		registering.current = key; setRouteMessage(''); setRouteError('');
		try {
			const route = await registerEthereumSepoliaFtRoute(asset.contractId, deployment.predictedAddress, deployment.txHash, AbortSignal.timeout(110_000));
			setRouteMessage(`${route.sourceName} (${route.sourceSymbol}) → ${route.wrappedName} (${route.wrappedSymbol}) is registered and active on Ethereum Sepolia.`);
		} catch (cause) {
			registering.current = '';
			setRouteError(getErrorMessage(cause));
		}
	}

	const selectedId = source.selected?.contractId ?? '';
	const verified = source.verified;
	let setup: WrappedSourceSetup | null = null;
	if (verified) {
		const metadata = sepoliaWrappedMetadata(verified.name, verified.symbol);
		setup = {
			contractId: verified.contractId, name: verified.name, symbol: verified.symbol, decimals: verified.decimals,
			sourceAssetId: `0x${verified.contractId}`, sourceAssetKind: 1, ...metadata,
			storageKey: `ethereum-sepolia-burn-ft-${verified.contractId}-v1`,
			activationStorageKey: `ethereum-sepolia-burn-ft-${verified.contractId}-activation-v1`,
		};
	}

	return <section className="htlc-section" aria-labelledby="ethereum-ft-routes-title" aria-busy={source.loading}>
		<header className="history-titlebar"><div><h3 id="ethereum-ft-routes-title">TBC fungible-token routes</h3><p>Select Turing Token or another verified TBC FT. Each source token receives its own Sepolia wrapped contract and independent burn-return accounting.</p></div><span className="network-pill">FT → wrapped FT</span></header>
		{(!source.ready || !session.backendAuth.ready) && <div className="result warning">
			<p><strong>Turing Wallet connection required.</strong> Connect or reconnect the wallet on TBC Testnet. The TT selector remains available while login completes; verification starts after authentication.</p>
			<WalletConnection session={session} />
		</div>}
		<label htmlFor="sepolia-ft-source-token">Source token for this Sepolia route</label>
		<select id="sepolia-ft-source-token" value={selectedId} disabled={!source.ready || source.loading}
			onChange={(event) => { setRouteMessage(''); setRouteError(''); verifiedSource.current = ''; if (event.target.value) void source.select(event.target.value); }}>
			<option value="">Choose a TBC Testnet FT</option>
			<option value={TURING_TOKEN_TESTNET.contractId}>{TURING_TOKEN_TESTNET.name} ({TURING_TOKEN_TESTNET.symbol}) · {TURING_TOKEN_TESTNET.contractId.slice(0, 8)}…{TURING_TOKEN_TESTNET.contractId.slice(-6)}</option>
			{source.tokens.filter((token) => token.contract_id !== TURING_TOKEN_TESTNET.contractId).map((token) => <option key={token.contract_id} value={token.contract_id}>{token.name || 'Unnamed FT'} ({token.symbol || 'FT'}) · {token.contract_id.slice(0, 8)}…{token.contract_id.slice(-6)}</option>)}
		</select>
		{!source.ready && <p className="history-feedback">The selector is disabled until Turing Wallet reports a TBC Testnet account.</p>}
		{source.loading && <p className="history-feedback" role="status">Loading or verifying the selected TBC token…</p>}
		{source.verified && <p className="result success">{source.verified.name} ({source.verified.symbol}) verified with {source.verified.confirmations.toLocaleString()} source confirmations and {source.verified.decimals} decimals.</p>}
		{source.error && <><p className="result error" role="alert">{source.error}</p><button type="button" className="history-secondary" disabled={source.loading} onClick={() => {
			if (source.selected) { verifiedSource.current = ''; void source.verify(); } else { loadedWallet.current = ''; void source.loadTokens(); }
		}}>Retry token verification</button></>}
		{routeMessage && <p className="result success" role="status">{routeMessage}</p>}
		{routeError && <p className="result error" role="alert">{routeError}</p>}
		{verified && setup && <EthereumWrappedSetup key={verified.contractId} provider={provider} roles={roles} admin={admin} wallet={wallet} source={setup}
			onActive={(deployment) => { void registerRoute(deployment, verified); }} />}
	</section>;
}

export default function EthereumBurnAdminSetup({ session, active }: { session: WalletSession; active: boolean }) {
	const [provider, setProvider] = useState<EvmProvider | null>(null);
	const [roles, setRoles] = useState<V15OperatorRoles | null>(null);
	const [wallet, setWallet] = useState<WalletState | null>(null);
	const [review, setReview] = useState<Review | null>(null);
	const [status, setStatus] = useState<DeploymentStatus | null>(null);
	const [checked, setChecked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const poll = useRef(false);

	async function refreshWallet(target = provider) {
		if (!target) return;
		try { setWallet(await walletState(target)); }
		catch (cause) { setError(getErrorMessage(cause)); }
	}

	async function switchToSepolia() {
		if (!provider || busy) return;
		setBusy(true); setError(''); setReview(null); setChecked(false);
		try {
			await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
			setWallet(await walletState(provider));
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	useEffect(() => {
		if (!active) return;
		const next = legacyMetaMask();
		setProvider(next);
		if (!next) { setError('MetaMask was not detected.'); return; }
		const changed = () => { setReview(null); setChecked(false); void refreshWallet(next); };
		next.on('accountsChanged', changed);
		next.on('chainChanged', changed);
		void refreshWallet(next);
		return () => { next.removeListener('accountsChanged', changed); next.removeListener('chainChanged', changed); };
	}, [active]);

	useEffect(() => {
		const controller = new AbortController();
		setRoles(null);
		if (!active || !session.backendAuth.ready) return () => controller.abort();
		void getV15Roles(controller.signal).then((value) => { if (!controller.signal.aborted) setRoles(value); })
			.catch((cause) => { if (!controller.signal.aborted) setError(getErrorMessage(cause)); });
		const saved = savedDeployment();
		if (saved) setStatus({ ...saved, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null });
		return () => controller.abort();
	}, [active, session.address, session.backendAuth.ready]);

	async function checkDeployment(saved: SavedDeployment): Promise<DeploymentStatus> {
		if (!provider) throw new Error('MetaMask is unavailable.');
		const receiptValue = await provider.request({ method: 'eth_getTransactionReceipt', params: [saved.txHash] });
		if (receiptValue === null) return { ...saved, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null };
		if (!receiptValue || typeof receiptValue !== 'object') throw new Error('Sepolia returned an invalid deployment receipt.');
		const receipt = receiptValue as Record<string, unknown>;
		if (hexQuantity(receipt.status, 'receipt status') !== 1n) return { ...saved, status: 'reverted', confirmations: 0, actualFeeWei: null, lastError: 'The Sepolia deployment reverted.' };
		const contractAddress = address(receipt.contractAddress, 'deployed contract address');
		if (contractAddress.toLowerCase() !== saved.predictedAddress.toLowerCase()) return { ...saved, status: 'invalid', confirmations: 0, actualFeeWei: null, lastError: 'Sepolia created a different contract address than the reviewed deployment.' };
		const blockNumber = hexQuantity(receipt.blockNumber, 'receipt block number');
		const head = hexQuantity(await provider.request({ method: 'eth_blockNumber' }), 'latest block number');
		const confirmations = Number(head >= blockNumber ? head - blockNumber + 1n : 0n);
		const gasUsed = hexQuantity(receipt.gasUsed, 'gas used');
		const gasPrice = receipt.effectiveGasPrice ? hexQuantity(receipt.effectiveGasPrice, 'effective gas price') : 0n;
		const base = { ...saved, confirmations, actualFeeWei: gasUsed * gasPrice };
		if (confirmations < CONFIRMATIONS_REQUIRED) return { ...base, status: 'confirming' as const, lastError: null };
		const code = await provider.request({ method: 'eth_getCode', params: [contractAddress, 'latest'] });
		if (typeof code !== 'string' || code === '0x') return { ...base, status: 'invalid', lastError: 'No contract bytecode exists at the reviewed Sepolia address.' };
		if (!roles) return { ...base, status: 'confirming', lastError: 'Waiting for the configured signer roles.' };
		const [signer1, signer2, threshold, targetChain] = await Promise.all([
			readContract(provider, contractAddress, 'signer1'), readContract(provider, contractAddress, 'signer2'),
			readContract(provider, contractAddress, 'threshold'), readContract(provider, contractAddress, 'TARGET_CHAIN_ID'),
		]);
		if (String(signer1).toLowerCase() !== roles.signer1.toLowerCase() || String(signer2).toLowerCase() !== roles.signer2.toLowerCase() || threshold !== 2n || targetChain !== BigInt(CHAIN_ID)) {
			return { ...base, status: 'invalid', lastError: 'The deployed contract does not contain the configured 2-of-2 Sepolia roles.' };
		}
		return { ...base, status: 'verified', lastError: null };
	}

	useEffect(() => {
		if (!active || !provider || !roles || !status || !['submitted', 'confirming'].includes(status.status) || poll.current) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		poll.current = true;
		void (async () => {
			try {
				for (let attempt = 0; attempt < 120 && !stopped; attempt++) {
					if (attempt) await new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); });
					if (stopped) break;
					const next = await checkDeployment(status);
					if (!stopped) setStatus(next);
					if (!['submitted', 'confirming'].includes(next.status)) break;
				}
			} catch (cause) { if (!stopped) setError(getErrorMessage(cause)); }
			finally { poll.current = false; }
		})();
		return () => { stopped = true; clearTimeout(timer); poll.current = false; };
	}, [active, provider, roles, status?.txHash, status?.status]);

	async function prepare() {
		if (!provider || !roles || busy) return;
		setBusy(true); setError(''); setReview(null); setChecked(false);
		try {
			let current = await walletState(provider, true);
			if (current.chainId !== CHAIN_ID) {
				await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
				current = await walletState(provider);
			}
			setWallet(current);
			if (current.chainId !== CHAIN_ID) throw new Error(`MetaMask is on chain ${current.chainId}; select Sepolia (${CHAIN_ID}) first.`);
			const from = address(current.address, 'deployment account');
			const data = encodeDeployData({ abi: build.abi, bytecode: build.bytecode, args: [roles.signer1 as `0x${string}`, roles.signer2 as `0x${string}`] });
			const nonce = parseWalletNonce(await provider.request({ method: 'eth_getTransactionCount', params: [from, 'pending'] }));
			const estimated = hexQuantity(await provider.request({ method: 'eth_estimateGas', params: [{ from, data, value: '0x0' }] }), 'gas estimate');
			const gas = estimated * 120n / 100n;
			const gasPrice = hexQuantity(await provider.request({ method: 'eth_gasPrice' }), 'gas price');
			const maximumFeeWei = gas * gasPrice;
			if (current.balanceWei < maximumFeeWei) throw new Error(`The deployment needs up to ${formatEth(maximumFeeWei)} SepoliaETH; this account has ${formatEth(current.balanceWei)}.`);
			setReview({ from, nonce, predictedAddress: getContractAddress({ from, nonce }), data, gas, gasPrice, maximumFeeWei });
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	async function deploy() {
		if (!provider || !review || !checked || busy) return;
		setBusy(true); setError('');
		try {
			const current = await walletState(provider);
			const nonce = parseWalletNonce(await provider.request({ method: 'eth_getTransactionCount', params: [review.from, 'pending'] }));
			if (current.chainId !== CHAIN_ID || current.address.toLowerCase() !== review.from.toLowerCase() || nonce !== review.nonce) throw new Error('The selected account, network or pending nonce changed. Prepare the deployment again.');
			const txHash = hash(await provider.request({ method: 'eth_sendTransaction', params: [{ from: review.from, chainId: CHAIN_ID_HEX, data: review.data, value: '0x0', gas: toHex(review.gas), gasPrice: toHex(review.gasPrice), nonce: toHex(review.nonce) }] }), 'deployment transaction hash');
			const saved = { txHash, from: review.from, predictedAddress: review.predictedAddress };
			localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
			setStatus({ ...saved, status: 'submitted', confirmations: 0, actualFeeWei: null, lastError: null });
			setReview(null); setChecked(false);
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	return <section className="htlc-section bridge-deployment" aria-labelledby="ethereum-burn-admin-title">
		<header className="history-titlebar"><div><h3 id="ethereum-burn-admin-title">Ethereum Sepolia burn bridge</h3><p>Deploy the shared 2-of-2 administrator first. Wrapped assets and route activation are separate later steps.</p></div><span className="network-pill">Sepolia · burn return</span></header>
		<dl className="history-detail-grid">
			<div><dt>Destination</dt><dd>Ethereum Sepolia · chain {CHAIN_ID}</dd></div>
			<div><dt>Selected deployment wallet</dt><dd><code>{wallet?.address || 'Connect MetaMask'}</code></dd></div>
			<div><dt>Signer 1</dt><dd><code>{roles?.signer1 || 'Loading configured role…'}</code></dd></div>
			<div><dt>Signer 2</dt><dd><code>{roles?.signer2 || 'Loading configured role…'}</code></dd></div>
			<div><dt>Minter · not an Admin signer</dt><dd><code>{roles?.minter || 'Loading configured role…'}</code></dd></div>
			<div><dt>Approval threshold</dt><dd>2 of 2</dd></div>
		</dl>
		{wallet && wallet.chainId !== CHAIN_ID && <div className="result warning"><p>MetaMask has connected this website to chain {wallet.chainId}. Switch the website connection to Ethereum Sepolia ({CHAIN_ID}) before deployment.</p><button type="button" disabled={busy} onClick={() => { void switchToSepolia(); }}>{busy ? 'Waiting for MetaMask…' : 'Switch connected site to Sepolia'}</button></div>}
		{!status && !review && <button type="button" disabled={!provider || !roles || busy} onClick={() => { void prepare(); }}>{busy ? 'Checking Sepolia deployment…' : 'Prepare Sepolia Admin deployment'}</button>}
		{review && <div className="bridge-deployment-review">
			<h4>Review deployment</h4>
			<dl className="history-detail-grid">
				<div><dt>Deployment payer</dt><dd><code>{review.from}</code></dd></div>
				<div><dt>Predicted Admin contract</dt><dd><code>{review.predictedAddress}</code></dd></div>
				<div><dt>Maximum reviewed gas budget</dt><dd>{formatEth(review.maximumFeeWei)} SepoliaETH</dd></div>
				<div><dt>Value transferred to contract</dt><dd>0 SepoliaETH</dd></div>
			</dl>
			<label className="bridge-role-choice"><input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.target.checked)} /> I checked the Sepolia network, both signer addresses and the gas budget.</label>
			<div><button type="button" disabled={!checked || busy} onClick={() => { void deploy(); }}>{busy ? 'Waiting for MetaMask…' : 'Confirm deployment in MetaMask'}</button> <button type="button" className="history-secondary" disabled={busy} onClick={() => { setReview(null); setChecked(false); }}>Cancel review</button></div>
		</div>}
		{status && <p className={`result ${status.status === 'verified' ? 'success' : ['reverted', 'invalid'].includes(status.status) ? 'error' : 'warning'}`}>
			<strong>{status.status === 'verified' ? 'Sepolia Admin multisig verified.' : status.status === 'confirming' ? 'Deployment confirming.' : status.status === 'submitted' ? 'Deployment submitted.' : 'Deployment failed.'}</strong>{' '}
			Contract: <code>{status.predictedAddress}</code>. {status.confirmations} / {CONFIRMATIONS_REQUIRED} confirmations.
			{status.actualFeeWei !== null && <> Actual fee: {formatEth(status.actualFeeWei)} SepoliaETH.</>}
		</p>}
		{status?.lastError && <p className="result error" role="alert">{status.lastError}</p>}
		{status && ['reverted', 'invalid'].includes(status.status) && <button type="button" className="history-secondary" onClick={() => { localStorage.removeItem(STORAGE_KEY); setStatus(null); setError(''); }}>Discard failed deployment</button>}
		{error && <p className="result error" role="alert">{error}</p>}
		<p className="history-note">This setup sends no ETH to the contract and stores no private key. MetaMask must explicitly approve the deployment.</p>
		{status?.status === 'verified' && provider && roles && <>
			<EthereumWrappedSetup provider={provider} roles={roles} admin={status.predictedAddress} wallet={wallet} source={NATIVE_WRAPPED_SOURCE} />
			<EthereumFtRoutes session={session} active={active} provider={provider} roles={roles} admin={status.predictedAddress} wallet={wallet} />
		</>}
	</section>;
}
