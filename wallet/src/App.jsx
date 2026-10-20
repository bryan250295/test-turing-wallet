import { useState } from 'react';
import WalletPage from './WalletPage';
import UtxoPage from './UtxoPage';
import WalletConnection from './WalletConnection';
import useWalletSession from './useWalletSession';

export default function App() {
  const [page, setPage] = useState('wallet');
  const session = useWalletSession();

  return (
    <main>
      <header className="site-header">
        <span className="site-brand">TBC Devnet</span>
        <nav className="top-menu" aria-label="Main navigation">
          <button type="button" aria-current={page === 'wallet' ? 'page' : undefined} onClick={() => setPage('wallet')}>Wallet</button>
          <button type="button" aria-current={page === 'utxos' ? 'page' : undefined} onClick={() => setPage('utxos')}>UTXO List</button>
        </nav>
      </header>
      <WalletPage session={session} hidden={page !== 'wallet'} />
      {page === 'utxos' && <section className="card">
        <p className="eyebrow">TBC TEST NETWORK ONLY</p>
        <h1>UTXO List</h1>
        <p className="intro">Inspect the unspent outputs holding your native TBC and tokens.</p>
        <WalletConnection session={session} />
        <p className="status" role="status">{session.status}</p>
        <UtxoPage key={`${session.address}:${session.networkIsDevnet}`} address={session.address} networkIsDevnet={session.networkIsDevnet} />
      </section>}
    </main>
  );
}
