import { useEffect, useRef, useState } from 'react';
import type { WalletSession } from '../../types/wallet';
import type useHyperEvmWallet from '../../hooks/useHyperEvmWallet';
import type { V15MultisigDeploymentStatus, V15OperatorRoles } from '../../types/learningBridge';
import { checkV15Multisig, clearSavedV15Multisig, getV15Roles, previewV15Multisig, savedV15Multisig, saveV15Multisig } from '../../services/v15Multisig';
import { formatHypeBalance } from '../../services/evmWallet';
import { getErrorMessage } from '../../utils/errors';

export default function V15MultisigSetup({ session, evm, active, onReady }: { session: WalletSession; evm: ReturnType<typeof useHyperEvmWallet>; active: boolean; onReady: (address: string | null, minter: string | null) => void }) {
	const [roles, setRoles] = useState<V15OperatorRoles | null>(null);
	const [status, setStatus] = useState<V15MultisigDeploymentStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const checking = useRef(false);

	useEffect(() => {
		const controller = new AbortController();
		setRoles(null); setStatus(null); setError(''); onReady(null, null);
		if (!active || !session.backendAuth.ready) return () => controller.abort();
		void (async () => {
			try {
				const configured = await getV15Roles(controller.signal);
				if (controller.signal.aborted) return;
				setRoles(configured);
				const saved = savedV15Multisig();
				if (saved) setStatus(await checkV15Multisig(saved.txHash, controller.signal));
			} catch (cause) { if (!controller.signal.aborted) setError(getErrorMessage(cause)); }
		})();
		return () => controller.abort();
	}, [active, session.address, session.backendAuth.ready]);

	useEffect(() => {
		if (status?.status === 'verified' && status.contractAddress && roles) onReady(status.contractAddress, roles.minter);
		else onReady(null, roles?.minter ?? null);
	}, [status?.status, status?.contractAddress, roles?.minter]);

	useEffect(() => {
		if (!active || !status || !['pending', 'confirming'].includes(status.status) || checking.current) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		checking.current = true;
		void (async () => {
			try {
				for (let attempt = 0; attempt < 72 && !controller.signal.aborted; attempt++) {
					if (attempt) await new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
					if (controller.signal.aborted) break;
					const next = await checkV15Multisig(status.txHash, controller.signal);
					if (!controller.signal.aborted) setStatus(next);
					if (!['pending', 'confirming'].includes(next.status)) break;
				}
			} catch (cause) { if (!controller.signal.aborted) setError(getErrorMessage(cause)); }
			finally { checking.current = false; }
		})();
		return () => { controller.abort(); clearTimeout(timer); checking.current = false; };
	}, [active, status?.txHash, status?.status]);

	async function deploy() {
		if (!roles || !evm.address || !evm.networkIsTestnet || busy) return;
		setBusy(true); setError('');
		try {
			const preview = await previewV15Multisig(evm.address, AbortSignal.timeout(45_000));
			if (!preview.sufficientBalance) throw new Error(`The connected deployment wallet needs ${formatHypeBalance(preview.bufferedFeeWei)} HYPE but has only ${formatHypeBalance(preview.balanceWei)} HYPE.`);
			const txHash = await evm.sendDeployment(preview.transaction);
			saveV15Multisig(txHash);
			setStatus({ status: 'pending', txHash, contractAddress: preview.predictedAddress, confirmations: 0, confirmationsRequired: preview.confirmationsRequired, actualFeeWei: null, lastError: null });
		} catch (cause) { setError(getErrorMessage(cause)); }
		finally { setBusy(false); }
	}

	return <section className="htlc-section bridge-deployment" aria-labelledby="v15-multisig-title">
		<h4 id="v15-multisig-title">Fixed 2-of-2 Admin multisig</h4>
		{roles && <dl className="history-detail-grid">
			<div><dt>Signer 1</dt><dd><code>{roles.signer1}</code></dd></div>
			<div><dt>Signer 2</dt><dd><code>{roles.signer2}</code></dd></div>
			<div><dt>Minter · separate role</dt><dd><code>{roles.minter}</code></dd></div>
			<div><dt>Approval threshold</dt><dd>2 of 2</dd></div>
		</dl>}
		{!status && <button type="button" disabled={!roles || !evm.address || !evm.networkIsTestnet || busy || !!evm.pending} onClick={() => { void deploy(); }}>{busy ? 'Preparing multisig deployment…' : 'Deploy configured Admin multisig'}</button>}
		{status && <p className={`result ${status.status === 'verified' ? 'success' : ['reverted', 'invalid'].includes(status.status) ? 'error' : 'warning'}`}>
			<strong>{status.status === 'verified' ? 'Admin multisig verified.' : status.status === 'confirming' ? 'Multisig deployment confirming.' : status.status === 'pending' ? 'Multisig deployment submitted.' : 'Multisig deployment failed.'}</strong>
			{' '}{status.contractAddress && <>Contract: <code>{status.contractAddress}</code>. </>}{status.confirmations} / {status.confirmationsRequired} confirmations.{status.actualFeeWei && <> Actual fee: {formatHypeBalance(status.actualFeeWei)} HYPE.</>}
		</p>}
		{status?.lastError && <p className="result error" role="alert">{status.lastError}</p>}
		{status && ['reverted', 'invalid'].includes(status.status) && <button type="button" className="history-secondary" disabled={busy} onClick={() => { clearSavedV15Multisig(); setStatus(null); setError(''); }}>Discard failed deployment and retry</button>}
		{error && <p className="result error" role="alert">{error}</p>}
		<p className="history-note">Addresses come from the backend environment. MetaMask still requires an explicit confirmation because no private key is stored by the application.</p>
	</section>;
}
