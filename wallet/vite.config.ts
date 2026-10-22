import { defineConfig } from 'vite';
import walletLogger from './server/walletLogger.ts';

export default defineConfig({
	plugins: [walletLogger()],
});
