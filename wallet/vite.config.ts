import { defineConfig } from 'vite';
import walletLogger from './server/walletLogger.ts';
import htlcBuilder from './server/htlcBuilder.ts';
import htlcHistory from './server/htlcHistory.ts';
import htlcSecrets from './server/htlcSecrets.ts';

export default defineConfig({
	plugins: [walletLogger(), htlcHistory(), htlcSecrets(), htlcBuilder()],
	server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/storage/**'] } },
});
