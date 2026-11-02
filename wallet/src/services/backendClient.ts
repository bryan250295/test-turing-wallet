import { ApiError } from './apiClient';

export interface BackendSession {
  identity: { id: string; chain: string; network: string; address: string; role: string };
  csrfToken: string;
  expiresAt: string;
}
let session: BackendSession | null = null;
const listeners = new Set<() => void>();
let loading: Promise<BackendSession | null> | undefined;
export const getBackendSession = () => session;
export function subscribeBackendSession(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(value: BackendSession | null) { session = value; listeners.forEach((listener) => listener()); }
export function acceptBackendSession(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid backend login response.');
  const candidate = value as BackendSession;
  if (!candidate.identity || typeof candidate.identity.address !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.csrfToken) || !Number.isFinite(Date.parse(candidate.expiresAt))) throw new Error('Invalid backend login response.');
  publish(candidate);
  return candidate;
}
export async function backendFetch(url: string, init: RequestInit = {}, requireSession = true) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (requireSession) {
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      publish(null);
      throw new ApiError('Reconnect your TBC Testnet wallet and confirm the login signature to continue.', { status: 401 });
    }
    if (!['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())) headers.set('X-CSRF-Token', session.csrfToken);
  }
  const response = await fetch(url, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401 && requireSession) publish(null);
  return response;
}
export async function backendData(url: string, payload?: unknown, requireSession = true, signal?: AbortSignal) {
  const response = await backendFetch(url, { method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: signal ?? AbortSignal.timeout(20000) }, requireSession);
  if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) throw new Error('The backend API is unavailable. Start the Docker Compose services.');
  const body = await response.json();
  if (!response.ok) throw new ApiError(typeof body.message === 'string' ? body.message : 'The backend request failed.', { status: response.status });
  return body.data;
}
export function refreshBackendSession() {
  if (loading) return loading;
  loading = backendData('/api/auth/session', undefined, false).then((value: unknown) => value ? acceptBackendSession(value) : (publish(null), null)).finally(() => { loading = undefined; });
  return loading;
}
