import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import WalletPage from './pages/WalletPage';
import UtxoPage from './pages/UtxoPage';
import useWalletSession from './hooks/useWalletSession';
import TransactionPage from './pages/TransactionPage';
import BridgeLabPage from './pages/BridgeLabPage';

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
					<NavLink to="/bridge-lab">Bridge Lab</NavLink>
				</nav>
			</header>
			<Routes>
				<Route path="/" element={<Navigate to="/wallet" replace />} />
				<Route path="/wallet" element={<WalletPage session={session} />} />
				<Route path="/transaction" element={<TransactionPage session={session} />} />
				<Route path="/bridge-lab" element={<BridgeLabPage />} />
				<Route path="/inquiry" element={<Navigate to="/bridge-lab" replace />} />
				<Route path="/utxo" element={<UtxoPage session={session} />} />
				<Route path="*" element={<section className="card"><h1>Page not found</h1><p>Choose a page from the menu above.</p></section>} />
			</Routes>
		</main>
	);
}
