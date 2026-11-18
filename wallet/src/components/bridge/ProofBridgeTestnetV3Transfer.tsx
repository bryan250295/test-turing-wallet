import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatEther, getAddress } from 'viem';
import { BRIDGE_ROUTE_CATALOG } from '../../../../shared/src/config/bridgeRoutes';
import type { ProofBridgeV3Snapshot } from '../../../../shared/src/types/proofBridgeV3';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { WalletAddresses, WalletSession } from '../../types/wallet';
import { getErrorMessage } from '../../utils/errors';
import {
	buildPhase3TestnetDeposit, broadcastPhase3TestnetDeposit, finalizePhase3TestnetDeposit,
	phase3TestnetDepositSigningRequest,
} from '../../services/phase3TestnetDeposit';
import { connectProofBridgeV3Progress, getProofBridgeV3GasPreflight, getProofBridgeV3Progress } from '../../services/proofBridgeV3';

type EvmWallet = ReturnType<typeof useHyperEvmWallet>;
const routeDefinition = BRIDGE_ROUTE_CATALOG.find((route) => route.id === 'mt-v3-hyperevm-testnet')!;

function normalizedPublicKey(value: string) {
	const key = value.trim().toLowerCase().replace(/^0x/, '');
	if (!/^(?:02|03)[0-9a-f]{64}$|^04[0-9a-f]{128}$/.test(key)) throw new Error('Turing Wallet returned an invalid TBC public key.');
	return key;
}

export default function ProofBridgeTestnetV3Transfer({ session, evm, active }: { session: WalletSession; evm: EvmWallet; active: boolean }) {
	const [snapshot, setSnapshot] = useState<ProofBridgeV3Snapshot | null>(null);
	const [realtime, setRealtime] = useState<'off' | 'connecting' | 'live' | 'reconnecting'>('off');
	const [amount, setAmount] = useState('');
	const [sourceTxid, setSourceTxid] = useState('');
	const [working, setWorking] = useState('');
	const [error, setError] = useState('');
	const running = useRef(false);

	useEffect(() => {
		if (!active || !session.address || !session.backendAuth.ready) { setRealtime('off'); return; }
		const controller = new AbortController();
		void getProofBridgeV3Progress(controller.signal).then(setSnapshot).catch((cause) => {
			if (!controller.signal.aborted) setError(getErrorMessage(cause));
		});
		const disconnect = connectProofBridgeV3Progress(setSnapshot, setRealtime);
		return () => { controller.abort(); disconnect(); setRealtime('off'); };
	}, [active, session.address, session.backendAuth.ready]);

	async function verifyWallets() {
		const [network, addresses, key, current] = await Promise.all([
			session.wallet.getNetwork(), session.wallet.getAddress(), session.wallet.getPubKey(), evm.readCurrent(),
		]);
		const walletAddresses = addresses as WalletAddresses | undefined;
		const source = walletAddresses?.tbcAddress ?? walletAddresses?.addresses?.tbcAddress;
		if (network?.network !== 'tbc' || network.type !== 'testnet' || !source || source !== session.address) throw new Error('Reconnect the same Turing Wallet account on TBC Testnet.');
		if (current.chainId !== routeDefinition.destinationChainId || !current.address) throw new Error('Connect MetaMask on HyperEVM Testnet (chain 998).');
		return { sourceAddress: source, recipient: getAddress(current.address), publicKey: normalizedPublicKey(key?.tbcPubKey ?? '') };
	}

	async function startDeposit() {
		if (!ready || !snapshot?.route || running.current) return;
		running.current = true; session.setBusy(true); setWorking('Rechecking the full Testnet HYPE budget…'); setError(''); setSourceTxid('');
		try {
			const latestPreflight = await getProofBridgeV3GasPreflight();
			if (!latestPreflight.sufficient || latestPreflight.requiredWei === null) {
				const required = latestPreflight.requiredWei === null ? 'unavailable' : `${formatEther(BigInt(latestPreflight.requiredWei))} HYPE`;
				const balance = latestPreflight.balanceWei === null ? 'unavailable' : `${formatEther(BigInt(latestPreflight.balanceWei))} HYPE`;
				const shortfall = latestPreflight.shortfallWei === null ? 'unavailable' : `${formatEther(BigInt(latestPreflight.shortfallWei))} HYPE`;
				throw new Error(`Transfer cannot start yet. The operator relayer requires ${required}, currently has ${balance}, and is short by ${shortfall}. You pay 0 HYPE. ${latestPreflight.reason ?? ''}`.trim());
			}
			setWorking('Building and locally reviewing the MT deposit…');
			const wallets = await verifyWallets();
			const controller = new AbortController();
			const deposit = await buildPhase3TestnetDeposit({
				sender: wallets.sourceAddress, publicKey: wallets.publicKey,
				contractId: routeDefinition.sourceContractId, amount: amount.trim(), recipient: wallets.recipient,
			}, controller.signal);
			setWorking('Review and sign the exact MT deposit in Turing Wallet…');
			const request = await phase3TestnetDepositSigningRequest(deposit, controller.signal);
			const response = await session.wallet.signTransaction(request);
			if (response?.error) throw new Error(response.error);
			if (!response?.sigs || response.sigs.length !== 1 || !Array.isArray(response.sigs[0]) || response.sigs[0].length !== deposit.inputs.length) throw new Error('Turing Wallet did not sign every reviewed deposit input.');
			setWorking('Verifying signatures, FT transition and Bridge Covenant proof…');
			const signed = await finalizePhase3TestnetDeposit(deposit.buildId, wallets.publicKey, response.sigs[0], controller.signal);
			setWorking('Confirming the exact signed deposit was submitted once…');
			const receipt = await broadcastPhase3TestnetDeposit(deposit.buildId, signed.txid, false, controller.signal);
			if (receipt.status === 'rejected') throw new Error(receipt.message);
			setSourceTxid(signed.txid); setAmount('');
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { session.setBusy(false); running.current = false; setWorking(''); }
	}

	const latest = snapshot?.transfers[0];
	const hasActive = Boolean(latest && latest.status !== 'completed' && latest.status !== 'needs_review');
	const ready = active && session.networkIsDevnet && Boolean(session.address) && session.backendAuth.ready
		&& evm.networkIsTestnet && Boolean(evm.address) && !session.busy && !evm.pending && Boolean(snapshot?.route)
		&& !hasActive && amount.trim().length > 0;
	const stage = latest?.status === 'completed' ? 'Completed'
		: latest?.status === 'mint_submitted' ? `Waiting for HyperEVM confirmations (${latest.mintConfirmations}/6)`
			: latest?.status === 'ready_to_mint' ? 'Submitting proof mint'
				: latest?.status === 'relaying_headers' ? 'Relaying finalized TBC headers'
					: latest?.status === 'confirming_source' || latest?.status === 'source_submitted' ? `Waiting for TBC confirmations (${latest.sourceConfirmations}/6)`
						: latest?.status === 'signed' ? 'Signed locally' : 'Ready';

	return <section className="htlc-section proof-transfer" aria-labelledby="proof-transfer-title" aria-busy={Boolean(working)}>
		<header className="history-titlebar"><div><h3 id="proof-transfer-title">2. Send MT and receive wMT</h3><p>One Turing Wallet signature starts the complete proof-backed flow. No contract deployment or MetaMask transaction is required from the user.</p></div><span className={`network-pill ${realtime === 'live' ? 'route-live' : ''}`}>{realtime === 'live' ? 'Live progress' : realtime}</span></header>
		{snapshot?.route ? <dl className="history-detail-grid">
			<div><dt>Source token</dt><dd>{routeDefinition.sourceName} ({routeDefinition.sourceSymbol}) · <code>{routeDefinition.sourceContractId}</code></dd></div>
			<div><dt>Receive token</dt><dd>{routeDefinition.wrappedName} ({routeDefinition.wrappedSymbol}) · <code>{snapshot.route.wrappedToken}</code></dd></div>
			<div><dt>Shared Gateway</dt><dd><code>{snapshot.route.gateway}</code></dd></div>
			<div><dt>Shared Header Relay</dt><dd><code>{snapshot.route.relay}</code></dd></div>
		</dl> : <p className="result error">The shared MT → wMT route is not deployed yet. An operator must complete it once in <Link to="/bridge-lab?tab=admin">Admin</Link>; users never deploy their own copy.</p>}
		{!snapshot?.route && <p className="history-note">The one-time Relay and Gateway deployment budget belongs to Admin. Runtime Header relay and mint gas will be shown here only after that shared route is live.</p>}
		{snapshot?.relayer.mode === 'observe-only' && <p className="result error">The backend relayer is observe-only. Operator signing must be enabled before a user transfer can start.</p>}
		<label htmlFor="proof-transfer-amount">Amount ({routeDefinition.sourceSymbol})</label>
		<input id="proof-transfer-amount" type="text" inputMode="decimal" autoComplete="off" placeholder="Amount" value={amount} disabled={Boolean(working) || hasActive} onChange={(event) => setAmount(event.target.value)} />
		<div className="htlc-actions"><button type="button" disabled={!ready || Boolean(working)} onClick={() => { void startDeposit(); }}>{working ? 'Transfer running…' : !snapshot?.route ? 'Waiting for Admin deployment' : 'Sign MT deposit and start automatic transfer'}</button></div>
		<p className="history-note">The source wallet pays only the TBC transaction fee. Header relay and proof-mint gas are paid by the operator relayer.</p>
		{latest && <p className={latest.status === 'needs_review' ? 'result error' : latest.status === 'completed' ? 'result success' : 'result'}>Current stage: <strong>{stage}</strong><br />TXID: <code>{latest.sourceTxid}</code><br />TBC confirmations: {latest.sourceConfirmations}/6{latest.relayHeight ? <> · Relay height: {latest.relayHeight}</> : null}{latest.mintTxHash ? <><br />Mint transaction: <code>{latest.mintTxHash}</code> · HyperEVM confirmations: {latest.mintConfirmations}/6</> : null}{latest.lastError ? <><br />Attention: {latest.lastError}</> : null}</p>}
		{sourceTxid && <p className="result success">Deposit accepted for automatic processing: <code>{sourceTxid}</code></p>}
		{working && <p role="status">{working}</p>}
		{error && <p className="result error" role="alert">{error}</p>}
	</section>;
}
