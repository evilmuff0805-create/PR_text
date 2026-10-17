import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_UPLOAD_BYTES, MAX_WAV_SOURCE_BYTES } from '../client/src/utils/upload-validation.js';
import { batchUploadFile, defaultTrackLabel, stageBatchFiles, validateBatchAudio, validateBatchRows } from '../client/src/utils/batch-transcription.js';
import { draftLines, flushStoredBatchDrafts, readResultDraft, resultDraftKey, writeResultDraft } from '../client/src/utils/result-drafts.js';

const id = (value) => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const memoryStorage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };

test('batch inputs enforce five audio files and preserve complete Unicode in default labels', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ clientId: id(index), filename: `track${index}.wav`, label: `인물 ${index}` }));
  assert.equal(validateBatchRows(rows), null);
  assert.match(validateBatchRows([...rows, { ...rows[0], clientId: id(6) }]), /1~5/);
  assert.match(validateBatchRows([{ ...rows[0], label: 'a\nb' }]), /이름/);
  assert.equal(defaultTrackLabel('a'.repeat(79) + '😀.wav'), 'a'.repeat(79));
  assert.equal(defaultTrackLabel('a'.repeat(78) + '😀.wav'), 'a'.repeat(78) + '😀');
  assert.equal(validateBatchAudio({ name: 'voice.wav', size: MAX_WAV_SOURCE_BYTES }), null);
  assert.ok(validateBatchAudio({ name: 'voice.wav', size: MAX_WAV_SOURCE_BYTES + 1 }));
  assert.ok(validateBatchAudio({ name: 'voice.mp3', size: MAX_UPLOAD_BYTES + 1 }));
  assert.match(validateBatchAudio({ name: 'video.mp4', size: 20 }), /오디오/);
});

test('unknown browser MIME is corrected for multipart without changing any audio bytes', async () => {
  const source = new File([new Uint8Array([0, 4, 7, 255])], 'voice.wav', { lastModified: 123 });
  const prepared = batchUploadFile(source);
  assert.equal(prepared.type, 'audio/wav'); assert.equal(prepared.name, source.name); assert.equal(prepared.lastModified, 123);
  assert.deepEqual(new Uint8Array(await prepared.arrayBuffer()), new Uint8Array(await source.arrayBuffer()));
});

test('WAV preparation and upload stay sequential, skip accepted tracks and retain other successes after one failure', async () => {
  const items = [{ clientId: id(1), status: 'ready' }, ...[2, 3, 4].map((value) => ({ clientId: id(value), status: 'awaiting_upload' }))];
  const events = []; let inFlight = 0, maximum = 0;
  const errors = await stageBatchFiles({ items, getFile: (clientId) => ({ name: `${clientId}.wav`, size: 100 }),
    prepareFile: async (file, item) => { maximum = Math.max(maximum, ++inFlight); events.push(`prepare:${item.clientId}`); await new Promise(setImmediate); inFlight--; return file; },
    upload: async (item) => { maximum = Math.max(maximum, ++inFlight); events.push(`upload:${item.clientId}`); await new Promise(setImmediate); inFlight--; if (item.clientId === id(3)) throw new Error('synthetic upload failure'); } });
  assert.equal(maximum, 1);
  assert.deepEqual(events, [2, 3, 4].flatMap((value) => [`prepare:${id(value)}`, `upload:${id(value)}`]));
  assert.equal(errors.length, 1); assert.equal(errors[0].clientId, id(3));
  const afterLogout = [];
  await stageBatchFiles({ items: items.slice(1), getFile: () => ({ name: 'voice.wav', size: 100 }), prepareFile: async (file) => file, upload: async (item) => afterLogout.push(item), isCurrent: () => false });
  assert.equal(afterLogout.length, 0);
});

test('drafts isolate owners and records, preserve timing metadata, and refuse an older base after another edit', () => {
  const storage = memoryStorage();
  const segments = [{ start: 2.001, end: 3.25, text: '첫 문장입니다', timingSource: 'word', wordAlignedCues: [[2.001, 3.25, '첫 문장입니다']] }];
  const edited = [{ ...segments[0], text: '수정한 문장입니다' }];
  writeResultDraft(storage, id(1), id(2), { segments: edited, baseText: segments[0].text, fullTextDraft: edited[0].text, speakerColors: { 0: '#fff' } });
  assert.equal(readResultDraft(storage, id(9), id(2), segments), null);
  assert.equal(readResultDraft(storage, id(1), id(3), segments), null);
  const restored = readResultDraft(storage, id(1), id(2), segments);
  assert.deepEqual(restored.segments, edited); assert.equal(restored.segments[0].start, 2.001);
  assert.equal(readResultDraft(storage, id(1), id(2), [{ ...segments[0], text: '다른 창의 최신 문장' }]), null);
  assert.equal(readResultDraft(storage, id(1), id(2), [{ ...segments[0], start: 2.002 }]), null);
  assert.equal(readResultDraft(storage, id(1), id(2), edited).segments[0].text, edited[0].text);
});

test('ZIP draft flush saves only completed dirty records and fails before export on invalid lines or save failure', async () => {
  const storage = memoryStorage(), ownerId = id(1), logId = id(2);
  const original = [{ start: 1, end: 2, text: '원문' }], edited = [{ ...original[0], text: '편집문' }];
  const item = { status: 'completed', label: '인물', transcriptionLogId: logId };
  const saved = [];
  const options = { items: [item, { status: 'failed', transcriptionLogId: id(3) }], storage, ownerId, fetchLog: async () => ({ segments: original }), saveLog: async (recordId, segments) => saved.push({ recordId, segments }) };
  writeResultDraft(storage, ownerId, logId, { segments: edited, baseText: '원문', fullTextDraft: '편집문\n여분 줄' });
  await assert.rejects(flushStoredBatchDrafts(options), /줄 수/); assert.equal(saved.length, 0);
  writeResultDraft(storage, ownerId, logId, { segments: edited, baseText: '원문', fullTextDraft: '편집문' });
  await assert.rejects(flushStoredBatchDrafts({ ...options, saveLog: async () => { throw new Error('save failed'); } }), /save failed/);
  assert.equal(JSON.parse(storage.getItem(resultDraftKey(ownerId, logId))).baseText, '원문');
  await flushStoredBatchDrafts(options);
  assert.deepEqual(saved, [{ recordId: logId, segments: edited }]);
  assert.equal(JSON.parse(storage.getItem(resultDraftKey(ownerId, logId))).baseText, '편집문');
  assert.deepEqual(draftLines('한 줄\r\n두 줄\n'), ['한 줄', '두 줄']);
});
