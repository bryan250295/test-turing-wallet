import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTuringWallet } from 'turing-wallet-provider';

const DEVNET_DOMAIN = 'api.tbcdev.org';
const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

function formatRawAmount(rawAmount, decimal) {
  const divisor = 10 ** decimal;
  if (!Number.isFinite(divisor) || divisor === 0) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimal }).format(rawAmount / divisor);
}

export default function App() {
  const wallet = useTuringWallet();
  const [address, setAddress] = useState('');
  const [network, setNetwork] = useState(null);
  const [walletInfo, setWalletInfo] = useState(null);
  const [name, setName] = useState('My Devnet Token');
  const [symbol, setSymbol] = useState('MDT');
  const [decimal, setDecimal] = useState('2');
  const [amount, setAmount] = useState('100000');
  const [recipient, setRecipient] = useState('');
  const [tokenContract, setTokenContract] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [status, setStatus] = useState('Open this page in Turing Wallet’s DApp browser, then connect your wallet.');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState('mint');

  const networkIsDevnet = network?.network === 'tbc' && network?.type === 'testnet';
  const parsedDecimal = Number(decimal);
  const parsedAmount = Number(amount);
  const walletName = typeof walletInfo?.walletName === 'string'
    ? walletInfo.walletName
    : typeof walletInfo?.name === 'string' ? walletInfo.name : 'Turing Wallet';
  const walletVersion = typeof walletInfo?.version === 'string' || typeof walletInfo?.version === 'number'
    ? walletInfo.version
    : null;
  const networkLabel = network
    ? [network.network, network.type].filter(Boolean).join(' / ') || 'Connected'
    : 'Not connected';
  const preview = useMemo(
    () => (Number.isInteger(parsedDecimal) && parsedDecimal >= 0 && parsedDecimal <= 15 && Number.isSafeInteger(parsedAmount) && parsedAmount > 0
      ? formatRawAmount(parsedAmount, parsedDecimal)
      : '—'),
    [parsedAmount, parsedDecimal],
  );

  useEffect(() => {
    let active = true;
    const refreshWalletDetails = async (networkOverride) => {
      if (!wallet.isReady) return false;
      try {
        const [walletAddresses, currentNetwork, info] = await Promise.all([
          wallet.getAddress(),
          wallet.getNetwork(),
          wallet.getInfo(),
        ]);
        if (!active) return false;
        setAddress(walletAddresses?.tbcAddress ?? walletAddresses?.addresses?.tbcAddress ?? '');
        setNetwork(networkOverride ?? currentNetwork ?? null);
        setWalletInfo(info ?? null);
        return true;
      } catch {
        return false;
      }
    };
    const onNetworkChanged = (event) => {
      void refreshWalletDetails(event.detail?.network);
    };
    const onAccountChanged = () => {
      void refreshWalletDetails();
    };
    const onVisibilityChanged = () => {
      if (document.visibilityState === 'visible' && address) void refreshWalletDetails();
    };

    window.addEventListener('TuringNetworkChanged', onNetworkChanged);
    window.addEventListener('TuringAccountChanged', onAccountChanged);
    document.addEventListener('visibilitychange', onVisibilityChanged);
    return () => {
      active = false;
      window.removeEventListener('TuringNetworkChanged', onNetworkChanged);
      window.removeEventListener('TuringAccountChanged', onAccountChanged);
      document.removeEventListener('visibilitychange', onVisibilityChanged);
    };
  }, [wallet, address]);

  async function connect() {
    setResult(null);
    setAddress('');
    setNetwork(null);
    setWalletInfo(null);
    if (!wallet.isReady) {
      setStatus('Turing Wallet was not detected. Open this URL inside the Turing Wallet mobile DApp browser, not Safari or Chrome.');
      return;
    }

    setBusy(true);
    try {
      const connectResult = await wallet.connect();
      const [walletAddresses, currentNetwork, info] = await Promise.all([
        wallet.getAddress(),
        wallet.getNetwork(),
        wallet.getInfo(),
      ]);
      const connectedAddress = walletAddresses?.tbcAddress
        ?? connectResult?.tbcAddress
        ?? connectResult?.addresses?.tbcAddress
        ?? '';
      setWalletInfo(info ?? null);
      if (!connectedAddress) {
        setNetwork(currentNetwork);
        setStatus('Connected, but Turing Wallet did not return a TBC address. Select a TBC account in the extension and reconnect.');
        return;
      }
      setAddress(connectedAddress);
      setNetwork(currentNetwork);
      setStatus(currentNetwork?.network === 'tbc' && currentNetwork?.type === 'testnet'
        ? 'Devnet connected. Review your token details, then mint.'
        : 'Connected, but switch the wallet to TBC Devnet before minting.');
    } catch (error) {
      setStatus(`Connection failed: ${error.message ?? String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function mint(event) {
    event.preventDefault();
    setResult(null);

    if (!wallet.isReady || !address) {
      setStatus('Connect Turing Wallet first.');
      return;
    }
    if (!networkIsDevnet) {
      setStatus('Safety stop: switch Turing Wallet to TBC Devnet before minting.');
      return;
    }
    if (name.trim().length < 1 || name.trim().length > 64) {
      setStatus('Token name must contain 1–64 characters.');
      return;
    }
    if (!/^[A-Za-z0-9]{1,12}$/.test(symbol.trim())) {
      setStatus('Symbol must be 1–12 letters or numbers.');
      return;
    }
    if (!Number.isInteger(parsedDecimal) || parsedDecimal < 0 || parsedDecimal > 15) {
      setStatus('Decimal must be a whole number from 0 to 15.');
      return;
    }
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount < 1 || parsedAmount > MAX_SAFE_AMOUNT) {
      setStatus(`Raw amount must be a whole number from 1 to ${MAX_SAFE_AMOUNT.toLocaleString()}.`);
      return;
    }

    setBusy(true);
    setStatus('Confirm the FT_MINT transaction in Turing Wallet.');
    try {
      const response = await wallet.sendTransaction([{
        flag: 'FT_MINT',
        ft_data: JSON.stringify({
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          decimal: parsedDecimal,
          amount: parsedAmount,
        }),
        broadcastEnabled: false,
        domain: DEVNET_DOMAIN,
      }]);

      if (response?.txid) {
        setResult({ type: 'success', txid: response.txid });
        setStatus('Mint transaction broadcast. Wait for confirmation, then refresh your Devnet token list.');
      } else {
        setResult({ type: 'error', message: response?.error ?? 'Wallet returned no TXID. The request may have been rejected or not broadcast.' });
        setStatus('Minting did not complete. See the message below.');
      }
    } catch (error) {
      setResult({ type: 'error', message: error.message ?? String(error) });
      setStatus('Minting failed or was rejected in the wallet.');
    } finally {
      setBusy(false);
    }
  }

  async function transfer(event) {
    event.preventDefault();
    setResult(null);

    if (!wallet.isReady || !address) {
      setStatus('Connect Turing Wallet first.');
      return;
    }
    if (!networkIsDevnet) {
      setStatus('Safety stop: switch Turing Wallet to TBC Devnet before transferring.');
      return;
    }
    if (!recipient.trim() || !tokenContract.trim()) {
      setStatus('Enter the recipient address and the exact FT contract address.');
      return;
    }
    if (!/^\d+$/.test(transferAmount.trim()) || BigInt(transferAmount.trim()) < 1n) {
      setStatus('FT amount must be a positive whole number of raw units.');
      return;
    }

    setBusy(true);
    setStatus('Confirm the FT_TRANSFER transaction in Turing Wallet.');
    try {
      const response = await wallet.sendTransaction([{
        flag: 'FT_TRANSFER',
        ft_contract_address: tokenContract.trim(),
        address: recipient.trim(),
        ft_amount: transferAmount.trim(),
        broadcastEnabled: false,
        domain: DEVNET_DOMAIN,
      }]);

      if (response?.txid) {
        setResult({ type: 'success', txid: response.txid });
        setStatus('Transfer transaction broadcast. Wait for confirmation before treating it as complete.');
      } else {
        setResult({ type: 'error', message: response?.error ?? 'Wallet returned no TXID. The transfer may have been rejected or not broadcast.' });
        setStatus('Transfer did not complete. See the message below.');
      }
    } catch (error) {
      setResult({ type: 'error', message: error.message ?? String(error) });
      setStatus('Transfer failed or was rejected in the wallet.');
    } finally {
      setBusy(false);
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
    <main>
      <section className="card">
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

        <div className="connection">
          <div className="connection-info">
            <strong><span className={`dot ${networkIsDevnet ? 'ok' : ''}`} />{networkIsDevnet ? 'TBC Devnet connected' : 'Wallet not connected to Devnet'}</strong>
            <dl className="wallet-details">
              <div><dt>Wallet</dt><dd>{walletName}</dd></div>
              <div><dt>Network</dt><dd>{networkLabel}</dd></div>
              <div className="account-detail"><dt>Account</dt><dd><code title={address}>{address || 'Not connected'}</code></dd></div>
              {walletVersion !== null && <div><dt>Version</dt><dd>{walletVersion}</dd></div>}
            </dl>
          </div>
          <button type="button" onClick={connect} disabled={busy}>
            {busy ? 'Working…' : address ? 'Reconnect' : 'Connect wallet'}
          </button>
        </div>

        {page === 'mint' && <>
        <form onSubmit={mint}>
          <label>
            Token name
            <input value={name} maxLength="64" onChange={(event) => setName(event.target.value)} placeholder="Example Token" required />
          </label>
          <label>
            Symbol
            <input value={symbol} maxLength="12" onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="EXT" required />
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
            <label>
              FT contract address
              <input value={tokenContract} onChange={(event) => setTokenContract(event.target.value)} placeholder="Exact contract address for TBC-TEST" autoComplete="off" required />
            </label>
            <label>
              Amount (raw units)
              <input value={transferAmount} inputMode="numeric" onChange={(event) => setTransferAmount(event.target.value)} placeholder="For example, 1000" required />
            </label>
            <aside>
              Use the exact contract address supplied by the token issuer; token names and symbols are not unique. Native TBC Devnet is required to pay the transaction fee.
            </aside>
            <button className="mint" type="submit" disabled={busy || !networkIsDevnet}>
              {busy ? 'Waiting for wallet…' : 'Transfer token'}
            </button>
          </form>
          <p className="status" role="status">{status}</p>
          {result?.type === 'success' && <p className="result success">Broadcast TXID: <code>{result.txid}</code></p>}
          {result?.type === 'error' && <p className="result error">{result.message}</p>}
        </section>}
      </section>
    </main>
  );
}
