import { useEffect, useMemo, useRef, useState } from 'react';
import {
	createPublicClient, encodeDeployData, formatEther, getAddress, http, keccak256, ripemd160, sha256,
	toHex, type Address, type Hex,
} from 'viem';
import manifest from '../../generated/phase3-testnet-v2-deployment.json';
import publicDeployment from '../../../../shared/src/config/phase3-testnet-v2-public.json';
import { HYPEREVM_TESTNET } from '../../config/hyperevm';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import { getErrorMessage } from '../../utils/errors';
import { preparePhase3TestnetRelay } from '../../services/phase3TestnetRelay';
import {
	buildPhase3TestnetDeposit, broadcastPhase3TestnetDeposit, finalizePhase3TestnetDeposit,
	phase3TestnetDepositSigningRequest,
} from '../../services/phase3TestnetDeposit';
import type {
	Phase3TestnetDepositBroadcast, SignedPhase3TestnetDeposit, UnsignedPhase3TestnetDeposit,
} from '../../../../shared/src/types/phase3TestnetDeposit';

type EvmWallet = ReturnType<typeof useHyperEvmWallet>;
type ContractStep = 'relay' | 'finalized' | 'transition' | 'signature' | 'prefix' | 'gateway';
interface DeploymentState {
	sourceAddress: string;
	deployer: Address;
	reserveController: Hex;
	publicKey: string;
	relay?: Address;
	finalized?: Address;
	transition?: Address;
	signature?: Address;
	prefix?: Address;
	gateway?: Address;
	wrappedToken?: Address;
	hashes: Partial<Record<ContractStep, Hex>>;
}
const STORAGE_KEY = 'learningmaterials.phase3.testnet-v2.deployment.v2';
const PINNED_MT_CONTRACT_ID = 'ac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c';

const constructorAbi = [{
	type: 'constructor',
	inputs: [
		{ name: 'relay_', type: 'address' },
		{ name: 'finalizedVerifier_', type: 'address' },
		{ name: 'transitionVerifier_', type: 'address' },
		{ name: 'signatureVerifier_', type: 'address' },
		{ name: 'prefixVerifier_', type: 'address' },
		{ name: 'reserveController_', type: 'bytes20' },
	],
	stateMutability: 'nonpayable',
}] as const;
const gatewayReadAbi = [
	{ type: 'function', name: 'finalizedVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'transitionVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'signatureVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'prefixVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'reserveController', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes20' }] },
	{ type: 'function', name: 'relay', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'wrappedToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const relayReadAbi = [
	{ type: 'function', name: 'bestTip', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
	{ type: 'function', name: 'CHECKPOINT_HEIGHT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
	{ type: 'function', name: 'CHECKPOINT_HASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
	{ type: 'function', name: 'BOOTSTRAP_COMMITMENT_ROOT', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

function controllerFromPublicKey(value: string) {
	const publicKey = value.trim().toLowerCase().replace(/^0x/, '');
	if (!/^(?:02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/.test(publicKey)) {
		throw new Error('Turing Wallet returned an invalid TBC public key.');
	}
	return { publicKey, controller: ripemd160(sha256(`0x${publicKey}`)) };
}

export default function ProofBridgeTestnetSetup({ session, evm, active }: {
	session: WalletSession;
	evm: EvmWallet;
	active: boolean;
}) {
	const [state, setState] = useState<DeploymentState | null>(null);
	const [working, setWorking] = useState('');
	const [error, setError] = useState('');
	const [relayResult, setRelayResult] = useState<{ height: number; hash: Hex; txHash: Hex; feeWei: string } | null>(null);
	const [depositAmount, setDepositAmount] = useState('');
	const [deposit, setDeposit] = useState<UnsignedPhase3TestnetDeposit | null>(null);
	const [signedDeposit, setSignedDeposit] = useState<SignedPhase3TestnetDeposit | null>(null);
	const [depositReceipt, setDepositReceipt] = useState<Phase3TestnetDepositBroadcast | null>(null);
	const running = useRef(false);
	const client = useMemo(() => createPublicClient({ transport: http(HYPEREVM_TESTNET.rpcUrl) }), []);
	const next: ContractStep | null = !state?.relay ? 'relay'
		: !state.finalized ? 'finalized'
			: !state.transition ? 'transition'
				: !state.signature ? 'signature'
					: !state.prefix ? 'prefix' : !state.gateway ? 'gateway' : null;
	const ready = active && session.networkIsDevnet && Boolean(session.address)
		&& evm.networkIsTestnet && Boolean(evm.address) && !session.busy && !evm.pending;
	useEffect(() => {
		if (!active || !session.address || !evm.address) return;
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as DeploymentState | null;
			if (saved?.sourceAddress === session.address
				&& saved.deployer?.toLowerCase() === evm.address.toLowerCase()
				&& /^0x[0-9a-f]{40}$/i.test(saved.reserveController)) setState(saved);
		} catch { localStorage.removeItem(STORAGE_KEY); }
	}, [active, session.address, evm.address]);
	function remember(nextState: DeploymentState) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
		setState(nextState);
	}

	async function verifyWallets(expected?: DeploymentState) {
		const [network, addresses, key, current] = await Promise.all([
			session.wallet.getNetwork(), session.wallet.getAddress(), session.wallet.getPubKey(),
			evm.readCurrent(),
		]);
		const walletAddresses = addresses as WalletAddresses | undefined;
		const source = walletAddresses?.tbcAddress ?? walletAddresses?.addresses?.tbcAddress;
		if (network?.network !== 'tbc' || network.type !== 'testnet' || !source || source !== session.address) {
			throw new Error('Reconnect the same Turing Wallet account on TBC Testnet.');
		}
		if (current.chainId !== 998 || !current.address) throw new Error('Connect MetaMask on HyperEVM Testnet (chain 998).');
		const derived = controllerFromPublicKey(key?.tbcPubKey ?? '');
		if (expected && (derived.publicKey !== expected.publicKey
			|| derived.controller.toLowerCase() !== expected.reserveController.toLowerCase()
			|| expected.sourceAddress !== source
			|| expected.deployer.toLowerCase() !== current.address.toLowerCase())) {
			throw new Error('The Turing Wallet public key changed. Start a new deployment review.');
		}
		return { ...derived, evmAddress: getAddress(current.address) };
	}

	async function review() {
		if (!ready || running.current) return;
		running.current = true; setWorking('Reading both wallets…'); setError('');
		try {
			const wallets = await verifyWallets();
			remember({
				sourceAddress: session.address,
				deployer: wallets.evmAddress,
				reserveController: wallets.controller,
				publicKey: wallets.publicKey,
				hashes: {},
			});
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	async function deploy() {
		if (!ready || !state || !next || running.current) return;
		running.current = true; setWorking(`Preparing ${next} deployment…`); setError('');
		try {
			const wallets = await verifyWallets(state);
			let data: Hex;
			if (next !== 'gateway') data = manifest.contracts[next].bytecode as Hex;
			else {
				if (!state.relay || !state.finalized || !state.transition
					|| !state.signature || !state.prefix) {
					throw new Error('Deploy all pinned verifier modules first.');
				}
				data = encodeDeployData({
					abi: constructorAbi,
					bytecode: manifest.contracts.gateway.bytecode as Hex,
					args: [
						state.relay, state.finalized, state.transition,
						state.signature, state.prefix, state.reserveController,
					],
				});
			}
			const [nonce, gasPrice, estimatedGas, block, balance] = await Promise.all([
				client.getTransactionCount({ address: wallets.evmAddress, blockTag: 'pending' }),
				client.getGasPrice(),
				client.estimateGas({ account: wallets.evmAddress, data }),
				client.getBlock({ blockTag: 'latest' }),
				client.getBalance({ address: wallets.evmAddress, blockTag: 'pending' }),
			]);
			if (estimatedGas > block.gasLimit) {
				throw new Error(`${next} requires ${estimatedGas} gas but the current block limit is ${block.gasLimit}.`);
			}
			const bufferedGas = estimatedGas * 120n / 100n;
			const gas = bufferedGas > block.gasLimit ? block.gasLimit : bufferedGas;
			const maximumFee = gas * gasPrice;
			if (balance < maximumFee) {
				throw new Error(
					`Insufficient Testnet HYPE for ${next}: balance ${balance} wei, maximum gas fee ${maximumFee} wei.`,
				);
			}
			setWorking(`Confirm ${next} deployment in MetaMask…`);
			const txHash = await evm.sendDeployment({
				from: wallets.evmAddress,
				chainId: '0x3e6',
				data,
				value: '0x0',
				gas: toHex(gas),
				gasPrice: toHex(gasPrice),
				nonce: toHex(nonce),
			});
			setWorking(`Waiting for ${next} receipt…`);
			const receipt = await client.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 });
			if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${next} deployment reverted.`);
			const address = getAddress(receipt.contractAddress);
			const runtime = await client.getCode({ address });
			if (!runtime || runtime === '0x') throw new Error(`${next} deployment has no runtime code.`);
			if (next !== 'gateway') {
				const expected = manifest.contracts[next].runtimeCodeHash;
				if (keccak256(runtime).toLowerCase() !== expected.toLowerCase()) {
					throw new Error(`${next} runtime codehash differs from the pinned build.`);
				}
				const updated = { ...state, [next]: address, hashes: { ...state.hashes, [next]: txHash as Hex } };
				remember(updated);
			} else {
				const [finalized, transition, signature, prefix, reserve, relay, wrappedToken] = await Promise.all([
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'finalizedVerifier' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'transitionVerifier' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'signatureVerifier' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'prefixVerifier' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'reserveController' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'relay' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'wrappedToken' }),
				]);
				if (finalized.toLowerCase() !== state.finalized!.toLowerCase()
					|| transition.toLowerCase() !== state.transition!.toLowerCase()
					|| signature.toLowerCase() !== state.signature!.toLowerCase()
					|| prefix.toLowerCase() !== state.prefix!.toLowerCase()
					|| relay.toLowerCase() !== state.relay!.toLowerCase()
					|| reserve.toLowerCase() !== state.reserveController.toLowerCase()) {
					throw new Error('Gateway constructor bindings differ from the reviewed values.');
				}
				const [relayCode, height, hash, root] = await Promise.all([
					client.getCode({ address: relay }),
					client.readContract({ address: relay, abi: relayReadAbi, functionName: 'CHECKPOINT_HEIGHT' }),
					client.readContract({ address: relay, abi: relayReadAbi, functionName: 'CHECKPOINT_HASH' }),
					client.readContract({ address: relay, abi: relayReadAbi, functionName: 'BOOTSTRAP_COMMITMENT_ROOT' }),
				]);
				if (!relayCode || keccak256(relayCode).toLowerCase() !== manifest.contracts.relay.runtimeCodeHash.toLowerCase()
					|| Number(height) !== manifest.checkpoint.height
					|| hash.toLowerCase() !== manifest.checkpoint.hash.toLowerCase()
					|| root.toLowerCase() !== manifest.checkpoint.commitmentRoot.toLowerCase()) {
					throw new Error('Gateway relay does not match the pinned Testnet-v2 checkpoint build.');
				}
				remember({
					...state, gateway: address, wrappedToken,
					hashes: { ...state.hashes, gateway: txHash as Hex },
				});
			}
			evm.refresh();
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	async function relayNextHeader() {
		if (!ready || !state?.gateway || !state.relay || running.current) return;
		running.current = true; setWorking('Cross-checking the next TBC header…'); setError(''); setRelayResult(null);
		try {
			const wallets = await verifyWallets(state);
			if (state.relay.toLowerCase() !== publicDeployment.contracts.relay.toLowerCase()
				|| state.gateway.toLowerCase() !== publicDeployment.contracts.gateway.toLowerCase()) {
				throw new Error('Saved deployment addresses differ from the recorded public Testnet-v2 route.');
			}
			const plan = await preparePhase3TestnetRelay(wallets.evmAddress);
			if (!plan.canCoverMaximumFee) {
				throw new Error(`Insufficient Testnet HYPE: balance ${formatEther(BigInt(plan.balanceWei))}, relay budget ${formatEther(BigInt(plan.maximumFeeWei))} HYPE.`);
			}
			setWorking(`Simulating TBC header ${plan.target.height} on HyperEVM…`);
			await client.call({
				account: wallets.evmAddress,
				to: getAddress(plan.transaction.to),
				data: plan.transaction.data as Hex,
			});
			setWorking(`Confirm header ${plan.target.height} relay in MetaMask (maximum ${formatEther(BigInt(plan.maximumFeeWei))} HYPE)…`);
			const txHash = await evm.sendBridgeCall(plan.transaction);
			setWorking(`Waiting for header ${plan.target.height} relay receipt…`);
			const receipt = await client.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 });
			if (receipt.status !== 'success') throw new Error(`Header ${plan.target.height} relay reverted.`);
			const bestTip = await client.readContract({
				address: getAddress(plan.relay), abi: relayReadAbi, functionName: 'bestTip',
			});
			if (bestTip.toLowerCase() !== plan.target.hash.toLowerCase()) {
				throw new Error('Relay receipt succeeded, but its best tip differs from the reviewed target.');
			}
			setRelayResult({
				height: plan.target.height,
				hash: plan.target.hash as Hex,
				txHash: txHash as Hex,
				feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
			});
			evm.refresh();
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	async function prepareDeposit() {
		if (!ready || !state?.gateway || running.current) return;
		running.current = true; setWorking('Building a wallet-bound Bridge Covenant deposit…'); setError(''); setDeposit(null); setSignedDeposit(null); setDepositReceipt(null);
		try {
			const wallets = await verifyWallets(state);
			const controller = new AbortController();
			const result = await buildPhase3TestnetDeposit({
				sender: state.sourceAddress, publicKey: wallets.publicKey,
				contractId: PINNED_MT_CONTRACT_ID, amount: depositAmount.trim(), recipient: wallets.evmAddress,
			}, controller.signal);
			setDeposit(result);
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	async function signDeposit() {
		if (!ready || !state || !deposit || running.current) return;
		running.current = true; session.setBusy(true); setWorking('Checking v2 deposit inputs before Turing Wallet signing…'); setError('');
		try {
			const wallets = await verifyWallets(state);
			if (wallets.publicKey !== deposit.terms.publicKey) throw new Error('The Turing Wallet key differs from the reviewed deposit.');
			const controller = new AbortController();
			const request = await phase3TestnetDepositSigningRequest(deposit, controller.signal);
			setWorking('Review and sign the exact v2 deposit in Turing Wallet…');
			const response = await session.wallet.signTransaction(request);
			if (response?.error) throw new Error(response.error);
			if (!response?.sigs || response.sigs.length !== 1 || !Array.isArray(response.sigs[0]) || response.sigs[0].length !== deposit.inputs.length) throw new Error('Turing Wallet did not return one signature for every reviewed input.');
			setWorking('Verifying every signature and the complete Bridge Covenant proof locally…');
			setSignedDeposit(await finalizePhase3TestnetDeposit(deposit.buildId, wallets.publicKey, response.sigs[0], controller.signal));
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { session.setBusy(false); running.current = false; setWorking(''); }
	}

	async function submitDeposit(checkOnly = false) {
		if (!ready || !deposit || !signedDeposit || running.current) return;
		running.current = true; setWorking(checkOnly ? 'Checking the saved v2 deposit TXID…' : 'Submitting the exact signed v2 deposit once…'); setError('');
		try {
			const controller = new AbortController();
			setDepositReceipt(await broadcastPhase3TestnetDeposit(deposit.buildId, signedDeposit.txid, checkOnly, controller.signal));
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	return <details className="bridge-flow-history">
		<summary>Proof-backed Testnet v2 setup · {state?.gateway ? 'deployed' : 'not deployed'}</summary>
		<section className="htlc-section" aria-busy={Boolean(working)}>
			<h3>Experimental proof-backed route</h3>
			<p>This is a public Testnet experiment, not a production-trustless bridge. It does not solve the cryptographic unspent-proof gap.</p>
			<dl className="history-detail-grid">
				<div><dt>Checkpoint</dt><dd>{manifest.checkpoint.height} · <code>{manifest.checkpoint.hash}</code></dd></div>
				<div><dt>Bootstrap root</dt><dd><code>{manifest.checkpoint.commitmentRoot}</code></dd></div>
				<div><dt>Reserve controller</dt><dd><code>{state?.reserveController ?? 'Review connected Turing Wallet'}</code></dd></div>
				<div><dt>Finalized-inclusion verifier</dt><dd><code>{state?.finalized ?? 'Not deployed'}</code></dd></div>
				<div><dt>Transition verifier</dt><dd><code>{state?.transition ?? 'Not deployed'}</code></dd></div>
				<div><dt>Input-signature verifier</dt><dd><code>{state?.signature ?? 'Not deployed'}</code></dd></div>
				<div><dt>Prefix verifier</dt><dd><code>{state?.prefix ?? 'Not deployed'}</code></dd></div>
				<div><dt>Gateway</dt><dd><code>{state?.gateway ?? 'Not deployed'}</code></dd></div>
				<div><dt>Header relay</dt><dd><code>{state?.relay ?? 'Not deployed'}</code></dd></div>
				<div><dt>Wrapped token</dt><dd><code>{state?.wrappedToken ?? 'Created by gateway'}</code></dd></div>
			</dl>
			<div className="htlc-actions">
				{!state && <button type="button" disabled={!ready || Boolean(working)} onClick={() => { void review(); }}>Review wallet-bound route</button>}
				{state && next && <button type="button" disabled={!ready || Boolean(working)} onClick={() => { void deploy(); }}>Deploy {next} with MetaMask</button>}
				{state?.gateway && <button type="button" disabled={!ready || Boolean(working)} onClick={() => { void relayNextHeader(); }}>Relay next TBC header with MetaMask</button>}
			</div>
			{state?.gateway && <section className="htlc-section">
				<h4>Create the first real v2 MT deposit</h4>
				<p>The gateway is pinned to MT v3. Review creates an unsigned transaction only. Signing does not broadcast; submission remains a separate explicit action.</p>
				<label>MT amount
					<input type="text" inputMode="decimal" placeholder="Example: 100" value={depositAmount} disabled={Boolean(working) || Boolean(deposit)} onChange={(event) => setDepositAmount(event.target.value)} />
				</label>
				<p>Recipient: <code>{state.deployer}</code><br />Source Contract ID: <code>{PINNED_MT_CONTRACT_ID}</code></p>
				<div className="htlc-actions">
					{!deposit && <button type="button" disabled={!ready || Boolean(working) || !depositAmount.trim()} onClick={() => { void prepareDeposit(); }}>Review unsigned v2 deposit</button>}
					{deposit && !signedDeposit && <button type="button" disabled={!ready || Boolean(working)} onClick={() => { void signDeposit(); }}>Sign reviewed deposit with Turing Wallet</button>}
					{deposit && !signedDeposit && <button type="button" className="secondary" disabled={Boolean(working)} onClick={() => { setDeposit(null); setDepositAmount(''); }}>Discard review</button>}
					{signedDeposit && !depositReceipt && <button type="button" disabled={!ready || Boolean(working)} onClick={() => { void submitDeposit(false); }}>Submit signed deposit to TBC Testnet</button>}
					{depositReceipt?.status === 'unknown' && <button type="button" disabled={Boolean(working)} onClick={() => { void submitDeposit(true); }}>Check saved TXID (no resubmit)</button>}
				</div>
				{deposit && <dl className="history-detail-grid">
					<div><dt>Deposit MT</dt><dd>{deposit.terms.amount} {deposit.symbol} · raw {deposit.amountRaw}</dd></div>
					<div><dt>Source fee budget</dt><dd>{deposit.feeRaw} satoshis</dd></div>
					<div><dt>Token change</dt><dd>{deposit.tokenChangeRaw} raw → sender</dd></div>
					<div><dt>Native change</dt><dd>{deposit.nativeChangeRaw} satoshis → sender</dd></div>
					<div><dt>Inputs / outputs</dt><dd>{deposit.inputs.length} / {deposit.outputs.length}</dd></div>
					<div><dt>Signing expires</dt><dd>{new Date(deposit.signingExpiresAt).toLocaleString()}</dd></div>
				</dl>}
				{signedDeposit && <p className="result success">All input signatures and the complete legacy-FT Bridge Covenant proof passed locally. TXID: <code>{signedDeposit.txid}</code>. Nothing is on-chain until Submit is pressed.</p>}
				{depositReceipt && <p className={depositReceipt.status === 'submitted' ? 'result success' : 'result error'}>{depositReceipt.message}<br />TXID: <code>{depositReceipt.txid}</code></p>}
			</section>}
			{working && <p role="status">{working}</p>}
			{error && <p className="result error" role="alert">{error}</p>}
			{state?.gateway && <p className="result success" role="status">Public Testnet-v2 contracts deployed and checkpoint bindings verified. Continue with header relay and a new deposit only.</p>}
			{relayResult && <p className="result success" role="status">Relayed TBC header {relayResult.height} · <code>{relayResult.hash}</code><br />HyperEVM transaction: <code>{relayResult.txHash}</code> · actual fee {formatEther(BigInt(relayResult.feeWei))} HYPE.</p>}
		</section>
	</details>;
}
