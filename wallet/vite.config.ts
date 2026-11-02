import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const target = process.env.BACKEND_URL ?? 'http://127.0.0.1:3001';
const proxy = Object.fromEntries(['/api', '/__htlc', '/__wallet-log'].map((path) => [path, { target, changeOrigin: false, timeout: 100000, proxyTimeout: 100000 }]));
export default defineConfig({
  server: {
    proxy,
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../shared', import.meta.url))],
      deny: ['**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**', '**/storage/**', '**/.secrets/**', '**/.backups/**', '**/backend/**'],
    },
  },
  preview: { proxy },
});
