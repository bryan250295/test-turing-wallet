import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { API_URLS } from '../src/config/constants';
import { getStoredHtlcRequest, listStoredHtlcRequests, saveStoredHtlcRequest } from './htlc/requestStorage';
import { parseHtlcRequest } from '../src/utils/htlcRequestHistory';

export default function htlcHistory(): Plugin {
	const install = (server: ViteDevServer | PreviewServer) => {
		// Storage is accessed through the history API, never served as static files.
		server.middlewares.use((request, response, next) => {
			let path: string;
			try { path = decodeURIComponent((request.url ?? '').split('?')[0]).replaceAll('\\', '/'); }
			catch { response.writeHead(400).end(); return; }
			if (/(^|\/)storage(\/|$)/i.test(path)) { response.writeHead(403).end(); return; }
			next();
		});
		server.middlewares.use(API_URLS.htlcHistory, async (request, response, next) => {
			const url = new URL(request.url ?? '', 'http://localhost');
			const path = url.pathname.replace(/\/+$/, '') || '/';
			// The status resource is handled by the bounded HTLC worker queue.
			if (path === '/status') { next(); return; }
			response.setHeader('Content-Type', 'application/json');
			response.setHeader('Cache-Control', 'no-store');
			if (request.headers.origin && (!URL.canParse(request.headers.origin) || new URL(request.headers.origin).host !== request.headers.host)) { response.writeHead(403).end(JSON.stringify({ message: 'Use the local app origin.' })); return; }
			try {
				let result: unknown;
				if (path !== '/') {
					if (request.method !== 'GET') { response.writeHead(405).end(JSON.stringify({ message: 'Use GET for a saved lock.' })); return; }
					if (!/^\/[0-9a-f]{64}$/i.test(path)) { response.writeHead(404).end(JSON.stringify({ message: 'Lock resource not found.' })); return; }
					const record = await getStoredHtlcRequest(path.slice(1).toLowerCase());
					if (!record) { response.writeHead(404).end(JSON.stringify({ message: 'No saved record exists for this lock.' })); return; }
					response.end(JSON.stringify({ data: record }));
					return;
				}
				if (request.method === 'GET') {
					const address = url.searchParams.get('address') ?? '';
					if (!/^[1-9A-HJ-NP-Za-km-z]{26,100}$/.test(address)) { response.writeHead(400).end(JSON.stringify({ message: 'Provide a wallet address.' })); return; }
					result = await listStoredHtlcRequests(address);
				} else if (request.method === 'POST') {
					let body = '';
					for await (const chunk of request) {
						body += chunk;
						if (Buffer.byteLength(body) > 16384) { response.writeHead(413).end(JSON.stringify({ message: 'Request metadata is too large.' })); return; }
					}
					let value: unknown;
					try { value = parseHtlcRequest(JSON.parse(body)); }
					catch { response.writeHead(400).end(JSON.stringify({ message: 'Invalid request metadata.' })); return; }
					result = await saveStoredHtlcRequest(value);
				} else { response.writeHead(405).end(JSON.stringify({ message: 'Use GET or POST.' })); return; }
				response.end(JSON.stringify({ data: result }));
			} catch {
				response.writeHead(500).end(JSON.stringify({ message: 'HTLC history could not be saved or loaded from wallet/storage. Keep your receipt and check folder permissions.' }));
			}
		});
	};
	return { name: 'local-htlc-history', configureServer: install, configurePreviewServer: install };
}
