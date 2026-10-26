import { randomUUID } from 'node:crypto';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import tbc from 'tbc-lib-js';
import { API_URLS } from '../src/config/constants';
import { decryptClaimSecret, readSecretRecord } from './htlc/secretStorage';

interface Challenge { lockTxid: string; owner: string; origin: string; message: string; expires: number }
const challenges = new Map<string, Challenge>();

export default function htlcSecrets(): Plugin {
	const install = (server: ViteDevServer | PreviewServer) => {
		for (const endpoint of [API_URLS.htlcSecretChallenge, API_URLS.htlcSecretRetrieve]) server.middlewares.use(endpoint, async (request, response) => {
			response.setHeader('Content-Type', 'application/json');
			response.setHeader('Cache-Control', 'no-store');
			response.setHeader('Pragma', 'no-cache');
			// Browser-origin requests only. Secret files are blocked by the storage middleware.
			if (!request.headers.origin || !URL.canParse(request.headers.origin) || new URL(request.headers.origin).host !== request.headers.host) { response.writeHead(403).end(JSON.stringify({ message: 'Use the local app origin.' })); return; }
			if (request.method !== 'POST') { response.writeHead(405).end(JSON.stringify({ message: 'Use POST.' })); return; }
			const origin = new URL(request.headers.origin).origin;
			try {
				let body = '';
				for await (const chunk of request) {
					body += chunk;
					if (Buffer.byteLength(body) > 2048) { response.writeHead(413).end(JSON.stringify({ message: 'Request is too large.' })); return; }
				}
				const fields = JSON.parse(body);
				if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid secret request.');
				for (const [id, value] of challenges) if (value.expires <= Date.now()) challenges.delete(id);
				let result;
				if (endpoint === API_URLS.htlcSecretChallenge) {
					if (Object.keys(fields).length !== 1 || typeof fields.lockTxid !== 'string' || !/^[0-9a-f]{64}$/.test(fields.lockTxid)) throw new Error('Provide the lock TXID.');
					if (challenges.size >= 100) throw new Error('Too many pending secret requests. Try again shortly.');
					const record = await readSecretRecord(fields.lockTxid);
					const challengeId = randomUUID();
					const expires = Date.now() + 180000;
					const message = ['Reveal my saved TBC Testnet claim secret', `Origin: ${origin}`, `Sender: ${record.owner}`, `Lock TXID: ${record.lockTxid}`, `Nonce: ${challengeId}`, `Expires: ${new Date(expires).toISOString()}`, 'This signature authorizes one secret retrieval. It does not send a transaction.'].join('\n');
					challenges.set(challengeId, { lockTxid: record.lockTxid, owner: record.owner, origin, message, expires });
					result = { challengeId, message, owner: record.owner, lockTxid: record.lockTxid, expiresAt: new Date(expires).toISOString() };
				} else {
					if (Object.keys(fields).length !== 2 || typeof fields.challengeId !== 'string' || typeof fields.signature !== 'string' || fields.signature.length > 100) throw new Error('Provide a wallet signature for this challenge.');
					const challenge = challenges.get(fields.challengeId);
					challenges.delete(fields.challengeId);
					if (!challenge || challenge.expires <= Date.now() || challenge.origin !== origin) throw new Error('Secret retrieval request expired. Try again.');
					let valid = false;
					try { valid = tbc.Message.verify(Buffer.from(challenge.message, 'utf8'), challenge.owner, fields.signature); } catch { /* Malformed signatures fail closed. */ }
					if (!valid) throw new Error('Wallet ownership could not be verified. Select the original sender wallet.');
					result = await decryptClaimSecret(challenge.lockTxid, challenge.owner);
				}
				if (!response.destroyed) response.end(JSON.stringify({ data: result }));
			} catch (cause) {
				// Do not log request bodies, decrypted values or cryptographic material.
				const message = cause instanceof Error ? cause.message : 'Could not retrieve the saved claim secret.';
				if (!response.destroyed) response.writeHead(400).end(JSON.stringify({ message }));
			}
		});
	};
	return { name: 'local-htlc-secret-recovery', configureServer: install, configurePreviewServer: install };
}
