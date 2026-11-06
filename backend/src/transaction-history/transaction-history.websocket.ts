import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import type { Request } from 'express';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service';
import { TransactionHistoryService } from './transaction-history.service';

const PATH = '/api/transaction-history/ws';
const MAX_CLIENTS = 100;

function cookie(header: string | undefined, name: string) {
	if (!header) return '';
	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
	}
	return '';
}

function reject(socket: Socket, status: number, message: string) {
	if (socket.destroyed) return;
	socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachTransactionHistoryWebSocket(server: HttpServer, auth: AuthService, history: TransactionHistoryService, allowedOrigin: string) {
	const logger = new Logger('TransactionHistoryWebSocket');
	const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
	const alive = new WeakMap<WebSocket, boolean>();
	const addresses = new WeakMap<WebSocket, string>();

	webSockets.on('connection', (socket, request) => {
		const address = addresses.get(socket);
		if (!address) {
			socket.close(1008, 'Missing authenticated identity');
			return;
		}
		alive.set(socket, true);
		socket.on('pong', () => alive.set(socket, true));
		const unsubscribe = history.subscribe(address, (snapshot) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(snapshot));
		});
		socket.once('close', unsubscribe);
		socket.once('error', () => unsubscribe());
		logger.log({ address, remoteAddress: request.socket.remoteAddress }, 'Transaction history WebSocket connected');
	});

	const heartbeat = setInterval(() => {
		for (const socket of webSockets.clients) {
			if (alive.get(socket) === false) {
				socket.terminate();
				continue;
			}
			alive.set(socket, false);
			socket.ping();
		}
	}, 30_000);
	heartbeat.unref();

	server.on('upgrade', async (request: IncomingMessage, socket: Socket, head: Buffer) => {
		let pathname = '';
		try { pathname = new URL(request.url ?? '', allowedOrigin).pathname; } catch { return; }
		if (pathname !== PATH) return;
		if (request.headers.origin !== allowedOrigin) {
			reject(socket, 403, 'Forbidden');
			return;
		}
		if (webSockets.clients.size >= MAX_CLIENTS) {
			reject(socket, 503, 'Service Unavailable');
			return;
		}
		try {
			const token = cookie(request.headers.cookie, SESSION_COOKIE);
			const session = await auth.session({ cookies: { [SESSION_COOKIE]: token } } as unknown as Request);
			if (!session || session.chain !== 'tbc' || session.network !== 'testnet') {
				reject(socket, 401, 'Unauthorized');
				return;
			}
			webSockets.handleUpgrade(request, socket, head, (client) => {
				addresses.set(client, session.address);
				webSockets.emit('connection', client, request);
			});
		} catch {
			reject(socket, 401, 'Unauthorized');
		}
	});

	server.once('close', () => {
		clearInterval(heartbeat);
		webSockets.close();
	});
}
