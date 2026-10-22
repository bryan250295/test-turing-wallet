import { defineConfig } from 'vite';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { API_URLS } from './src/config/constants.js';

const logsDirectory = fileURLToPath(new URL('./logs/', import.meta.url));

function walletLogger() {
	const install = (server) => {
		server.middlewares.use(API_URLS.actionLog, async (request, response) => {
			if (request.method !== 'POST') {
				response.writeHead(405).end();
				return;
			}
			try {
				let body = '';
				for await (const chunk of request) {
					body += chunk;
					if (Buffer.byteLength(body) > 1024 * 1024) {
						response.writeHead(413).end();
						return;
					}
				}
				let entry;
				try {
					entry = JSON.parse(body);
				} catch {
					response.writeHead(400).end();
					return;
				}
				if (!['Connect', 'Mint', 'Transfer'].includes(entry?.action) || !Object.hasOwn(entry, 'data')) {
					response.writeHead(400).end();
					return;
				}
				const now = new Date();
				const date = new Intl.DateTimeFormat('en-CA', {
					timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
				}).format(now);
				const time = new Intl.DateTimeFormat('en-GB', {
					timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
				}).format(now);
				await mkdir(logsDirectory, { recursive: true });
				await appendFile(join(logsDirectory, date), `${date} ${time} ${entry.action}: ${JSON.stringify(entry.data)}\n`, 'utf8');
				response.writeHead(204).end();
			} catch (error) {
				server.config.logger.error(`Wallet log failed: ${error.message}`);
				response.writeHead(500).end();
			}
		});
	};
	return { name: 'wallet-action-logger', configureServer: install, configurePreviewServer: install };
}

export default defineConfig({
	plugins: [walletLogger()],
	server: {
		allowedHosts: ['.trycloudflare.com'],
	},
});
