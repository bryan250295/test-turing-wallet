import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { TuringProvider } from 'turing-wallet-provider';
import App from './App';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element.');

createRoot(root).render(
	<StrictMode>
		<TuringProvider>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</TuringProvider>
	</StrictMode>,
);
