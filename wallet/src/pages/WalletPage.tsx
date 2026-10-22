import { formatRawAmount, formatTokenBalance, getTransferPreview } from '../utils/tokenAmounts';
import { getErrorMessage } from '../utils/errors';
import type { FormEvent } from 'react';
import type { Token } from '../types/api';
import type { WalletPageProps } from '../types/wallet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { logAction } from '../services/actionLog';
import WalletConnection from '../components/WalletConnection';
import { DEVNET_DOMAIN } from '../config/constants';
import { getTokens } from '../services/tbcApi';

const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

export default function WalletPage({ session, hidden }: WalletPageProps) {
	const { wallet, address, networkIsDevnet, status, setStatus, result, setResult, busy, setBusy } = session;
	const [tokenName, setTokenName] = useState('Bryan Devnet Token');
	const [symbol, setSymbol] = useState('MDT');
	const [decimal, setDecimal] = useState('2');
	const [amount, setAmount] = useState('100000');
	const [recipient, setRecipient] = useState('');
	const [tokenContract, setTokenContract] = useState('');
	const [transferAmount, setTransferAmount] = useState('');
	const [page, setPage] = useState('mint');
	const [tokenList, setTokenList] = useState<{ address: string; tokens: Token[]; loading: boolean; error: string }>({ address: '', tokens: [], loading: false, error: '' });
	const tokenRequest = useRef<AbortController | null>(null);

	useEffect(() => {
		tokenRequest.current?.abort();
		setTokenContract('');
		setTokenList({ address: '', tokens: [], loading: false, error: '' });
		return () => tokenRequest.current?.abort();
	}, [address, networkIsDevnet, page, hidden]);

	async function loadTokens() {
		if (busy || !address || !networkIsDevnet) return;
		tokenRequest.current?.abort();
		const controller = new AbortController();
		tokenRequest.current = controller;
		setTokenList((previous) => ({ ...previous, address, loading: true, error: '' }));
		try {
			const tokens = await getTokens(address, { signal: controller.signal });
			if (!controller.signal.aborted) {
				setTokenList({ address, tokens, loading: false, error: '' });
				setTokenContract((current) => tokens.some((token) => token.contract_id === current) ? current : '');
			}
		} catch (error) {
			if (!controller.signal.aborted) setTokenList({ address, tokens: [], loading: false, error: getErrorMessage(error) });
		}
	}

	const selectedToken = tokenList.address === address && networkIsDevnet
		? tokenList.tokens.find((token) => token.contract_id === tokenContract)
		: null;
	const transferPreview = getTransferPreview(selectedToken, transferAmount);

	const parsedDecimal = Number(decimal);
	const parsedAmount = Number(amount);
	const preview = useMemo(
		() => (Number.isInteger(parsedDecimal) && parsedDecimal >= 0 && parsedDecimal <= 15 && Number.isSafeInteger(parsedAmount) && parsedAmount > 0
			? formatRawAmount(parsedAmount, parsedDecimal)
			: '—'),
		[parsedAmount, parsedDecimal],
	);

	async function mint(event: FormEvent<HTMLFormElement>) {
		let logData: unknown;
		const recordStatus = (message: string) => {
			setStatus(message);
			if (logData === undefined) logData = { status: message };
		};
		try {
			event.preventDefault();
			setResult(null);

			if (!wallet.isReady || !address) {
				recordStatus('Connect Turing Wallet first.');
				return;
			}
			if (!networkIsDevnet) {
				recordStatus('Safety stop: switch Turing Wallet to TBC Devnet before minting.');
				return;
			}
			if (tokenName.trim().length < 1 || tokenName.trim().length > 64) {
				recordStatus('Token name must contain 1–64 characters.');
				return;
			}
			if (!/^[A-Za-z0-9]{1,12}$/.test(symbol.trim())) {
				recordStatus('Symbol must be 1–12 letters or numbers.');
				return;
			}
			if (!Number.isInteger(parsedDecimal) || parsedDecimal < 0 || parsedDecimal > 15) {
				recordStatus('Decimal must be a whole number from 0 to 15.');
				return;
			}
			if (!Number.isSafeInteger(parsedAmount) || parsedAmount < 1 || parsedAmount > MAX_SAFE_AMOUNT) {
				recordStatus(`Raw amount must be a whole number from 1 to ${MAX_SAFE_AMOUNT.toLocaleString()}.`);
				return;
			}

			setBusy(true);
			recordStatus('Confirm the FT_MINT transaction in Turing Wallet.');
			try {
				const response = await wallet.sendTransaction([{
					flag: 'FT_MINT',
					ft_data: JSON.stringify({
						name: tokenName.trim(),
						symbol: symbol.trim().toUpperCase(),
						decimal: parsedDecimal,
						amount: parsedAmount,
					}),
					broadcastEnabled: true, // need to be true to broadcast the transaction and get a txid
					domain: DEVNET_DOMAIN,
				}]);
				logData = response ?? null;

				if (response?.txid) {
					setResult({ type: 'success', txid: response.txid });
					recordStatus('Mint transaction broadcast. Wait for confirmation, then refresh your Devnet token list.');
				} else {
					setResult({ type: 'error', message: response?.error ?? 'Wallet returned no TXID. The request may have been rejected or not broadcast.' });
					recordStatus('Minting did not complete. See the message below.');
				}
			} catch (error) {
				logData = { error };
				setResult({ type: 'error', message: getErrorMessage(error) ?? String(error) });
				recordStatus('Minting failed or was rejected in the wallet.');
			} finally {
				setBusy(false);
			}
		
		} finally {
			await logAction('Mint', logData ?? { status: 'No wallet response' });
		}
	}

	async function transfer(event: FormEvent<HTMLFormElement>) {
		let logData: unknown;
		const recordStatus = (message: string) => {
			setStatus(message);
			if (logData === undefined) logData = { status: message };
		};
		try {
			event.preventDefault();
			setResult(null);

			if (!wallet.isReady || !address) {
				recordStatus('Connect Turing Wallet first.');
				return;
			}
			if (!networkIsDevnet) {
				recordStatus('Safety stop: switch Turing Wallet to TBC Devnet before transferring.');
				return;
			}
			if (!recipient.trim() || !selectedToken || tokenList.loading) {
				recordStatus('Enter the recipient address and choose a token from your wallet.');
				return;
			}
			if (!transferPreview.valid) {
				recordStatus(transferPreview.error || 'Enter the token amount to send.');
				return;
			}

			setBusy(true);
			recordStatus('Confirm the FT_TRANSFER transaction in Turing Wallet.');
			try {
				const response = await wallet.sendTransaction([{
					flag: 'FT_TRANSFER',
					ft_contract_address: tokenContract.trim(),
					address: recipient.trim(),
					ft_amount: transferAmount.trim(), // Wallet accepts token units, not the API's raw balance units.
					broadcastEnabled: true,
					domain: DEVNET_DOMAIN,
				}]);
				logData = response ?? null;

				if (response?.txid) {
					setResult({ type: 'success', txid: response.txid });
					recordStatus('Transfer transaction broadcast. Wait for confirmation before treating it as complete.');
					setTokenContract('');
					setTokenList({ address: '', tokens: [], loading: false, error: '' });
				} else {
					setResult({ type: 'error', message: response?.error ?? 'Wallet returned no TXID. The transfer may have been rejected or not broadcast.' });
					recordStatus('Transfer did not complete. See the message below.');
				}
			} catch (error) {
				logData = { error };
				setResult({ type: 'error', message: getErrorMessage(error) ?? String(error) });
				recordStatus('Transfer failed or was rejected in the wallet.');
			} finally {
				setBusy(false);
			}
		
		} finally {
			await logAction('Transfer', logData ?? { status: 'No wallet response' });
		}
	}

	async function copyAddress() {
		try {
			await navigator.clipboard.writeText(address);
			setStatus('Devnet address copied to clipboard.');
		} catch {
			setStatus('Copy failed. Select and copy the address shown above.');
		}
	}

	return (
		<section className="card" hidden={hidden}>
				<p className="eyebrow">TBC TEST NETWORK ONLY</p>
				<h1>{page === 'mint' ? 'Devnet Token Minter' : page === 'receive' ? 'Receive TBC Devnet' : 'Transfer Devnet token'}</h1>
				<p className="intro">{page === 'mint'
					? 'Create a test FT through Turing Wallet. This page never receives your seed phrase or private key.'
					: page === 'receive'
						? 'Share your address to receive TBC Devnet. This page never receives your seed phrase or private key.'
						: 'Send an existing FT to another TBC Devnet address. Verify the recipient and token contract before approving.'}</p>

				<nav className="page-tabs" aria-label="Wallet actions">
					<button type="button" className={page === 'mint' ? 'selected' : ''} aria-pressed={page === 'mint'} onClick={() => setPage('mint')}>Mint token</button>
					<button type="button" className={page === 'receive' ? 'selected' : ''} aria-pressed={page === 'receive'} onClick={() => setPage('receive')}>Receive TBC</button>
					<button type="button" className={page === 'transfer' ? 'selected' : ''} aria-pressed={page === 'transfer'} onClick={() => setPage('transfer')}>Send token</button>
				</nav>

				<WalletConnection session={session} />

				{page === 'mint' && <>
				<form onSubmit={mint}>
					<label>
						Token name
						<input value={tokenName} maxLength={64} onChange={(event) => setTokenName(event.target.value)} placeholder="Example Token" required />
					</label>
					<label>
						Symbol
						<input value={symbol} maxLength={12} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="EXT" required />
					</label>
					<div className="grid">
						<label>
							Decimals
							<input value={decimal} inputMode="numeric" onChange={(event) => setDecimal(event.target.value)} placeholder="2" required />
						</label>
						<label>
							Initial amount (raw units)
							<input value={amount} inputMode="numeric" onChange={(event) => setAmount(event.target.value)} placeholder="100000" required />
						</label>
					</div>

					<aside>
						With <b>{parsedDecimal || 0}</b> decimals, <b>{amount || 0}</b> raw units display as approximately <b>{preview}</b> {symbol.trim().toUpperCase() || 'tokens'}.
					</aside>

					<button className="mint" type="submit" disabled={busy || !networkIsDevnet}>
						{busy ? 'Waiting for wallet…' : 'Mint Devnet token'}
					</button>
				</form>

				<p className="status" role="status">{status}</p>
				{result?.type === 'success' && <p className="result success">Broadcast TXID: <code>{result.txid}</code></p>}
				{result?.type === 'error' && <p className="result error">{result.message}</p>}

				<details>
					<summary>Before you mint</summary>
					<ul>
						<li>Keep Turing Wallet set to <b>TBC Devnet</b>; this app blocks mainnet requests.</li>
						<li>You need a small Devnet TBC balance for the transaction fee.</li>
						<li>“Raw units” are the smallest units. For example, 100000 raw units with 2 decimals displays as 1000 tokens.</li>
						<li>Only approve a wallet prompt whose details you have reviewed. Never enter a seed phrase here.</li>
					</ul>
				</details>
				</>}

				{page === 'receive' && <section className="receive-panel" aria-labelledby="receive-heading">
					<h2 id="receive-heading">Your receiving address</h2>
					{!networkIsDevnet
						? <p className="receive-notice">Connect Turing Wallet on TBC Devnet to create a receive QR code.</p>
						: address && <>
							<div className="qr-frame" aria-label="QR code for your TBC Devnet address">
								<QRCodeSVG value={address} size={248} level="M" marginSize={2} />
							</div>
							<p className="receive-notice">Ask the sender to scan this code with their wallet and select TBC Devnet. The QR code contains your address only; the sender enters the amount.</p>
							<code className="receive-address">{address}</code>
							<button type="button" className="copy-address" onClick={copyAddress}>Copy address</button>
						</>}
				</section>}

				{page === 'transfer' && <section className="transfer-panel" aria-labelledby="transfer-heading">
					<h2 id="transfer-heading">Send an FT</h2>
					<form onSubmit={transfer}>
						<label>
							Recipient TBC address
							<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Recipient address" autoComplete="off" required />
						</label>
						<p className="field-label" id="token-picker-label">FT contract address</p>
						<details className="token-picker" onToggle={(event) => {
							if (event.currentTarget.open) void loadTokens();
						}}>
							<summary aria-labelledby="token-picker-label" aria-disabled={busy || !address || !networkIsDevnet} onClick={(event) => {
								if (busy || !address || !networkIsDevnet) event.preventDefault();
							}}>
								{selectedToken ? `${selectedToken.name} | ${selectedToken.symbol} | ${formatTokenBalance(selectedToken)} | ${selectedToken.decimal} | ${selectedToken.contract_id.slice(0, 8)}…` : 'Choose a token'}
							</summary>
							<div className="token-options" aria-live="polite">
								{tokenList.loading ? <p>Loading tokens…</p> : tokenList.error ? <p className="result error" role="alert">Could not load tokens: {tokenList.error}. Close and reopen to retry.</p>
									: tokenList.tokens.length ? tokenList.tokens.map((token) => <button type="button" key={token.contract_id} disabled={busy} onClick={(event) => {
										setTokenContract(token.contract_id);
										const picker = event.currentTarget.closest('details');
										if (picker) picker.open = false;
									}}>
										{`${token.name} | ${token.symbol} | ${formatTokenBalance(token)} | ${token.decimal} | ${token.contract_id.slice(0, 8)}…${token.contract_id.slice(-6)}`}
									</button>) : <p>No FT tokens found for this wallet.</p>}
							</div>
						</details>
						{selectedToken && <p className="selected-contract">Contract: <code>{tokenContract}</code><br />Balance: {formatTokenBalance(selectedToken)} {selectedToken.symbol} ({String(selectedToken.balance)} raw units). Decimals: {selectedToken.decimal}.</p>}
						<label>
							<span className="amount-label"><span>Amount{selectedToken ? ` (${selectedToken.symbol})` : ''}</span>{selectedToken && <span className="amount-available" aria-live="polite">Available {transferPreview.remaining} {selectedToken.symbol}</span>}</span>
							<input value={transferAmount} inputMode="decimal" onChange={(event) => setTransferAmount(event.target.value)} placeholder="For example, 1.5" aria-invalid={Boolean(transferPreview.error)} aria-describedby={transferPreview.error ? 'transfer-amount-error' : undefined} required />
						</label>
						{transferPreview.error && <p id="transfer-amount-error" className="amount-error" role="status">{transferPreview.error}</p>}
						<aside>
							Use the exact contract address supplied by the token issuer; token names and symbols are not unique. Native TBC Devnet is required to pay the transaction fee.
						</aside>
						<button className="mint" type="submit" disabled={busy || !networkIsDevnet || tokenList.loading || !selectedToken || !transferPreview.valid}>
							{busy ? 'Waiting for wallet…' : 'Transfer token'}
						</button>
					</form>
					<p className="status" role="status">{status}</p>
					{result?.type === 'success' && <p className="result success">Broadcast TXID: <code>{result.txid}</code></p>}
					{result?.type === 'error' && <p className="result error">{result.message}</p>}
				</section>}
		</section>
	);
}
