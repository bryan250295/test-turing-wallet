import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import WalletPage from './pages/WalletPage';
import UtxoPage from './pages/UtxoPage';
import useWalletSession from './hooks/useWalletSession';
import TransactionPage from './pages/TransactionPage';
import BridgeLabPage from './pages/BridgeLabPage';
import CreateBridgingOrderPage from './pages/CreateBridgingOrderPage';
import BridgeTransferDetailsPage from './pages/BridgeTransferDetailsPage';

export default function App() {
	const session = useWalletSession();
	const location = useLocation();

	return (
		<main>
			<header className="site-header">
				<span className="site-brand">TBC Devnet</span>
				<nav className="top-menu" aria-label="Main navigation">
					<NavLink to="/wallet">Wallet</NavLink>
					<NavLink to="/utxo">UTXO List</NavLink>
					<NavLink to="/transaction">Transaction History</NavLink>
					<NavLink className={({ isActive }) => isActive || location.pathname.startsWith('/create_bridging_order') || location.pathname.startsWith('/bridge-transfer') ? 'top-menu-current' : undefined} to="/bridge-lab">Bridge</NavLink>
				</nav>
			</header>
			<Routes>
				<Route path="/" element={<Navigate to="/wallet" replace />} />
				<Route path="/wallet" element={<WalletPage session={session} />} />
				<Route path="/transaction" element={<TransactionPage session={session} />} />
				<Route path="/bridge-lab" element={<BridgeLabPage session={session} />} />
				<Route path="/create_bridging_order" element={<Navigate to="/bridge-lab?tab=testnet-bridge" replace />} />
				<Route path="/create_bridging_order/:orderId" element={<CreateBridgingOrderPage session={session} />} />
				<Route path="/bridge-transfer/:requestId" element={<BridgeTransferDetailsPage session={session} />} />
				<Route path="/inquiry" element={<Navigate to="/bridge-lab?tab=overview" replace />} />
				<Route path="/utxo" element={<UtxoPage session={session} />} />
				<Route path="*" element={<section className="card"><h1>Page not found</h1><p>Choose a page from the menu above.</p></section>} />
			</Routes>
		</main>
	);
}
