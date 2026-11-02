import type { LogAction } from '../types/wallet';
import { API_URLS } from '../config/constants';
import { backendData, getBackendSession } from './backendClient';

export async function logAction(action: LogAction, data: unknown) {
  if (!getBackendSession()) return;
  const value = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const outcome = value.error ? 'failed' : value.txid ? 'submitted' : 'completed';
  try { await backendData(API_URLS.actionLog, { action, outcome }); }
  catch { /* Audit endpoint failures do not trigger a repeat wallet transaction. */ }
}
