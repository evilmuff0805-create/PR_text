import { createHash, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { normalizeLanguage } from './language.js';
import { probeAudioDuration, transcribe } from './whisper.js';
import { joinSegmentText, processTranscriptionSegments } from './transcription-processing.js';

export const OPERATION_BUCKET = 'transcription-operation-audio';
export const OPERATION_PART_BYTES = 40 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isTranscriptionOperationId = (value) => typeof value === 'string' && UUID.test(value);
export const isOperationKey = isTranscriptionOperationId;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const operationPayloadHash = (buffer, language) => createHash('sha256').update(buffer).update(`\n${language || ''}\nordinary`).digest('hex');
const terminal = (status) => ['completed', 'failed', 'cancelled'].includes(status);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTranscriptionOperations({
  database = supabaseAdmin, probe = probeAudioDuration, transcribeAudio = transcribe,
  processSegments = processTranscriptionSegments, heartbeatMs = 30_000, retryDelay = 500,
} = {}) {
  const bucket = database.storage.from(OPERATION_BUCKET);
  let timer, maintenanceTimer, active, busy = false, stopping = false, cleaning = false;
  async function rpc(name, params) {
    const { data, error } = await database.rpc(name, params);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  }
  async function row(id, userId) {
    let query = database.from('transcription_operations').select('*').eq('id', id);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data;
  }
  async function credits(userId) {
    const { data, error } = await database.from('profiles').select('credits').eq('id', userId).single();
    if (error) throw error;
    return data.credits;
  }
  async function getForUser(id, userId) {
    const operation = await row(id, userId);
    if (!operation) return null;
    return {
      id: operation.id, status: operation.status, createdAt: operation.created_at,
      creditsUsed: operation.credits_reserved, creditsRemaining: await credits(userId), creditsRestored: operation.credits_restored,
      error: terminal(operation.status) ? operation.error_message : undefined,
      ...(operation.status === 'completed' ? { text: operation.result_text, segments: operation.result_segments,
        language: operation.result_language, transcriptionLogId: operation.transcription_log_id } : {}),
    };
  }
  async function getByKey(key, userId) {
    const { data, error } = await database.from('transcription_operations').select('id').eq('user_id', userId).eq('operation_key', key).maybeSingle();
    if (error) throw error;
    return data ? getForUser(data.id, userId) : null;
  }
  async function enqueue({ userId, operationKey, buffer, filename, contentType, language }) {
    if (!isOperationKey(operationKey)) throw Object.assign(new Error('유효하지 않은 작업 키입니다.'), { status: 400 });
    if (process.env.TRANSCRIPTION_OPERATIONS_ENABLED !== 'true' && !await getByKey(operationKey, userId)) {
      throw Object.assign(new Error('기존 변환 방식으로 진행합니다.'), { code: 'LEGACY_MODE' });
    }
    let duration;
    try { duration = await probe(buffer, filename); } catch { /* Keep existing unsupported-probe format handling. */ }
    if (!Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('파일 길이를 확인하지 못했습니다.'), { code: 'DURATION_UNKNOWN' });
    const created = (await rpc('create_transcription_operation', {
      p_user_id: userId, p_operation_key: operationKey, p_payload_hash: operationPayloadHash(buffer, language),
      p_filename: filename, p_content_type: contentType || null, p_byte_size: buffer.length,
      p_requested_language: language || null, p_duration_seconds: duration,
    }))?.[0];
    if (!created) throw new Error('변환 접수 결과를 확인하지 못했습니다.');
    if (created.status !== 'staged') return { operationId: created.operation_id, status: created.status, creditsRemaining: created.credits_remaining, existing: true };
    const manifest = [];
    for (let offset = 0, index = 0; offset < buffer.length; offset += OPERATION_PART_BYTES, index++) {
      const part = buffer.subarray(offset, Math.min(offset + OPERATION_PART_BYTES, buffer.length));
      const path = `${userId}/${created.operation_id}/${String(index).padStart(4, '0')}`;
      const { error } = await bucket.upload(path, part, { contentType: contentType || 'application/octet-stream', upsert: true });
      // Another submission may already own these deterministic paths. Only terminal cleanup may delete them.
      if (error) throw new Error('원본 저장 연결을 확인하지 못했습니다. 같은 작업으로 다시 시도해주세요.');
      manifest.push({ path, bytes: part.length, sha256: sha256(part) });
    }
    const queued = (await rpc('queue_transcription_operation', { p_operation_id: created.operation_id, p_user_id: userId,
      p_storage_manifest: manifest, p_credits: Math.max(Math.ceil(duration / 60), 1) }))?.[0];
    if (!queued) throw Object.assign(new Error('변환 가능 시간이 부족합니다.'), { status: 402, creditsNeeded: Math.ceil(duration / 60) });
    return { operationId: queued.operation_id, status: queued.status, creditsRemaining: queued.credits_remaining, existing: queued.already_queued };
  }
  async function cleanAudio(operation) {
    if (!terminal(operation.status)) return;
    const prefix = `${operation.user_id}/${operation.id}`;
    const { data, error } = await bucket.list(prefix, { limit: 100 });
    if (error) throw error;
    const paths = (data || []).filter((item) => item.id).map((item) => `${prefix}/${item.name}`);
    if (paths.length) { const result = await bucket.remove(paths); if (result.error) throw result.error; }
    const result = await database.from('transcription_operations').update({ audio_deleted_at: new Date().toISOString() }).eq('id', operation.id);
    if (result.error) throw result.error;
  }
  async function cancel(id, userId) {
    const result = (await rpc('cancel_transcription_operation', { p_operation_id: id, p_user_id: userId }))?.[0];
    if (!result?.updated) return null;
    if (active?.operation?.id === id) active.controller.abort();
    // Cleanup is retried by maintenance, independently of the already committed cancellation.
    return result;
  }
  async function readAudio(operation) {
    const buffer = Buffer.alloc(Number(operation.byte_size));
    let offset = 0;
    for (const part of operation.storage_manifest) {
      const { data, error } = await bucket.download(part.path);
      if (error) throw new Error('저장된 원본을 읽지 못했습니다.');
      const partBuffer = Buffer.from(await data.arrayBuffer());
      if (partBuffer.length !== part.bytes || sha256(partBuffer) !== part.sha256) throw new Error('저장된 원본 검증에 실패했습니다.');
      partBuffer.copy(buffer, offset);
      offset += partBuffer.length;
    }
    if (offset !== buffer.length || buffer.length !== Number(operation.byte_size) || operationPayloadHash(buffer, operation.requested_language) !== operation.payload_hash) throw new Error('원본 전체 검증에 실패했습니다.');
    return buffer;
  }
  async function release(context, delaySeconds = 0) {
    await rpc('release_transcription_operation_lease', { p_operation_id: context.operation.id, p_worker_token: context.workerToken, p_delay_seconds: delaySeconds });
  }
  async function processNext() {
    if (busy || stopping) return;
    busy = true;
    const context = { workerToken: randomUUID(), controller: new AbortController(), operation: null };
    active = context;
    let heartbeat, providerFinished = false;
    const started = Date.now();
    try {
      context.operation = (await rpc('claim_transcription_operation', { p_worker_token: context.workerToken }))?.[0];
      const operation = context.operation;
      if (!operation) return;
      console.log('[transcription.operation.claimed]', JSON.stringify({ operationId: operation.id, attempt: operation.attempt_count, queueAgeMs: Date.now() - Date.parse(operation.created_at) }));
      if (stopping) { await release(context); return; }
      heartbeat = setInterval(async () => {
        try { if (!await rpc('renew_transcription_operation_lease', { p_operation_id: operation.id, p_worker_token: context.workerToken })) context.controller.abort(); }
        catch { context.controller.abort(); }
      }, heartbeatMs);
      heartbeat.unref?.();
      let checkpoint = operation.status === 'finalizing';
      if (!checkpoint) {
        if (operation.attempt_count > 3) throw new Error('처리 재시도 한도를 초과했습니다.');
        const buffer = await readAudio(operation);
        context.controller.signal.throwIfAborted();
        const raw = await transcribeAudio(buffer, operation.filename, operation.requested_language, { durationSeconds: Number(operation.duration_seconds), signal: context.controller.signal });
        context.controller.signal.throwIfAborted();
        const processed = await processSegments(raw.segments, raw.language);
        context.controller.signal.throwIfAborted();
        providerFinished = true;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            checkpoint = await rpc('checkpoint_transcription_operation', { p_operation_id: operation.id, p_worker_token: context.workerToken,
              p_text: joinSegmentText(processed.segments), p_segments: processed.segments, p_language: normalizeLanguage(raw.language),
              p_timings: { provider: raw.timings, correction: processed.correctionTimings, elapsedMs: Date.now() - started } });
            if (checkpoint) break;
            const current = await row(operation.id);
            if (current?.worker_token !== context.workerToken || terminal(current?.status)) return;
            checkpoint = current?.status === 'finalizing';
            if (checkpoint) break;
          } catch { if (attempt < 2) await delay(retryDelay); }
        }
        if (!checkpoint) return; // Unknown DB outcome: never refund or delete potentially committed work.
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const finalized = (await rpc('finalize_transcription_operation', { p_operation_id: operation.id, p_worker_token: context.workerToken }))?.[0];
          if (finalized?.completed) { console.log('[transcription.operation.completed]', JSON.stringify({ operationId: operation.id, durationMs: Date.now() - started })); return; }
          const current = await row(operation.id);
          if (terminal(current?.status) || current?.worker_token !== context.workerToken) return;
        } catch { if (attempt < 2) await delay(retryDelay); }
      }
    } catch (error) {
      if (context.operation && !stopping && !providerFinished && !context.controller.signal.aborted) {
        // Read failure leaves the outcome unknown. Do not turn uncertainty into a refund.
        const current = await row(context.operation.id);
        if (current?.status === 'running' && current.worker_token === context.workerToken) {
          await rpc('fail_transcription_operation', { p_operation_id: current.id, p_worker_token: context.workerToken,
            p_error_message: '변환 처리 중 오류가 발생했습니다. 유효한 예약 시간은 반환되었습니다.' });
        }
      }
      console.warn('[transcription.operation.interrupted]', JSON.stringify({ operationId: context.operation?.id, code: error.code || error.name }));
    } finally {
      clearInterval(heartbeat);
      if (context.operation) { try { await release(context, providerFinished || context.operation.status === 'finalizing' ? 30 : 0); } catch { /* Lease expiry is the recovery fallback. */ } }
      active = null; busy = false;
    }
  }
  let orphanOffset = 0;
  async function cleanOrphans() {
    const owners = await bucket.list('', { limit: 20, offset: orphanOffset, sortBy: { column: 'name', order: 'asc' } });
    if (owners.error) throw owners.error;
    orphanOffset = (owners.data || []).length < 20 ? 0 : orphanOffset + 20;
    for (const owner of owners.data || []) {
      if (!isTranscriptionOperationId(owner.name)) continue;
      const folders = await bucket.list(owner.name, { limit: 1000 });
      if (folders.error) throw folders.error;
      for (const folder of folders.data || []) {
        if (!isTranscriptionOperationId(folder.name) || await row(folder.name)) continue;
        const prefix = owner.name + '/' + folder.name;
        const objects = await bucket.list(prefix, { limit: 100 });
        if (objects.error) throw objects.error;
        const oldPaths = (objects.data || []).filter((item) => item.id && Date.parse(item.created_at) < Date.now() - 24 * 60 * 60 * 1000).map((item) => prefix + '/' + item.name);
        if (oldPaths.length) { const removed = await bucket.remove(oldPaths); if (removed.error) throw removed.error; }
      }
    }
  }
  async function maintenance() {
    if (cleaning) return;
    cleaning = true;
    try {
      // Staging never reserves credits; its 24-hour retention also bounds orphan uploads.
      const { error: expiryError } = await database.from('transcription_operations').update({ status: 'cancelled', completed_at: new Date().toISOString(), error_message: '업로드 접수 기한이 지났습니다. 새 변환을 시작해주세요.' }).eq('status', 'staged').lt('expires_at', new Date().toISOString());
      if (expiryError) throw expiryError;
      const expired = await database.from('transcription_operations').select('id,user_id').eq('status','queued').lt('expires_at',new Date().toISOString()).limit(20);
      if (expired.error) throw expired.error;
      for (const operation of expired.data || []) await cancel(operation.id, operation.user_id);
      const { data, error } = await database.from('transcription_operations').select('*').in('status', ['completed', 'failed', 'cancelled']).order('audio_deleted_at', { ascending: true, nullsFirst: true }).limit(20);
      if (error) throw error;
      for (const operation of data || []) await cleanAudio(operation);
      await cleanOrphans();
    } finally { cleaning = false; }
  }
  function start() {
    if (timer) return;
    stopping = false;
    const tick = () => processNext().catch((error) => console.error('[transcription.operation.worker_error]', error.code || error.name));
    const clean = () => maintenance().catch((error) => console.warn('[transcription.operation.cleanup_error]', error.code || error.name));
    timer = setInterval(tick, 5_000); maintenanceTimer = setInterval(clean, 60_000); tick(); clean();
  }
  async function stop() {
    stopping = true; clearInterval(timer); clearInterval(maintenanceTimer); timer = undefined;
    const context = active; context?.controller.abort(); if (context?.operation) await release(context);
  }
  return { enqueue, getForUser, getByKey, cancel, processNext, maintenance, cleanAudio, start, stop };
}
const operations = createTranscriptionOperations();
export const createAndQueueTranscriptionOperation = operations.enqueue;
export const getTranscriptionOperationForUser = operations.getForUser;
export const getTranscriptionOperationByKeyForUser = operations.getByKey;
export const cancelQueuedTranscriptionOperation = operations.cancel;
export const startTranscriptionOperationWorker = operations.start;
export const stopTranscriptionOperationWorker = operations.stop;
