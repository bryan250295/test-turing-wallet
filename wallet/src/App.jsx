import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import WalletPage from './pages/WalletPage';
import UtxoPage from './pages/UtxoPage';
import WalletConnection from './WalletConnection';
import useWalletSession from './useWalletSession';
import TransactionPage from './pages/TransactionPage';
import InquiryPage from './pages/InquiryPage';

export default function App() {
	const session = useWalletSession();

	return (
		<main>
			<header className="site-header">
				<span className="site-brand">TBC Devnet</span>
				<nav className="top-menu" aria-label="Main navigation">
					<NavLink to="/wallet">Wallet</NavLink>
					<NavLink to="/utxo">UTXO List</NavLink>
					<NavLink to="/transaction">Transaction History</NavLink>
					<NavLink to="/inquiry">Inquiry</NavLink>
				</nav>
			</header>
			<Routes>
				<Route path="/" element={<Navigate to="/wallet" replace />} />
				<Route path="/wallet" element={<WalletPage session={session} />} />
				<Route path="/transaction" element={<TransactionPage session={session} />} />
				<Route path="/inquiry" element={<InquiryPage />} />
				<Route path="/utxo" element={<section className="card">
					<p className="eyebrow">TBC TEST NETWORK ONLY</p>
					<h1>UTXO List</h1>
					<p className="intro">Inspect the unspent outputs holding your native TBC and tokens.</p>
					<WalletConnection session={session} />
					<p className="status" role="status">{session.status}</p>
					<UtxoPage key={`${session.address}:${session.networkIsDevnet}`} address={session.address} networkIsDevnet={session.networkIsDevnet} />
				</section>} />
				<Route path="*" element={<section className="card"><h1>Page not found</h1><p>Choose a page from the menu above.</p></section>} />
			</Routes>
		</main>
	);
}
