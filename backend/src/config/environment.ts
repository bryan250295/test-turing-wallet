import 'dotenv/config';
import { resolve } from 'node:path';

export interface Environment {
	port: number;
	origin: string;
	secureCookies: boolean;
	keyFile: string;
	custodyKeyFile: string;
	legacyDirectory: string;
	sessionHours: number;
}

export function environment(): Environment {
	const origin = new URL(process.env.APP_ORIGIN ?? 'http://localhost:5173');
	if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== (process.env.APP_ORIGIN ?? 'http://localhost:5173')) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin.');
	if (!process.env.DATABASE_URL?.startsWith('postgresql://')) throw new Error('DATABASE_URL must be configured for PostgreSQL.');
	const port = Number(process.env.PORT ?? '3001');
	const sessionHours = Number(process.env.SESSION_HOURS ?? '12');
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24) throw new Error('Invalid PORT or SESSION_HOURS.');
	if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN.');
	return { port, origin: origin.origin, secureCookies: origin.protocol === 'https:', keyFile: resolve(process.env.SECRET_KEY_FILE ?? '../.secrets/htlc.key'), custodyKeyFile: resolve(process.env.BRIDGE_CUSTODY_KEY_FILE ?? '../.secrets/bridge-custody.key'), legacyDirectory: resolve(process.env.LEGACY_STORAGE_DIR ?? '../wallet/storage/htlc'), sessionHours };
}
