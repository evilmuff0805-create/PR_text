import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const AUDIO_EXTENSION = /\.(mp3|wav|m4a|webm|mpeg|mpga|ogg|flac)$/i;
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/webm', 'audio/mpga', 'audio/mp3', 'audio/ogg', 'audio/flac']);
const PART_BYTES = 40 * 1024 * 1024;
const MAX_BYTES = 150 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ERROR_STATUS = { TB400: 400, TB402: 402, TB404: 404, TB409: 409, TB429: 429 };
export const isBatchId = (value) => typeof value === 'string' && UUID.test(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
// This is the existing ordinary operation protocol, including language binding.
export const batchAudioHash = (buffer, language, polishMode = 'preserve') => createHash('sha256').update(buffer).update(polishMode === 'grammar' ? `\n${language || ''}\nordinary\ngrammar` : `\n${language || ''}\nordinary`).digest('hex');
function invalid(message = '묶음 파일과 옵션을 확인해주세요.') {
  return Object.assign(new Error(message), { status: 400, code: 'TB400' });
}
function assertId(value) { if (!isBatchId(value)) throw invalid('유효하지 않은 묶음 작업 ID입니다.'); }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}

export function validateTranscriptionBatch({ batchKey, language = null, polishMode = 'preserve', files } = {}) {
  assertId(batchKey);
  if (language !== null && (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language))) throw invalid('변환 언어를 확인해주세요.');
  if (!['preserve', 'grammar'].includes(polishMode)) throw invalid('문법 다듬기 옵션을 확인해주세요.');
  if (!Array.isArray(files) || files.length < 1 || files.length > 5) throw invalid('오디오 파일을 1~5개 선택해주세요.');
  const ids = new Set();
  const normalized = files.map((file) => {
    fields(file, ['clientId', 'filename', 'label']);
    assertId(file.clientId);
    if (ids.has(file.clientId.toLowerCase())) throw invalid('파일 식별값이 중복되었습니다.');
    ids.add(file.clientId.toLowerCase());
    if (typeof file.filename !== 'string' || file.filename.length < 1 || file.filename.length > 500 || CONTROL.test(file.filename) || !AUDIO_EXTENSION.test(file.filename)) throw invalid('지원하는 오디오 파일 이름을 확인해주세요.');
    const label = file.label === undefined ? file.filename.replace(/\.[^.]+$/, '').slice(0, 80).trim() : file.label;
    if (typeof label !== 'string' || !label.trim() || label.length > 80 || CONTROL.test(label)) throw invalid('표시 이름은 1~80자로 입력해주세요.');
    return { clientId: file.clientId.toLowerCase(), filename: file.filename, label: label.trim() };
  });
  return { batchKey: batchKey.toLowerCase(), language, polishMode, files: normalized };
}

/** No environment, client singleton or worker is imported here: fixtures can
 * supply an isolated database, in-memory Storage and synthetic duration probe. */
export function createTranscriptionBatches({ database, probe, enabled = () => process.env.TRANSCRIPTION_BATCHES_ENABLED === 'true', abortOperation = () => {} } = {}) {
  if (!database?.rpc || !database?.storage?.from || typeof probe !== 'function') throw new TypeError('Batch database and duration probe are required.');
  const bucket = database.storage.from('transcription-operation-audio');
  async function rpc(name, parameters) {
    const { data, error } = await database.rpc(name, parameters);
    if (error) {
      if (ERROR_STATUS[error.code]) throw Object.assign(new Error(error.message), { code: error.code, status: ERROR_STATUS[error.code] });
      throw Object.assign(new Error('묶음 작업 상태를 확인하지 못했습니다. 같은 작업으로 다시 확인해주세요.'), { status: 503, code: 'BATCH_UNAVAILABLE' });
    }
    return data;
  }
  async function get(id, userId) {
    assertId(id);
    return await rpc('get_transcription_batch', { p_user_id: userId, p_batch_id: id });
  }
  async function required(id, userId) {
    const batch = await get(id, userId);
    if (!batch) throw Object.assign(new Error('묶음 작업을 찾을 수 없습니다.'), { code: 'TB404', status: 404 });
    return batch;
  }
  async function operation(id, userId) {
    const { data, error } = await database.from('transcription_operations').select('id,status,batch_id,batch_item_id,payload_hash,storage_manifest').eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw Object.assign(new Error('업로드 상태를 확인하지 못했습니다.'), { status: 503 });
    return data;
  }
  async function list(userId) {
    return { batches: await rpc('list_transcription_batches', { p_user_id: userId }), admissionsEnabled: Boolean(enabled()) };
  }
  async function create(input) {
    fields(input, ['userId', 'batchKey', 'language', 'polishMode', 'files']);
    const { userId } = input;
    const normalized = validateTranscriptionBatch(input);
    const fingerprint = hash(JSON.stringify(normalized.polishMode === 'preserve'
      ? { language: normalized.language, files: normalized.files }
      : { language: normalized.language, polishMode: normalized.polishMode, files: normalized.files }));
    const existingQuery = await database.from('transcription_batches').select('id').eq('user_id', userId).eq('batch_key', normalized.batchKey).maybeSingle();
    if (existingQuery.error) throw Object.assign(new Error('기존 묶음 작업을 확인하지 못했습니다.'), { status: 503 });
    if (!enabled() && !existingQuery.data) throw Object.assign(new Error('사람별 묶음 변환을 준비 중입니다.'), { status: 503, code: 'BATCH_ADMISSIONS_DISABLED' });
    const params = { p_user_id: userId, p_batch_key: normalized.batchKey, p_payload_hash: fingerprint, p_requested_language: normalized.language, p_items: normalized.files };
    if (normalized.polishMode === 'grammar') params.p_polish_mode = normalized.polishMode;
    const id = await rpc('create_transcription_batch', params);
    if (!isBatchId(id)) throw Object.assign(new Error('묶음 접수 결과를 확인하지 못했습니다.'), { status: 503 });
    return { batch: await required(id, userId), existing: Boolean(existingQuery.data) };
  }
  async function upload({ userId, batchId, itemId, buffer, filename, contentType }) {
    assertId(itemId);
    const batch = await required(batchId, userId);
    if (!batch.items.some((item) => item.id === itemId)) throw Object.assign(new Error('묶음 파일을 찾을 수 없습니다.'), { status: 404, code: 'TB404' });
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_BYTES || typeof filename !== 'string' || filename.length > 500 || CONTROL.test(filename) || !AUDIO_EXTENSION.test(filename) || !AUDIO_MIMES.has(contentType)) throw invalid('지원하는 오디오 파일을 선택해주세요.');
    let duration;
    try { duration = await probe(buffer, filename); } catch { /* Unknown duration must never reserve guessed credits. */ }
    if (!Number.isFinite(duration) || duration <= 0 || Math.ceil(duration / 60) > 2_147_483_647) throw invalid('파일 길이를 확인하지 못했습니다. 다른 오디오 형식으로 다시 선택해주세요.');
    const polishMode = batch.polishMode || 'preserve';
    const fingerprint = batchAudioHash(buffer, batch.language, polishMode);
    const stage = (await rpc('stage_transcription_batch_item', { p_user_id: userId, p_batch_id: batchId, p_item_id: itemId, p_payload_hash: fingerprint,
      p_filename: filename, p_content_type: contentType, p_byte_size: buffer.length, p_duration_seconds: duration }))?.[0];
    if (!stage || !isBatchId(stage.operation_id)) throw Object.assign(new Error('파일 접수 결과를 확인하지 못했습니다.'), { status: 503 });
    if (stage.status !== 'staged' || stage.already_staged) return required(batchId, userId);
    const manifest = [];
    try {
      for (let offset = 0, index = 0; offset < buffer.length; offset += PART_BYTES, index++) {
        const part = buffer.subarray(offset, Math.min(offset + PART_BYTES, buffer.length));
        const path = `${userId}/${stage.operation_id}/${String(index).padStart(4, '0')}`;
        const { error } = await bucket.upload(path, part, { contentType, upsert: true });
        if (error) throw Object.assign(new Error('원본 저장 연결을 확인하지 못했습니다. 같은 파일로 다시 시도해주세요.'), { status: 503 });
        manifest.push({ path, bytes: part.length, sha256: hash(part) });
      }
      await rpc('complete_transcription_batch_upload', { p_user_id: userId, p_batch_id: batchId, p_item_id: itemId, p_operation_id: stage.operation_id, p_storage_manifest: manifest });
    } catch (error) {
      // A response can be lost after commit. Never delete a live or uncertain
      // original; a confirmed terminal row permits cleaning these own paths.
      try {
        const current = await operation(stage.operation_id, userId);
        if (current && current.batch_id === batchId && current.batch_item_id === itemId && current.payload_hash === fingerprint) {
          if (TERMINAL.has(current.status)) {
            // Terminal maintenance may have finished before the last upload.
            // Reopen its cleanup marker so removal failures are retried.
            await database.from('transcription_operations').update({ audio_deleted_at: null }).eq('id', current.id).eq('user_id', userId).in('status', [...TERMINAL]);
            if (manifest.length) await bucket.remove(manifest.map((part) => part.path));
          } else if (current.storage_manifest?.length) return required(batchId, userId);
        }
      } catch { /* Preserve bytes while the committed outcome is unknown. */ }
      throw error;
    }
    return required(batchId, userId);
  }
  async function start({ userId, batchId, requestId, expectedCredits }) {
    assertId(batchId); assertId(requestId);
    if (!Number.isSafeInteger(expectedCredits) || expectedCredits < 1 || expectedCredits > 2_147_483_647) throw invalid('예약할 총 변환 시간을 확인해주세요.');
    await rpc('start_transcription_batch', { p_user_id: userId, p_batch_id: batchId, p_request_id: requestId, p_expected_credits: expectedCredits });
    return required(batchId, userId);
  }
  async function retry({ userId, batchId, itemId, requestId }) {
    assertId(batchId); assertId(itemId); assertId(requestId);
    await rpc('retry_transcription_batch_item', { p_user_id: userId, p_batch_id: batchId, p_item_id: itemId, p_request_id: requestId });
    return required(batchId, userId);
  }
  async function cancel(id, userId) {
    assertId(id);
    await rpc('cancel_transcription_batch', { p_user_id: userId, p_batch_id: id });
    const batch = await required(id, userId);
    for (const item of batch.items) if (item.status === 'cancelled' && item.operationId) abortOperation(item.operationId);
    return batch;
  }
  async function archiveItems(id, userId) {
    const batch = await required(id, userId);
    const ids = batch.items.filter((item) => item.status === 'completed').map((item) => item.transcriptionLogId);
    if (ids.some((logId) => logId === null || logId === undefined)) throw Object.assign(new Error('완료 파일의 저장 기록을 찾을 수 없습니다.'), { status: 409, code: 'TB409' });
    let records = [];
    if (ids.length) {
      const { data, error } = await database.from('transcription_logs').select('id,segments,edited_segments').eq('user_id', userId).in('id', ids);
      if (error) throw Object.assign(new Error('최신 편집 기록을 확인하지 못했습니다.'), { status: 503 });
      records = data || [];
    }
    return batch.items.map((item) => {
      if (item.status !== 'completed') return { label: item.label, status: item.status };
      const record = records.find((log) => String(log.id) === String(item.transcriptionLogId));
      const segments = record?.edited_segments ?? record?.segments;
      if (!Array.isArray(segments)) throw Object.assign(new Error('완료 파일의 최신 자막 기록을 찾을 수 없습니다.'), { status: 409, code: 'TB409' });
      return { label: item.label, status: item.status, segments };
    });
  }
  return { create, list, get, upload, start, retry, cancel, archiveItems };
}
