import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { before, after } from 'node:test';
import express from 'express';
import * as serverReview from '../src/services/subtitle-review.js';
import * as clientReview from '../client/src/utils/subtitle-review.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import { buildSubtitleCues, generateSRT, generateASS, generateTXT } from '../src/services/subtitle.js';

const forbiddenAiCalls = { audio: 0, chat: 0 };
let restoreAiGuards;
before(async () => {
  process.env.OPENAI_API_KEY = 'qa-no-network-invalid-key';
  const [{ Transcriptions }, { Completions }] = await Promise.all([
    import('openai/resources/audio/transcriptions'), import('openai/resources/chat/completions'),
  ]);
  const originalAudio = Transcriptions.prototype.create, originalChat = Completions.prototype.create;
  Transcriptions.prototype.create = async () => { forbiddenAiCalls.audio += 1; throw new Error('AI requests are forbidden in independent QA'); };
  Completions.prototype.create = async () => { forbiddenAiCalls.chat += 1; throw new Error('AI requests are forbidden in independent QA'); };
  restoreAiGuards = () => { Transcriptions.prototype.create = originalAudio; Completions.prototype.create = originalChat; };
});
after(() => {
  restoreAiGuards?.();
  assert.deepEqual(forbiddenAiCalls, { audio: 0, chat: 0 });
});

// Independent acceptance cases were sealed before the implementation contract.
// Use synthetic text only; private customer recordings/transcripts are not fixtures.
const segment = (text = '합성 검증 문장입니다', start = 0, end = 1) => ({ text, start, end });
const decide = (source, status = 'user', extra = {}) => ({
  ...source,
  subtitleReview: {
    ...source.subtitleReview,
    version: 1,
    issues: source.subtitleReview?.issues || [],
    localExclusion: {
      version: 1, status,
      reason: status === 'automatic' ? 'exact_zero_with_provider_risk'
        : status === 'review' ? 'distributed_repetition' : 'user_selection',
      binding: { text: source.text, start: source.start, end: source.end },
      ...extra,
    },
  },
});
const compact = (cues) => cues.map(({ text, start, end, speaker }) => ({ text, start, end, speaker }));
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key), values };
};

test('independent QA: exact numeric zero and all decision states agree on server and client', () => {
  for (const review of [serverReview, clientReview]) {
    for (const status of ['review', 'automatic', 'user', 'restored']) {
      const source = decide(segment(), status);
      assert.equal(review.normalizeLocalExclusion(source.subtitleReview.localExclusion).binding.start, 0);
      assert.equal(review.getBoundLocalExclusion(source).status, status);
      assert.equal(review.isLocallyExcluded(source), status === 'automatic' || status === 'user');
    }
  }
});

test('independent QA: missing, nonnumeric, nonfinite, reversed and unsupported decisions fail closed', () => {
  const original = decide(segment());
  const valid = original.subtitleReview.localExclusion;
  const invalid = [
    null, {}, { ...valid, version: 2 }, { ...valid, status: 'excluded' },
    { ...valid, binding: { ...valid.binding, start: '0' } },
    { ...valid, binding: { ...valid.binding, start: null } },
    { ...valid, binding: { ...valid.binding, start: NaN } },
    { ...valid, binding: { ...valid.binding, end: Infinity } },
    { ...valid, binding: { ...valid.binding, end: 0 } },
  ];
  for (const review of [serverReview, clientReview]) {
    for (const localExclusion of invalid) {
      const source = { ...original, subtitleReview: { ...original.subtitleReview, localExclusion } };
      assert.equal(review.isLocallyExcluded(source), false);
    }
  }
});

test('independent QA: text edits, submillisecond time edits and every speaker label invalidate exclusion', () => {
  const original = decide(segment());
  const changed = [
    { ...original, text: `${original.text}!` },
    { ...original, start: 1e-12 },
    { ...original, end: original.end + 1e-12 },
    ...[0, 1, 'speaker-a'].map(speaker => ({ ...original, speaker })),
  ];
  for (const review of [serverReview, clientReview]) {
    for (const source of changed) assert.equal(review.isLocallyExcluded(source), false);
  }
  assert.ok(generateSRT([changed[0]]).includes(changed[0].text));
});

test('independent QA: ordinary English manual exclusion works and diarized dialogue is preserved', () => {
  const english = decide(segment('Synthetic English line', 2, 3));
  assert.equal(buildSubtitleCues([english]).length, 0);
  for (const speaker of [0, 1]) {
    const source = { ...english, speaker };
    assert.equal(buildSubtitleCues([source]).length, 1);
    assert.ok(generateSRT([source]).includes(english.text));
    assert.ok(generateASS([source]).includes(english.text));
  }
});

test('independent QA: a mixed legacy speaker array ignores every local exclusion decision', () => {
  const sources = [
    { ...segment('화자가 있는 합성 대사', 0, 1), speaker: 0 },
    decide(segment('화자가 없는 합성 대사', 2, 3)),
  ];
  assert.equal(buildSubtitleCues(sources).length, 2);
  for (const output of [generateSRT(sources), generateASS(sources), generateTXT(sources)]) {
    assert.ok(output.includes(sources[0].text));
    assert.ok(output.includes(sources[1].text));
  }
});

test('independent QA: a shared cue rejects partial owners and automatic decisions instead of dropping a neighbour', () => {
  const sources = [segment('같은 시각 첫 합성', 0, 1), segment('같은 시각 둘째 합성', 0, 2)];
  assert.equal(buildSubtitleCues(sources).length, 1);
  assert.throws(() => buildSubtitleCues([decide(sources[0]), sources[1]]), error => {
    assert.equal(error.code, 'LOCAL_EXCLUSION_CONFLICT');
    assert.equal(error.status, 400);
    assert.deepEqual(error.connectedRows, [1, 2]);
    return true;
  });
  assert.equal(buildSubtitleCues(sources.map(source => decide(source))).length, 0);
  assert.throws(() => buildSubtitleCues([decide(sources[0], 'automatic'), decide(sources[1])]),
    { code: 'LOCAL_EXCLUSION_CONFLICT' });
});

test('independent QA: exclusion happens after long-text splitting and overlap clipping', () => {
  const sources = [
    segment('합성 앞부분을 충분히 길게 작성하여 분할 경계와 시간을 독립적으로 검사합니다', 0, 5),
    segment('제외할 중간 합성 문장', 1, 2),
    segment('남겨야 하는 마지막 합성 문장', 3, 4),
  ];
  const before = structuredClone(sources);
  const baseline = buildSubtitleCues(sources, { holdShortGaps: false });
  const decisions = [sources[0], decide(sources[1]), sources[2]];
  const actual = buildSubtitleCues(decisions, { holdShortGaps: false });
  assert.deepEqual(compact(actual), compact(baseline.filter(cue => cue.text !== sources[1].text)));
  assert.deepEqual(sources, before);
  assert.equal(actual.filter(cue => cue.start < 1).every(cue => cue.end <= 1), true);
});

test('independent QA: removed subsecond intervals remain barriers to SRT and ASS short-gap holding', () => {
  const sources = [segment('앞 합성 대사', 0, 1), decide(segment('제외 합성 대사', 1.1, 1.3)), segment('뒤 합성 대사', 1.5, 2)];
  for (const holdShortGaps of [true, false]) {
    const cues = buildSubtitleCues(sources, { holdShortGaps });
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, 0);
    assert.ok(cues[0].end <= 1.1);
    assert.equal(cues[1].start, 1.5);
    for (const output of [generateSRT(sources, null, { holdShortGaps }), generateASS(sources, { holdShortGaps }), generateTXT(sources)]) {
      assert.equal(output.includes(sources[1].text), false);
      assert.ok(output.includes(sources[0].text));
      assert.ok(output.includes(sources[2].text));
    }
  }
});

test('independent QA: unaffected ordinary <=1s continuity remains and explicit batch policy keeps speech end', () => {
  const sources = [segment('앞 검증 대사', 2, 3), segment('뒤 검증 대사', 3.8, 4)];
  assert.equal(buildSubtitleCues(sources)[0].end, 3.8);
  assert.equal(buildSubtitleCues(sources, { holdShortGaps: false })[0].end, 3);
  assert.deepEqual(sources.map(({ start, end }) => [start, end]), [[2, 3], [3.8, 4]]);
});

test('independent QA: restoration returns the exact pre-exclusion split timeline and original fields', () => {
  const source = { ...segment('김하늘 씨, 네 네 3.5kg 맞아요', 0, 0.9),
    timingSource: 'word', wordAlignedCues: [[0, 0.9, '김하늘 씨, 네 네 3.5kg 맞아요']],
    subtitleReview: { version: 1, issues: [], originalText: '합성 최초 문구', originalTiming: { start: 0, end: 0.9 } } };
  const before = structuredClone(source);
  const excluded = clientReview.setSubtitleExclusion(source, true);
  assert.equal(serverReview.isLocallyExcluded(excluded), true);
  const restored = clientReview.setSubtitleExclusion(excluded, false);
  assert.equal(serverReview.isLocallyExcluded(restored), false);
  assert.deepEqual(compact(buildSubtitleCues([restored])), compact(buildSubtitleCues([source])));
  assert.equal(restored.text, source.text);
  assert.deepEqual([restored.start, restored.end, restored.wordAlignedCues], [source.start, source.end, source.wordAlignedCues]);
  assert.equal(restored.subtitleReview.originalText, source.subtitleReview.originalText);
  assert.deepEqual(restored.subtitleReview.originalTiming, source.subtitleReview.originalTiming);
  assert.deepEqual(source, before);
});

test('independent QA: same-timeline decisions round-trip in owner/log-scoped drafts and stale bindings become visible', () => {
  const source = segment('초안 합성 문장', 0, 1), excluded = decide(source), store = storage();
  drafts.writeResultDraft(store, 'qa-owner', 8123, { segments: [excluded], fullTextDraft: source.text,
    baseText: source.text, baseSignature: clientReview.subtitleEditSignature([source]) });
  const restored = drafts.readResultDraft(store, 'qa-owner', 8123, [source]);
  assert.ok(restored);
  assert.equal(serverReview.isLocallyExcluded(restored.segments[0]), true);
  assert.equal(drafts.readResultDraft(store, 'different-owner', 8123, [source]), null);
  assert.equal(drafts.readResultDraft(store, 'qa-owner', 8124, [source]), null);
  const changed = { ...excluded, text: '다시 편집한 합성 문장' };
  assert.equal(serverReview.isLocallyExcluded(changed), false);
  assert.ok(generateSRT([changed]).includes(changed.text));
});

async function localDownloadFixture(t) {
  // Set synthetic destinations before importing any client constructors.
  process.env.SUPABASE_URL = 'https://qa-local-transcript.invalid';
  process.env.SUPABASE_ANON_KEY = 'qa-local-anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'qa-local-service';
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.hostname, '127.0.0.1', 'No external network is authorized in this QA fixture');
    return originalFetch(input, options);
  });
  const [{ default: router }, { supabase, supabaseAdmin }, { creditLedgerStore }] = await Promise.all([
    import('../src/routes/download.js'), import('../src/lib/supabase.js'), import('../src/services/credit-ledger.js'),
  ]);
  t.mock.method(supabase.auth, 'getUser', async () => ({ data: { user: { id: '00000000-0000-4000-8000-000000000081', email: 'qa-local@example.test' } }, error: null }));
  t.mock.method(creditLedgerStore, 'expireForUser', async () => ({ discrepancy: false, credits_remaining: 10 }));
  t.mock.method(supabaseAdmin, 'from', table => {
    assert.equal(table, 'profiles');
    return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: { credits: 10, plan: 'free' }, error: null }; } };
  });
  const app = express(); app.use(express.json()); app.use('/api/download', router);
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  t.after(async () => { const closed = once(listener, 'close'); listener.close(); await closed; });
  return body => fetch(`http://127.0.0.1:${listener.address().port}/api/download`, {
    method: 'POST', headers: { Authorization: 'Bearer qa-synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('independent QA: real local download route rejects all-excluded SRT, ASS and TXT without a database request', async t => {
  const download = await localDownloadFixture(t), sources = [decide(segment())];
  for (const format of ['srt', 'ass', 'txt']) {
    const response = await download({ segments: sources, format });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /없|제외/);
  }
});

test('independent QA: real local download route preserves decisions and barriers for single and batch flags', async t => {
  const download = await localDownloadFixture(t);
  const sources = [segment('앞 API 합성 대사', 0, 1), decide(segment('가릴 API 합성 대사', 1.1, 1.3)), segment('뒤 API 합성 대사', 1.5, 2)];
  for (const holdShortGaps of [true, false]) {
    for (const format of ['srt', 'ass', 'txt']) {
      const response = await download({ segments: sources, format, holdShortGaps });
      assert.equal(response.status, 200);
      const output = await response.text();
      assert.equal(output.includes(sources[1].text), false);
      assert.ok(output.includes(sources[0].text));
      assert.ok(output.includes(sources[2].text));
    }
  }
});

test('independent QA: real local download route reports shared-owner conflict as 400 for every format', async t => {
  const download = await localDownloadFixture(t);
  const sources = [decide(segment('첫 공유 합성 문장', 0, 1)), segment('둘째 공유 합성 문장', 0, 2)];
  for (const format of ['srt', 'ass', 'txt']) {
    const response = await download({ segments: sources, format });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /제외 충돌/);
  }
});

function nativeWav({ channels = 2, rate = 1000, bits = 16, floating = false, seconds = 8, sample = () => 0 } = {}) {
  const bytes = bits / 8, frames = Math.round(rate * seconds);
  const payload = Buffer.alloc(frames * channels * bytes);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = (frame * channels + channel) * bytes, value = sample(frame, channel);
      if (floating) bits === 32 ? payload.writeFloatLE(value, offset) : payload.writeDoubleLE(value, offset);
      else if (bits === 8) payload[offset] = value + 128;
      else payload.writeIntLE(value, offset, bytes);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + payload.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(floating ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytes, 28); header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bits, 34); header.write('data', 36); header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

const riskyRows = () => [1, 3, 5].map(start => ({
  ...segment('이 문장은 합성 반복 확인용입니다', start, start + 0.2),
  no_speech_prob: 0.95, avg_logprob: -1.2,
}));
const localReview = () => import('../src/services/local-transcript-review.js');

async function reviewAudio(buffer, { rows = riskyRows(), sourceSegments = rows, ...options } = {}) {
  const { annotateLocalTranscriptReview } = await localReview();
  const before = structuredClone(rows), sourceBefore = structuredClone(sourceSegments);
  const result = await annotateLocalTranscriptReview(rows, { sourceSegments, buffer, originalname: 'qa-synthetic.wav', language: 'ko', ...options });
  assert.deepEqual(rows, before);
  assert.deepEqual(sourceSegments, sourceBefore);
  assert.deepEqual(result.segments.map(({ text, start, end }) => [text, start, end]), before.map(({ text, start, end }) => [text, start, end]));
  return result;
}

test('independent QA: exact native silence plus corroborated source risk can be excluded without changing originals', async () => {
  const result = await reviewAudio(nativeWav());
  assert.equal(result.segments.filter(serverReview.isLocallyExcluded).length, 3);
  assert.equal(result.segments.every(row => serverReview.getBoundLocalExclusion(row).status === 'automatic'), true);
  assert.equal(result.segments.every(row => serverReview.getBoundLocalExclusion(row).audioStatus === 'exact_zero'), true);
});

test('independent QA: empty, invalid and out-of-coverage sample ranges never become exact-zero evidence', async () => {
  const { analyzeExactSilenceRanges } = await localReview();
  const ranges = [
    { start: 0, end: 0 }, { start: -0.1, end: 0.2 }, { start: 0, end: 9 },
    { start: 1, end: 0.5 }, { start: NaN, end: 1 }, { start: 0, end: Infinity },
  ];
  const result = await analyzeExactSilenceRanges(nativeWav(), { originalname: 'qa-synthetic.wav', ranges });
  assert.equal(result.measurements.length, ranges.length);
  assert.equal(result.measurements.every(item => item.status === 'unavailable'), true);
  assert.deepEqual((await analyzeExactSilenceRanges(nativeWav(), { ranges: [] })).measurements, []);
});

test('independent QA: an exact 105600-frame 48kHz boundary is covered despite decimal multiplication error', async () => {
  const { analyzeExactSilenceRanges } = await localReview();
  const result = await analyzeExactSilenceRanges(nativeWav({ rate: 48_000, seconds: 2.2 }), {
    originalname: 'qa-synthetic.wav', ranges: [{ start: 0, end: 2.2 }],
  });
  assert.equal(result.measurements[0].status, 'exact_zero');
});

test('independent QA: analysis window and aggregate-audio limits leave unmeasured ranges unavailable', async () => {
  const { analyzeExactSilenceRanges } = await localReview();
  const buffer = nativeWav({ seconds: 20 });
  const windows = Array.from({ length: 13 }, (_unused, index) => ({ start: index, end: index + 0.1 }));
  const first = await analyzeExactSilenceRanges(buffer, { originalname: 'qa-synthetic.wav', ranges: windows });
  assert.equal(first.measurements.length, 13);
  assert.equal(first.measurements[12].status, 'unavailable');
  const total = await analyzeExactSilenceRanges(buffer, { originalname: 'qa-synthetic.wav', ranges: Array.from({ length: 4 }, () => ({ start: 0, end: 20 })) });
  assert.equal(total.measurements.length, 4);
  assert.equal(total.measurements.slice(0, 3).every(item => item.status === 'exact_zero'), true);
  assert.equal(total.measurements[3].status, 'unavailable');
});

test('independent QA: high-confidence silence is preserved instead of promoted from zero samples alone', async () => {
  const rows = riskyRows().map(row => ({ ...row, no_speech_prob: 0.05, avg_logprob: -0.1 }));
  const result = await reviewAudio(nativeWav(), { rows });
  assert.equal(result.segments.some(serverReview.isLocallyExcluded), false);
});

test('independent QA: native precision preserves PCM least-significant samples and tiny IEEE samples', async t => {
  for (const format of [
    { bits: 8, value: 1 }, { bits: 16, value: 1 }, { bits: 24, value: 1 }, { bits: 32, value: 1 },
    { bits: 32, floating: true, value: 1e-40 }, { bits: 64, floating: true, value: 1e-300 },
  ]) {
    await t.test(`${format.floating ? 'IEEE' : 'PCM'} ${format.bits}`, async () => {
      const audio = nativeWav({ ...format, sample: (_frame, channel) => channel === 1 ? format.value : 0 });
      const result = await reviewAudio(audio);
      assert.equal(result.segments.some(serverReview.isLocallyExcluded), false);
    });
  }
});

test('independent QA: minus60dB signal, music-like waveform and stereo phase cancellation are preserved', async () => {
  for (const sample of [
    () => 0.001,
    frame => 0.001 * Math.sin(frame * 0.217),
    (_frame, channel) => channel === 0 ? 0.001 : -0.001,
  ]) {
    const result = await reviewAudio(nativeWav({ bits: 32, floating: true, sample }));
    assert.equal(result.segments.some(serverReview.isLocallyExcluded), false);
  }
});

test('independent QA: signal in the quarter-second guard prevents exclusion of an otherwise zero cue', async () => {
  const rows = [riskyRows()[0]];
  const buffer = nativeWav({ sample: frame => frame === 800 ? 1 : 0 });
  const result = await reviewAudio(buffer, { rows });
  assert.equal(result.segments.some(serverReview.isLocallyExcluded), false);
});

test('independent QA: truncated input, nonfinite samples, incomplete guards and failed analysis preserve captions', async () => {
  for (const buffer of [Buffer.from('unsupported-synthetic-format'), nativeWav().subarray(0, 45),
    nativeWav({ bits: 32, floating: true, sample: () => NaN })]) {
    const result = await reviewAudio(buffer);
    assert.equal(result.segments.some(serverReview.isLocallyExcluded), false);
  }
  const incompleteGuard = [0.1, 7.8].map(start => ({ ...riskyRows()[0], start, end: start + 0.1 }));
  const result = await reviewAudio(nativeWav(), { rows: incompleteGuard });
  assert.equal(result.segments.some(serverReview.isLocallyExcluded), false);
  const failed = await reviewAudio(nativeWav(), { analyzeAudio: async () => { throw new Error('synthetic local analysis failure'); } });
  assert.equal(failed.segments.some(serverReview.isLocallyExcluded), false);
  assert.equal(failed.summary.analyzedWindows, 0);
  assert.equal(failed.summary.unavailableWindows, 3);
});

test('independent QA: partial measurements distinguish real analysis, unavailable windows and applied exclusions', async () => {
  const result = await reviewAudio(nativeWav(), {
    analyzeAudio: async (_buffer, { ranges }) => ({ measurements: ranges.slice(0, 2).map((range, index) => ({
      ...range, status: index === 0 ? 'exact_zero' : 'signal_present',
    })) }),
  });
  assert.equal(result.summary.analyzedWindows, 2);
  assert.equal(result.summary.unavailableWindows, 1);
  assert.equal(result.summary.automaticExcluded, 1);
  assert.equal(result.summary.reviewCandidates, 2);
  assert.equal(result.segments.filter(serverReview.isLocallyExcluded).length, 1);
});

test('independent QA: confidence from different or ambiguous raw text cannot authorize exclusion', async () => {
  const rows = riskyRows();
  const different = rows.map(row => ({ ...row, text: '다른 원전사 합성 문장입니다' }));
  assert.equal((await reviewAudio(nativeWav(), { rows, sourceSegments: different })).segments.some(serverReview.isLocallyExcluded), false);
  assert.equal((await reviewAudio(nativeWav(), { rows, sourceSegments: [...rows, ...structuredClone(rows)] })).segments.some(serverReview.isLocallyExcluded), false);
});

test('independent QA: local automatic analysis leaves English and diarized provider responses unchanged', async () => {
  for (const options of [
    { rows: riskyRows().map(row => ({ ...row, text: 'Repeated synthetic English line' })), language: 'en' },
    { rows: riskyRows().map(row => ({ ...row, speaker: 0 })) },
  ]) {
    const result = await reviewAudio(nativeWav(), options);
    assert.equal(result.segments.some(serverReview.isLocallyExcluded), false);
  }
});
