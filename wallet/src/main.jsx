import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TuringProvider } from 'turing-wallet-provider';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TuringProvider>
      <App />
    </TuringProvider>
  </StrictMode>,
);
