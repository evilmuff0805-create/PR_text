import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createTranscriptionBatches, validateTranscriptionBatch } from '../src/services/transcription-batches.js';

const checksum = (value) => createHash('sha256').update(value).digest('hex');
function fixture(options = {}) {
  const owner = randomUUID(), id = randomUUID(), itemId = randomUUID(), opId = randomUUID();
  const batch = { id, batchKey: randomUUID(), language: 'ko', polishMode: 'preserve', status: 'uploading', items: [{ id: itemId, label: 'Track', status: 'awaiting_upload', operationId: opId }] };
  const operation = { id: opId, status: 'staged', batch_id: id, batch_item_id: itemId, storage_manifest: [] };
  const calls = [], uploads = [], removals = [], aborted = [];
  let probeCalls = 0, enabled = options.enabled ?? true;
  const database = {
    storage: { from: () => ({ async upload(path, bytes, settings) { uploads.push({ path, bytes, settings }); if (options.uploadError) return { error: Error('private detail') }; return {}; }, async remove(paths) { removals.push(...paths); return {}; } }) },
    from(table) {
      const filters = {}; let update;
      const query = {
        select() { return this; }, eq(key, value) { filters[key] = value; return this; }, in(key, values) { filters[key] = values; return this; },
        update(value) { update = value; return this; },
        async maybeSingle() {
          if (options.readError) return { error: Error('private detail') };
          if (table === 'transcription_batches') return { data: options.existing ? { id } : null };
          return { data: filters.user_id === owner ? operation : null };
        },
        then(resolve, reject) {
          if (update && filters.user_id === owner) Object.assign(operation, update);
          return Promise.resolve({ data: filters.user_id === owner ? options.logs || [] : [], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, params) {
      calls.push({ name, params });
      if (options.rpcError === name) return { error: { code: options.errorCode, message: 'private database detail' } };
      if (name === 'get_transcription_batch') return { data: params.p_user_id === owner ? batch : null };
      if (name === 'list_transcription_batches') return { data: [batch] };
      if (name === 'create_transcription_batch') { batch.polishMode = params.p_polish_mode || 'preserve'; return { data: id }; }
      if (name === 'stage_transcription_batch_item') {
        operation.payload_hash = params.p_payload_hash;
        return { data: [{ operation_id: opId, status: options.stageStatus || 'staged', already_staged: options.alreadyStaged || false }] };
      }
      if (name === 'complete_transcription_batch_upload') {
        if (options.cancelDuringUpload) { operation.status = 'cancelled'; batch.items[0].status = 'cancelled'; return { error: { code: 'TB409', message: '종료된 묶음입니다.' } }; }
        operation.storage_manifest = params.p_storage_manifest;
        batch.items[0].status = 'ready';
        if (options.commitResponseLost) return { error: { code: 'PGRST000', message: 'private connection detail' } };
      }
      if (name === 'cancel_transcription_batch') batch.items[0].status = 'cancelled';
      return { data: true };
    },
  };
  const service = createTranscriptionBatches({ database, probe: async () => { probeCalls++; if (options.probeError) throw Error('private detail'); return options.duration ?? 61; }, enabled: () => enabled, abortOperation: op => aborted.push(op) });
  const payload = { userId: owner, batchKey: batch.batchKey, language: 'ko', files: [{ clientId: randomUUID(), filename: 'speaker.wav', label: 'Speaker' }] };
  const audio = { userId: owner, batchId: id, itemId, buffer: Buffer.from('synthetic audio'), filename: 'optimized.wav', contentType: 'audio/wav' };
  return { service, owner, id, itemId, opId, batch, operation, payload, audio, calls, uploads, removals, aborted, probeCalls: () => probeCalls, setEnabled: value => { enabled = value; } };
}

test('batch file validation bounds count, immutable labels, identity and audio-only extensions', () => {
  const files = [{ clientId: randomUUID(), filename: 'Track.wav' }], batchKey = randomUUID();
  assert.equal(validateTranscriptionBatch({ batchKey, files }).files[0].label, 'Track');
  for (const invalid of [[], Array.from({ length: 6 }, () => ({ ...files[0], clientId: randomUUID() })), [files[0], files[0]], [{ ...files[0], filename: 'video.mp4' }], [{ ...files[0], label: 'a'.repeat(81) }], [{ ...files[0], filename: 'line\nbreak.wav' }], [{ ...files[0], diarize: true }]]) {
    assert.throws(() => validateTranscriptionBatch({ batchKey, files: invalid }), error => error.status === 400);
  }
  assert.throws(() => validateTranscriptionBatch({ batchKey, files, language: { ko: true } }), error => error.status === 400);
});

test('new admission flag is independent and accepted batch creation retries remain available', async () => {
  const off = fixture({ enabled: false });
  await assert.rejects(() => off.service.create(off.payload), error => error.code === 'BATCH_ADMISSIONS_DISABLED');
  assert.equal(off.calls.length, 0);
  const accepted = fixture({ enabled: false, existing: true });
  assert.equal((await accepted.service.create(accepted.payload)).existing, true);
  assert.equal((await accepted.service.list(accepted.owner)).admissionsEnabled, false);
  await accepted.service.upload(accepted.audio);
  assert.equal(accepted.uploads.length, 1);
});

test('invalid batch rows are rejected before database or upload work', async () => {
  const f = fixture();
  f.payload.files.push({ clientId: randomUUID(), filename: 'last.mp4' });
  await assert.rejects(() => f.service.create(f.payload), error => error.status === 400);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.uploads, []);
});

test('batch fingerprint binds original order, label and language without modifying input', async () => {
  const f = fixture(), original = structuredClone(f.payload);
  await f.service.create(f.payload);
  assert.deepEqual(f.payload, original);
  const parameters = f.calls.find(call => call.name === 'create_transcription_batch').params;
  assert.equal(parameters.p_payload_hash, checksum(JSON.stringify({ language: f.payload.language, files: f.payload.files })));
  assert.deepEqual(parameters.p_items, f.payload.files);
});

test('grammar batch mode binds both the batch fingerprint and stored-source audio hash', async () => {
  const legacy = fixture();
  await legacy.service.create(legacy.payload);
  const legacyRequest = legacy.calls.find(call => call.name === 'create_transcription_batch').params;
  assert.equal(legacyRequest.p_payload_hash, checksum(JSON.stringify({ language: legacy.payload.language, files: legacy.payload.files })));
  assert.equal(Object.hasOwn(legacyRequest, 'p_polish_mode'), false);

  const f = fixture(); f.payload.polishMode = 'grammar';
  await f.service.create(f.payload);
  const create = f.calls.find(call => call.name === 'create_transcription_batch').params;
  assert.equal(create.p_polish_mode, 'grammar');
  assert.equal(create.p_payload_hash, checksum(JSON.stringify({ language: f.payload.language, polishMode: 'grammar', files: f.payload.files })));
  await f.service.upload(f.audio);
  const stage = f.calls.find(call => call.name === 'stage_transcription_batch_item').params;
  assert.equal(stage.p_payload_hash, checksum(Buffer.concat([f.audio.buffer, Buffer.from('\nko\nordinary\ngrammar')])));
});

test('uploads retain every source byte including leading silence and bounded storage parts', async () => {
  const f = fixture(); f.audio.buffer = Buffer.alloc(41 * 1024 * 1024, 7); f.audio.buffer.fill(0, 0, 4096);
  await f.service.upload(f.audio);
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[0].bytes.length, 40 * 1024 * 1024);
  assert.deepEqual(Buffer.concat(f.uploads.map(part => part.bytes)), f.audio.buffer);
  const stage = f.calls.find(call => call.name === 'stage_transcription_batch_item').params;
  assert.equal(stage.p_duration_seconds, 61);
  const manifest = f.calls.find(call => call.name === 'complete_transcription_batch_upload').params.p_storage_manifest;
  assert.equal(manifest[0].sha256, checksum(f.uploads[0].bytes));
  assert.equal(f.calls.some(call => call.name.includes('queue') || call.name.includes('start')), false);
});

test('unknown duration, video MIME and unauthorized upload cannot reserve or write storage', async () => {
  for (const options of [{ duration: NaN }, { duration: 0 }, { probeError: true }]) {
    const f = fixture(options);
    await assert.rejects(() => f.service.upload(f.audio), error => error.status === 400);
    assert.equal(f.calls.some(call => call.name === 'stage_transcription_batch_item'), false);
    assert.deepEqual(f.uploads, []);
  }
  const f = fixture();
  await assert.rejects(() => f.service.upload({ ...f.audio, contentType: 'video/webm' }), error => error.status === 400);
  await assert.rejects(() => f.service.upload({ ...f.audio, userId: randomUUID() }), error => error.status === 404);
  assert.equal(f.probeCalls(), 0); assert.deepEqual(f.uploads, []);
});

test('accepted ready or completed original is never uploaded again', async () => {
  for (const options of [{ alreadyStaged: true }, { stageStatus: 'completed' }]) {
    const f = fixture(options); await f.service.upload(f.audio); assert.equal(f.uploads.length, 0);
  }
});

test('upload response loss reconciles committed metadata without deleting a live original', async () => {
  const f = fixture({ commitResponseLost: true });
  assert.equal((await f.service.upload(f.audio)).items[0].status, 'ready');
  assert.deepEqual(f.removals, []);
});

test('upload failure preserves uncertain originals and late cancellation cleans only own uploaded parts', async () => {
  const unknown = fixture({ uploadError: true });
  await assert.rejects(() => unknown.service.upload(unknown.audio), error => error.status === 503);
  assert.deepEqual(unknown.removals, []);
  const cancelled = fixture({ cancelDuringUpload: true });
  cancelled.operation.audio_deleted_at = '2026-01-01T00:00:00Z';
  await assert.rejects(() => cancelled.service.upload(cancelled.audio), error => error.status === 409);
  assert.deepEqual(cancelled.removals, cancelled.uploads.map(part => part.path));
  assert.equal(cancelled.operation.audio_deleted_at, null);
});

test('start and retry forward exact request keys and authoritative credit confirmation', async () => {
  const f = fixture(), requestId = randomUUID();
  await f.service.start({ userId: f.owner, batchId: f.id, requestId, expectedCredits: 4 });
  assert.deepEqual(f.calls.find(call => call.name === 'start_transcription_batch').params, { p_user_id: f.owner, p_batch_id: f.id, p_request_id: requestId, p_expected_credits: 4 });
  await f.service.retry({ userId: f.owner, batchId: f.id, itemId: f.itemId, requestId });
  assert.equal(f.calls.find(call => call.name === 'retry_transcription_batch_item').params.p_item_id, f.itemId);
  await assert.rejects(() => f.service.start({ userId: f.owner, batchId: f.id, requestId, expectedCredits: '4' }), error => error.status === 400);
});

test('committed cancellation aborts the local active child without using generic cancel', async () => {
  const f = fixture(); await f.service.cancel(f.id, f.owner);
  assert.deepEqual(f.aborted, [f.opId]);
  assert.equal(f.calls.some(call => call.name === 'cancel_transcription_operation'), false);
});

test('archive reads latest owner edits, preserves empty results and never restarts transcription', async () => {
  const latest = [{ text: 'Edited', start: 12, end: 13 }], f = fixture({ logs: [{ id: 1, segments: [], edited_segments: latest }, { id: 2, segments: [], edited_segments: null }] });
  f.batch.items = [{ id: f.itemId, label: 'First', status: 'completed', transcriptionLogId: 1 }, { id: randomUUID(), label: 'Empty', status: 'completed', transcriptionLogId: 2 }, { id: randomUUID(), label: 'Failed', status: 'failed' }];
  assert.deepEqual(await f.service.archiveItems(f.id, f.owner), [{ label: 'First', status: 'completed', segments: latest }, { label: 'Empty', status: 'completed', segments: [] }, { label: 'Failed', status: 'failed' }]);
  assert.deepEqual(f.calls.map(call => call.name), ['get_transcription_batch']);
  await assert.rejects(() => f.service.archiveItems(f.id, randomUUID()), error => error.status === 404);
});

test('missing latest completed log fails closed rather than using stale operation output', async () => {
  const f = fixture(); f.batch.items[0] = { label: 'Missing', status: 'completed', transcriptionLogId: 99 };
  await assert.rejects(() => f.service.archiveItems(f.id, f.owner), error => error.status === 409);
});

test('unexpected database errors return a static retryable message without private detail', async () => {
  const f = fixture({ rpcError: 'list_transcription_batches', errorCode: '08006' });
  await assert.rejects(() => f.service.list(f.owner), error => error.status === 503 && !error.message.includes('private'));
});
