import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { TuringProvider } from 'turing-wallet-provider';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
	<StrictMode>
		<TuringProvider>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</TuringProvider>
	</StrictMode>,
);
