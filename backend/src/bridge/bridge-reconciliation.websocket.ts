import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service';
import { BridgeProgressService } from './bridge-progress.service';

const PATH = '/api/bridge/reconciliation/ws';
const MAX_CLIENTS = 100;

function cookie(header: string | undefined, name: string) {
	for (const part of header?.split(';') ?? []) {
		const separator = part.indexOf('=');
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
	}
	return '';
}

function reject(socket: Socket, status: number, message: string) {
	if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachBridgeReconciliationWebSocket(server: HttpServer, auth: AuthService, progress: BridgeProgressService, allowedOrigin: string) {
	const logger = new Logger('BridgeReconciliationWebSocket');
	const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
	const identities = new WeakMap<WebSocket, string>();
	const alive = new WeakMap<WebSocket, boolean>();

	webSockets.on('connection', (client) => {
		const identityId = identities.get(client);
		if (!identityId) return client.close(1008, 'Missing authenticated identity');
		alive.set(client, true);
		client.on('pong', () => alive.set(client, true));
		const unsubscribe = progress.subscribe(identityId, (update) => {
			if (client.readyState !== WebSocket.OPEN) return;
			client.send(JSON.stringify({ type: 'bridge-progress', orderId: update.orderId, reason: update.reason, at: update.at }));
		});
		client.once('close', unsubscribe);
		client.once('error', unsubscribe);
	});

	const heartbeat = setInterval(() => {
		for (const client of webSockets.clients) {
			if (alive.get(client) === false) client.terminate();
			else { alive.set(client, false); client.ping(); }
		}
	}, 30_000);
	heartbeat.unref();

	server.on('upgrade', async (request: IncomingMessage, socket: Socket, head: Buffer) => {
		let pathname = '';
		try { pathname = new URL(request.url ?? '', allowedOrigin).pathname; } catch { return; }
		if (pathname !== PATH) return;
		if (request.headers.origin !== allowedOrigin || webSockets.clients.size >= MAX_CLIENTS) {
			return reject(socket, request.headers.origin !== allowedOrigin ? 403 : 503, request.headers.origin !== allowedOrigin ? 'Forbidden' : 'Service Unavailable');
		}
		try {
			const token = cookie(request.headers.cookie, SESSION_COOKIE);
			const session = await auth.session({ cookies: { [SESSION_COOKIE]: token } } as unknown as Request);
			if (!session || session.chain !== 'tbc' || session.network !== 'testnet') return reject(socket, 401, 'Unauthorized');
			webSockets.handleUpgrade(request, socket, head, (client) => {
				identities.set(client, session.id);
				webSockets.emit('connection', client, request);
			});
		} catch { reject(socket, 401, 'Unauthorized'); }
	});

	server.once('close', () => {
		clearInterval(heartbeat);
		webSockets.close();
		logger.log('Bridge reconciliation WebSocket closed');
	});
}
