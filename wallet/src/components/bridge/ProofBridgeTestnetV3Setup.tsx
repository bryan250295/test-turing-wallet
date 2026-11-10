import { useEffect, useMemo, useRef, useState } from 'react';
import {
	createPublicClient, encodeDeployData, formatEther, getAddress, http, keccak256,
	ripemd160, sha256, toHex, type Address, type Hex,
} from 'viem';
import manifest from '../../generated/phase3-testnet-v3-deployment.json';
import { HYPEREVM_TESTNET } from '../../config/hyperevm';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import type { BridgeDeploymentTransaction } from '../../types/learningBridge';
import { getErrorMessage } from '../../utils/errors';
import {
	buildPhase3TestnetDeposit, broadcastPhase3TestnetDeposit, finalizePhase3TestnetDeposit,
	phase3TestnetDepositSigningRequest,
} from '../../services/phase3TestnetDeposit';
import { connectProofBridgeV3Progress, getProofBridgeV3Progress, registerProofBridgeV3Route } from '../../services/proofBridgeV3';
import type { ProofBridgeV3Snapshot } from '../../../../shared/src/types/proofBridgeV3';

type EvmWallet = ReturnType<typeof useHyperEvmWallet>;
type Step = 'relay' | 'gateway';
interface V3State {
	sourceAddress: string;
	deployer: Address;
	reserveController: Hex;
	publicKey: string;
	relay?: Address;
	gateway?: Address;
	wrappedToken?: Address;
	hashes: Partial<Record<Step, Hex>>;
}
interface Quote {
	step: Step;
	transaction: BridgeDeploymentTransaction;
	estimatedGas: string;
	maximumFeeWei: string;
	balanceWei: string;
	expiresAt: number;
}

const STORAGE_KEY = 'learningmaterials.phase3.testnet-v3.deployment.v1';
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
const relayReadAbi = [
	{ type: 'function', name: 'CHECKPOINT_HEIGHT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
	{ type: 'function', name: 'CHECKPOINT_HASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
	{ type: 'function', name: 'BOOTSTRAP_COMMITMENT_ROOT', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;
const gatewayReadAbi = [
	{ type: 'function', name: 'finalizedVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'transitionVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'signatureVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'prefixVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'reserveController', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes20' }] },
	{ type: 'function', name: 'relay', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'wrappedToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

function controllerFromPublicKey(value: string) {
	const publicKey = value.trim().toLowerCase().replace(/^0x/, '');
	if (!/^(?:02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/.test(publicKey)) throw new Error('Turing Wallet returned an invalid TBC public key.');
	return { publicKey, controller: ripemd160(sha256(`0x${publicKey}`)) };
}

export default function ProofBridgeTestnetV3Setup({ session, evm, active }: { session: WalletSession; evm: EvmWallet; active: boolean }) {
	const [state, setState] = useState<V3State | null>(null);
	const [quote, setQuote] = useState<Quote | null>(null);
	const [working, setWorking] = useState('');
	const [error, setError] = useState('');
	const [snapshot, setSnapshot] = useState<ProofBridgeV3Snapshot | null>(null);
	const [realtime, setRealtime] = useState<'off' | 'connecting' | 'live' | 'reconnecting'>('off');
	const [depositAmount, setDepositAmount] = useState('');
	const [sourceTxid, setSourceTxid] = useState('');
	const running = useRef(false);
	const registrationAttempted = useRef('');
	const client = useMemo(() => createPublicClient({ transport: http(HYPEREVM_TESTNET.rpcUrl) }), []);
	const next: Step | null = !state?.relay ? 'relay' : !state.gateway ? 'gateway' : null;
	const ready = active && session.networkIsDevnet && Boolean(session.address) && evm.networkIsTestnet && Boolean(evm.address) && !session.busy && !evm.pending;

	useEffect(() => {
		if (!active || !session.address || !evm.address) return;
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as V3State | null;
			if (saved?.sourceAddress === session.address && saved.deployer?.toLowerCase() === evm.address.toLowerCase()) setState(saved);
		} catch { localStorage.removeItem(STORAGE_KEY); }
	}, [active, session.address, evm.address]);

	useEffect(() => {
		if (!active || !session.address) { setRealtime('off'); return; }
		const controller = new AbortController();
		void getProofBridgeV3Progress(controller.signal).then(setSnapshot).catch(() => undefined);
		const disconnect = connectProofBridgeV3Progress(setSnapshot, setRealtime);
		return () => { controller.abort(); disconnect(); setRealtime('off'); };
	}, [active, session.address]);

	function remember(value: V3State) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
		setState(value);
		setQuote(null);
	}

	async function registerRoute(value: V3State) {
		if (!value.relay || !value.gateway || !value.wrappedToken || !value.hashes.relay || !value.hashes.gateway) throw new Error('Both verified V3 deployment receipts are required before route registration.');
		await registerProofBridgeV3Route({ deployer: value.deployer, relay: value.relay, gateway: value.gateway, wrappedToken: value.wrappedToken, relayTxHash: value.hashes.relay, gatewayTxHash: value.hashes.gateway }, AbortSignal.timeout(60_000));
		setSnapshot(await getProofBridgeV3Progress(AbortSignal.timeout(30_000)));
	}

	useEffect(() => {
		if (!active || !state?.gateway || !state.relay || !state.wrappedToken || !state.hashes.gateway || !state.hashes.relay || snapshot === null || snapshot.route || running.current) return;
		const key = `${state.gateway.toLowerCase()}:${state.hashes.gateway.toLowerCase()}`;
		if (registrationAttempted.current === key) return;
		registrationAttempted.current = key;
		void registerRoute(state).catch((cause) => setError(getErrorMessage(cause)));
	}, [active, snapshot, state]);

	async function verifyWallets(expected?: V3State) {
		const [network, addresses, key, current] = await Promise.all([
			session.wallet.getNetwork(), session.wallet.getAddress(), session.wallet.getPubKey(), evm.readCurrent(),
		]);
		const walletAddresses = addresses as WalletAddresses | undefined;
		const source = walletAddresses?.tbcAddress ?? walletAddresses?.addresses?.tbcAddress;
		if (network?.network !== 'tbc' || network.type !== 'testnet' || !source || source !== session.address) throw new Error('Reconnect the same Turing Wallet account on TBC Testnet.');
		if (current.chainId !== 998 || !current.address) throw new Error('Connect MetaMask on HyperEVM Testnet (chain 998).');
		const derived = controllerFromPublicKey(key?.tbcPubKey ?? '');
		if (derived.controller.toLowerCase() !== manifest.reuse.reserveController.toLowerCase()) throw new Error('The connected Turing Wallet is not the frozen V3 reserve controller.');
		if (expected && (expected.sourceAddress !== source || expected.deployer.toLowerCase() !== current.address.toLowerCase() || expected.publicKey !== derived.publicKey)) throw new Error('The connected wallet identity changed.');
		return { ...derived, sourceAddress: source, evmAddress: getAddress(current.address) };
	}

	useEffect(() => {
		if (!active || state || !snapshot?.route || !session.address || !evm.address) return;
		if (snapshot.route.sourceAddress !== session.address || snapshot.route.deployer.toLowerCase() !== evm.address.toLowerCase()) return;
		void verifyWallets().then((wallets) => remember({
			sourceAddress: wallets.sourceAddress, deployer: wallets.evmAddress,
			reserveController: wallets.controller, publicKey: wallets.publicKey,
			relay: snapshot.route!.relay, gateway: snapshot.route!.gateway, wrappedToken: snapshot.route!.wrappedToken,
			hashes: { relay: snapshot.route!.relayTxHash, gateway: snapshot.route!.gatewayTxHash },
		})).catch((cause) => setError(getErrorMessage(cause)));
	}, [active, evm.address, session.address, snapshot, state]);

	async function assertReusableVerifiers() {
		for (const reused of [manifest.reuse.finalized, manifest.reuse.transition, manifest.reuse.signature, manifest.reuse.prefix]) {
			const code = await client.getCode({ address: getAddress(reused.address) });
			if (!code || keccak256(code).toLowerCase() !== reused.runtimeCodeHash.toLowerCase()) throw new Error(`Reusable verifier ${reused.address} does not match its pinned runtime.`);
		}
	}

	async function reviewRoute() {
		if (!ready || running.current) return;
		running.current = true; setWorking('Verifying reusable contracts and both wallets…'); setError('');
		try {
			const wallets = await verifyWallets();
			await assertReusableVerifiers();
			remember({ sourceAddress: wallets.sourceAddress, deployer: wallets.evmAddress, reserveController: wallets.controller, publicKey: wallets.publicKey, hashes: {} });
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	function deploymentData(step: Step, value: V3State) {
		if (step === 'relay') return manifest.contracts.relay.bytecode as Hex;
		if (!value.relay) throw new Error('Deploy and verify the V3 Relay first.');
		return encodeDeployData({
			abi: constructorAbi,
			bytecode: manifest.contracts.gateway.bytecode as Hex,
			args: [
				value.relay, getAddress(manifest.reuse.finalized.address), getAddress(manifest.reuse.transition.address),
				getAddress(manifest.reuse.signature.address), getAddress(manifest.reuse.prefix.address), value.reserveController,
			],
		});
	}

	async function reviewCost() {
		if (!ready || !state || !next || running.current) return;
		running.current = true; setWorking(`Estimating V3 ${next} without broadcasting…`); setError(''); setQuote(null);
		try {
			const wallets = await verifyWallets(state);
			await assertReusableVerifiers();
			const data = deploymentData(next, state);
			const [nonce, gasPrice, estimatedGas, block, balance] = await Promise.all([
				client.getTransactionCount({ address: wallets.evmAddress, blockTag: 'pending' }), client.getGasPrice(),
				client.estimateGas({ account: wallets.evmAddress, data }), client.getBlock({ blockTag: 'latest' }),
				client.getBalance({ address: wallets.evmAddress, blockTag: 'pending' }),
			]);
			if (estimatedGas > block.gasLimit) throw new Error(`${next} exceeds the current HyperEVM block gas limit.`);
			const buffered = estimatedGas * 120n / 100n;
			const gas = buffered > block.gasLimit ? block.gasLimit : buffered;
			const maximumFee = gas * gasPrice;
			setQuote({
				step: next, estimatedGas: estimatedGas.toString(), maximumFeeWei: maximumFee.toString(), balanceWei: balance.toString(), expiresAt: Date.now() + 120_000,
				transaction: { from: wallets.evmAddress, chainId: '0x3e6', data, value: '0x0', gas: toHex(gas), gasPrice: toHex(gasPrice), nonce: toHex(nonce) },
			});
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	async function deployReviewed() {
		if (!ready || !state || !next || !quote || quote.step !== next || running.current) return;
		if (quote.expiresAt <= Date.now()) { setQuote(null); setError('The gas review expired. Review the current cost again.'); return; }
		if (BigInt(quote.balanceWei) < BigInt(quote.maximumFeeWei)) { setError('The reviewed wallet balance does not cover this deployment. No MetaMask request was opened.'); return; }
		running.current = true; setWorking(`Confirm V3 ${next} deployment in MetaMask…`); setError('');
		try {
			await verifyWallets(state);
			const txHash = await evm.sendDeployment(quote.transaction);
			setWorking(`Waiting for V3 ${next} receipt…`);
			const receipt = await client.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 });
			if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`V3 ${next} deployment reverted.`);
			const address = getAddress(receipt.contractAddress);
			if (next === 'relay') {
				const [code, height, hash, root] = await Promise.all([
					client.getCode({ address }), client.readContract({ address, abi: relayReadAbi, functionName: 'CHECKPOINT_HEIGHT' }),
					client.readContract({ address, abi: relayReadAbi, functionName: 'CHECKPOINT_HASH' }), client.readContract({ address, abi: relayReadAbi, functionName: 'BOOTSTRAP_COMMITMENT_ROOT' }),
				]);
				if (!code || keccak256(code).toLowerCase() !== manifest.contracts.relay.runtimeCodeHash.toLowerCase() || Number(height) !== manifest.checkpoint.height || hash.toLowerCase() !== manifest.checkpoint.hash.toLowerCase() || root.toLowerCase() !== manifest.bootstrap.commitmentRoot.toLowerCase()) throw new Error('Deployed V3 Relay differs from the reviewed checkpoint build.');
				remember({ ...state, relay: address, hashes: { ...state.hashes, relay: txHash as Hex } });
			} else {
				const [relay, finalized, transition, signature, prefix, reserve, wrappedToken] = await Promise.all([
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'relay' }), client.readContract({ address, abi: gatewayReadAbi, functionName: 'finalizedVerifier' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'transitionVerifier' }), client.readContract({ address, abi: gatewayReadAbi, functionName: 'signatureVerifier' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'prefixVerifier' }), client.readContract({ address, abi: gatewayReadAbi, functionName: 'reserveController' }),
					client.readContract({ address, abi: gatewayReadAbi, functionName: 'wrappedToken' }),
				]);
				if (relay.toLowerCase() !== state.relay!.toLowerCase() || finalized.toLowerCase() !== manifest.reuse.finalized.address.toLowerCase() || transition.toLowerCase() !== manifest.reuse.transition.address.toLowerCase() || signature.toLowerCase() !== manifest.reuse.signature.address.toLowerCase() || prefix.toLowerCase() !== manifest.reuse.prefix.address.toLowerCase() || reserve.toLowerCase() !== state.reserveController.toLowerCase()) throw new Error('V3 Gateway bindings differ from the reviewed route.');
				const completed = { ...state, gateway: address, wrappedToken, hashes: { ...state.hashes, gateway: txHash as Hex } };
				remember(completed);
				setWorking('Registering and independently verifying the complete V3 route…');
				await registerRoute(completed);
			}
			evm.refresh();
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { running.current = false; setWorking(''); }
	}

	async function startDeposit() {
		if (!ready || !state?.gateway || !snapshot?.route || running.current) return;
		running.current = true; session.setBusy(true); setWorking('Building and locally reviewing one V3 Bridge Covenant deposit…'); setError(''); setSourceTxid('');
		try {
			const wallets = await verifyWallets(state);
			const controller = new AbortController();
			const deposit = await buildPhase3TestnetDeposit({ sender: state.sourceAddress, publicKey: wallets.publicKey, contractId: PINNED_MT_CONTRACT_ID, amount: depositAmount.trim(), recipient: wallets.evmAddress }, controller.signal);
			setWorking('Review and sign the exact V3 deposit in Turing Wallet…');
			const request = await phase3TestnetDepositSigningRequest(deposit, controller.signal);
			const response = await session.wallet.signTransaction(request);
			if (response?.error) throw new Error(response.error);
			if (!response?.sigs || response.sigs.length !== 1 || !Array.isArray(response.sigs[0]) || response.sigs[0].length !== deposit.inputs.length) throw new Error('Turing Wallet did not sign every reviewed V3 input.');
			setWorking('Verifying signatures, complete FT transition and Bridge Covenant proof…');
			const signed = await finalizePhase3TestnetDeposit(deposit.buildId, wallets.publicKey, response.sigs[0], controller.signal);
			setWorking('Submitting the exact signed V3 deposit once…');
			const receipt = await broadcastPhase3TestnetDeposit(deposit.buildId, signed.txid, false, controller.signal);
			if (receipt.status === 'rejected') throw new Error(receipt.message);
			setSourceTxid(signed.txid); setDepositAmount('');
			setWorking('');
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { session.setBusy(false); running.current = false; setWorking(''); }
	}

	const latest = snapshot?.transfers[0];
	const stage = latest?.status === 'completed' ? 'Completed'
		: latest?.status === 'mint_submitted' ? `Waiting for HyperEVM confirmations (${latest.mintConfirmations}/6)`
			: latest?.status === 'ready_to_mint' ? 'Proof mint'
			: latest?.status === 'relaying_headers' ? 'Relaying finalized headers'
				: latest?.status === 'confirming_source' || latest?.status === 'source_submitted' ? `Waiting for TBC confirmations (${latest.sourceConfirmations}/6)`
					: latest?.status === 'signed' ? 'Signed locally' : 'Ready';

	return <details className="bridge-flow-history" open>
		<summary>Proof-backed Testnet v3 · {snapshot?.route ? 'live' : state?.gateway ? 'registering' : 'prepared, no broadcast'}</summary>
		<section className="htlc-section" aria-busy={Boolean(working)}>
			<h3>Gas-safe V3 bootstrap</h3>
			<p>Old V2 relay actions are paused. V3 starts at finalized checkpoint <strong>{manifest.checkpoint.height}</strong>, reuses four verified modules, and requires only a new Relay and Gateway.</p>
			<dl className="history-detail-grid">
				<div><dt>Checkpoint</dt><dd>{manifest.checkpoint.height} · <code>{manifest.checkpoint.hash}</code></dd></div>
				<div><dt>Prepared finality</dt><dd>6 confirmations at tip {manifest.checkpoint.height + 5}</dd></div>
				<div><dt>Bootstrap commitment</dt><dd><code>{manifest.bootstrap.commitmentRoot}</code></dd></div>
				<div><dt>Reusable verifiers</dt><dd>Finalized · Transition · Signature · Prefix</dd></div>
				<div><dt>V3 Relay</dt><dd><code>{state?.relay ?? 'Not deployed'}</code></dd></div>
				<div><dt>V3 Gateway</dt><dd><code>{state?.gateway ?? 'Not deployed'}</code></dd></div>
				<div><dt>Backend automation</dt><dd>{snapshot?.relayer.mode === 'automatic' ? <>Automatic · <code>{snapshot.relayer.address}</code>{snapshot.relayer.balanceWei !== null ? <> · {formatEther(BigInt(snapshot.relayer.balanceWei))} HYPE</> : null}</> : 'Observe-only until relayer key is configured'}</dd></div>
				<div><dt>Live progress</dt><dd>{realtime === 'live' ? 'WebSocket connected' : realtime}</dd></div>
			</dl>
			<div className="htlc-actions">
				{!state && <button type="button" disabled={!ready || Boolean(working)} onClick={() => { void reviewRoute(); }}>Verify reusable V3 route</button>}
				{state && next && !quote && <button type="button" disabled={!ready || Boolean(working)} onClick={() => { void reviewCost(); }}>Review {next} gas only</button>}
				{state && next && quote?.step === next && <button type="button" disabled={!ready || Boolean(working) || BigInt(quote.balanceWei) < BigInt(quote.maximumFeeWei)} onClick={() => { void deployReviewed(); }}>Deploy reviewed {next} with MetaMask</button>}
				{quote && <button type="button" className="secondary" disabled={Boolean(working)} onClick={() => setQuote(null)}>Discard gas review</button>}
			</div>
			{quote && <p className={BigInt(quote.balanceWei) >= BigInt(quote.maximumFeeWei) ? 'result success' : 'result error'}>Estimated gas: {BigInt(quote.estimatedGas).toLocaleString()} · maximum reviewed fee: {formatEther(BigInt(quote.maximumFeeWei))} HYPE · wallet balance: {formatEther(BigInt(quote.balanceWei))} HYPE. Reviewing does not charge gas.</p>}
			{state?.gateway && !snapshot?.route && <div className="htlc-actions"><button type="button" disabled={!ready || Boolean(working)} onClick={() => { void registerRoute(state).catch((cause) => setError(getErrorMessage(cause))); }}>Verify and register deployed V3 route</button></div>}
			{snapshot?.route && <section className="htlc-section">
				<h4>One-action V3 transfer</h4>
				<p>After the Turing Wallet signature, the exact source transaction is submitted once. The backend then waits for six confirmations, relays only required headers, builds the proof and submits the mint automatically.</p>
				<label>MT amount<input type="text" inputMode="decimal" placeholder="Example: 100" value={depositAmount} disabled={Boolean(working) || Boolean(latest && latest.status !== 'completed' && latest.status !== 'needs_review')} onChange={(event) => setDepositAmount(event.target.value)} /></label>
				<div className="htlc-actions"><button type="button" disabled={!ready || Boolean(working) || !depositAmount.trim() || Boolean(latest && latest.status !== 'completed' && latest.status !== 'needs_review') || snapshot.relayer.mode !== 'automatic'} onClick={() => { void startDeposit(); }}>Sign once and run complete V3 flow</button></div>
				<p className={latest?.status === 'needs_review' ? 'result error' : latest?.status === 'completed' ? 'result success' : 'result'}>Current stage: <strong>{stage}</strong>{latest ? <><br />TXID: <code>{latest.sourceTxid}</code><br />Source confirmations: {latest.sourceConfirmations}/6{latest.relayHeight ? <> · Relay height: {latest.relayHeight}</> : null}{latest.mintTxHash ? <><br />Mint transaction: <code>{latest.mintTxHash}</code> · confirmations: {latest.mintConfirmations}/6</> : null}{latest.lastError ? <><br />Attention: {latest.lastError}</> : null}</> : null}</p>
				{sourceTxid && <p className="result success">Source transaction accepted for automatic processing: <code>{sourceTxid}</code></p>}
			</section>}
			{working && <p role="status">{working}</p>}
			{error && <p className="result error" role="alert">{error}</p>}
		</section>
	</details>;
}
