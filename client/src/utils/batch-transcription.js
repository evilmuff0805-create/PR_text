import { validateUploadFile, validatePreparedUploadFile } from './upload-validation.js';

export const MAX_BATCH_FILES = 5;
export const BATCH_AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.webm,.mpga,.ogg,.flac';
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'webm', 'mpga', 'ogg', 'flac']);
export const BATCH_ACTIVE_ITEM_STATUSES = new Set(['queued', 'running', 'finalizing']);
export const BATCH_TERMINAL_STATUSES = new Set(['completed', 'partial_failed', 'failed', 'cancelled']);
export const pendingBatchKey = (ownerId) => `personAudioBatch:v1:${ownerId}`;
export const isBatchId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function defaultTrackLabel(filename) {
  let label = '';
  for (const character of String(filename).replace(/\.[^.]+$/, '')) {
    if (label.length + character.length > 80) break;
    if (character.length === 1 && /[\ud800-\udfff]/u.test(character)) continue;
    label += character;
  }
  return label || '인물';
}

export function validateBatchAudio(file) {
  const error = validateUploadFile(file);
  if (error) return error;
  if (!AUDIO_EXTENSIONS.has(String(file.name).split('.').at(-1).toLowerCase())) return '사람별로 분리한 오디오 파일을 선택해 주세요. 영상 파일과 단일 파일의 채널 추출은 지원하지 않습니다.';
  return null;
}

export function batchUploadFile(file) {
  const extension = String(file.name).split('.').at(-1).toLowerCase();
  const type = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm', mpga: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac' }[extension];
  return type && file.type !== type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
}

export function validateBatchRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_BATCH_FILES) return '오디오 파일은 1~5개를 선택해 주세요.';
  if (new Set(rows.map((row) => row.clientId)).size !== rows.length) return '파일 목록을 다시 확인해 주세요.';
  if (rows.some((row) => !isBatchId(row.clientId) || !row.label?.trim() || row.label.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(row.label))) return '인물 이름은 1~80자로 입력해 주세요.';
  return null;
}

export function batchCounts(batch) {
  const items = batch?.items || [];
  return { total: items.length, completed: items.filter((item) => item.status === 'completed').length,
    failed: items.filter((item) => item.status === 'failed').length, cancelled: items.filter((item) => item.status === 'cancelled').length,
    active: items.filter((item) => BATCH_ACTIVE_ITEM_STATUSES.has(item.status)).length };
}

export function readPendingBatch(storage, ownerId) {
  try {
    const value = JSON.parse(storage.getItem(pendingBatchKey(ownerId)) || 'null');
    return value?.ownerId === ownerId && isBatchId(value.batchKey) && (!value.id || isBatchId(value.id))
      && Array.isArray(value.files) && !validateBatchRows(value.files) ? value : null;
  } catch { return null; }
}

export function writePendingBatch(storage, ownerId, value) {
  try { storage.setItem(pendingBatchKey(ownerId), JSON.stringify({ ...value, ownerId })); } catch { /* Server history remains available. */ }
}

export function createBatchApi({ getToken, fetchImpl = fetch }) {
  return async (path, { method = 'GET', body, signal, multipart = false, download = false } = {}) => {
    const identifier = '[0-9a-f-]{36}';
    const allowed = new RegExp(`^/api/(?:transcribe/batches(?:/${identifier}(?:/(?:start|archive|items/${identifier}/(?:audio|retry)))?)?|auth/transcription/[1-9][0-9]{0,18}(?:/segments)?)$`, 'i');
    if (!allowed.test(path)) throw new Error('요청 경로를 확인해 주세요.');
    const token = getToken();
    if (!token) { const error = new Error('로그인 후 묶음 작업을 다시 확인해 주세요.'); error.status = 401; throw error; }
    const response = await fetchImpl(path, { method, signal, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}) });
    if (response.ok && download) return response.blob();
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(data.error || '묶음 작업 요청을 확인하지 못했습니다. 상태를 확인한 뒤 다시 시도해 주세요.');
      error.status = response.status; error.code = data.code; throw error;
    }
    return data;
  };
}

export async function stageBatchFiles({ items, getFile, prepareFile, upload, onStatus = () => {}, isCurrent = () => true }) {
  const errors = [];
  for (const item of items) {
    if (item.status !== 'awaiting_upload') continue;
    if (!isCurrent()) break;
    const file = getFile(item.clientId);
    if (!file) { errors.push({ clientId: item.clientId, message: '이 파일을 다시 선택해 주세요.' }); continue; }
    try {
      const error = validateBatchAudio(file);
      if (error) throw new Error(error);
      onStatus(item.clientId, 'preparing');
      const prepared = await prepareFile(file, item);
      if (!isCurrent()) break;
      const preparedError = validatePreparedUploadFile(prepared);
      if (preparedError) throw new Error(preparedError);
      onStatus(item.clientId, 'uploading');
      await upload(item, prepared);
      if (!isCurrent()) break;
      onStatus(item.clientId, 'ready');
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') break;
      errors.push({ clientId: item.clientId, message: error.message }); onStatus(item.clientId, 'error', error.message);
      if (error.status === 401) break;
    }
  }
  return errors;
}
