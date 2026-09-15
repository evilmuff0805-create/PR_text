export const pendingOperationStorageKey = (userId) => `pendingTranscriptionOperation:${userId}`;
export function readPendingOperation(storage, userId) {
  try {
    const value = JSON.parse(storage.getItem(pendingOperationStorageKey(userId)) || 'null');
    return typeof value?.operationKey === 'string' && /^[0-9a-f-]{36}$/i.test(value.operationKey) ? value : null;
  } catch { return null; }
}
export function classifyOperationResponse(status, data) {
  if (status === 401) return 'login';
  if (status === 404) return 'missing';
  if (status < 200 || status >= 300) return 'retry';
  if (data.status === 'completed') return 'completed';
  if (['failed', 'cancelled'].includes(data.status)) return 'terminal';
  if (data.status === 'staged') return 'staged';
  return ['queued', 'running', 'finalizing'].includes(data.status) ? 'active' : 'retry';
}

export function canSubmitOperation(pending, diarize) { return !(pending?.operationKey && diarize); }
