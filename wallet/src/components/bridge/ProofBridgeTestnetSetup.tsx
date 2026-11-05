import { useEffect, useMemo, useRef, useState } from 'react';
import {
	createPublicClient, encodeDeployData, getAddress, http, keccak256, ripemd160, sha256,
	toHex, type Address, type Hex,
} from 'viem';
import manifest from '../../generated/phase3-testnet-v2-deployment.json';
import { HYPEREVM_TESTNET } from '../../config/hyperevm';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import { getErrorMessage } from '../../utils/errors';

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
			</div>
			{working && <p role="status">{working}</p>}
			{error && <p className="result error" role="alert">{error}</p>}
			{state?.gateway && <p className="result success" role="status">Public Testnet-v2 contracts deployed and checkpoint bindings verified. Continue with header relay and a new deposit only.</p>}
		</section>
	</details>;
}
