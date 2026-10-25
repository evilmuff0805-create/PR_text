import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSCRIPTION_BOUNDARY_LIMITS,
  planTranscriptionBoundaryWindows,
  recheckTranscriptionBoundaries,
} from '../src/services/transcription-boundaries.js';
import { generateASS, generateSRT } from '../src/services/subtitle.js';
import { createBatchSrtArchive } from '../src/services/batch-archive.js';
import { reviewTranscriptionTiming } from '../src/services/transcription-review-pipeline.js';
import { retainManualSubtitleRange, mergeSubtitleReviews } from '../src/services/subtitle-review.js';
import {
  confirmSubtitleTiming, editSubtitleText, getSubtitleTimingCandidate,
  getSubtitleTimingConfirmation, validateSubtitleTiming, formatSubtitleTimeInput, parseSubtitleTimeInput,
} from '../client/src/utils/subtitle-review.js';

// Independent anonymous cases were sealed before this module existed.
// They test attribution and preservation; no provider estimate is audio gold.
const clone = value => structuredClone(value);
const windows = () => [
  { start: 8, end: 16, indices: [1] },
  { start: 7, end: 17, indices: [1] },
];
function sources(text = '자료를 차분히 확인해요') {
  const tokens = text.split(' ');
  return [
    { start: 8, end: 9, text: '앞 대사' },
    { start: 10, end: 13, text, sourceWords: tokens.map((word, index) => ({
      word, start: 10 + index * 1.1, end: index === tokens.length - 1 ? 13 : 11.1 + index * 1.1,
    })) },
    { start: 15, end: 16, text: '다음 대사' },
  ];
}
function response(window, { text = '자료를 차분히 확인해요', start = 10.4, end = 12.5 } = {}) {
  const tokens = text.split(' ');
  const duration = (end - start) / tokens.length;
  return {
    language: 'korean',
    segments: [{ start: start - window.start, end: end - window.start, text }],
    words: tokens.map((word, index) => ({ word,
      start: start + duration * index - window.start,
      end: index === tokens.length - 1 ? end - window.start : start + duration * (index + 1) - window.start,
    })),
  };
}
const speech = segments => segments.map(({ start, end, text, sourceWords }) => ({ start, end, text, sourceWords }));
const consistent = result => result.candidates.filter(candidate => candidate.status === 'consistent_estimate');
async function evaluate({ source = sources(), options = {}, provider = window => response(window) } = {}) {
  const before = clone(source);
  const attempted = [];
  const result = await recheckTranscriptionBoundaries(source, {
    language: 'korean', durationSeconds: 20, indices: [1], reviewWindows: windows(), ...options,
    transcribeRange: async window => { attempted.push(clone(window)); return provider(window, attempted.length); },
  });
  assert.deepEqual(source, before, 'the caller source and its original word data must not mutate');
  return { result, attempted, source };
}
function noAppliedChange(result, source) {
  assert.deepEqual(speech(result.segments), speech(source));
}

test('independent boundary candidates accept shorter exact consensus but remain detached by default', async () => {
  const { result, attempted, source } = await evaluate();
  assert.equal(attempted.length, 2);
  assert.equal(consistent(result).length, 1);
  const candidate = consistent(result)[0];
  assert.equal(candidate.original.start, 10);
  assert.equal(candidate.original.end, 13);
  assert.ok(Math.abs(candidate.proposal.start - 10.4) < 1e-9);
  assert.ok(Math.abs(candidate.proposal.end - 12.5) < 1e-9);
  assert.equal(candidate.evidence.length, 2);
  assert.equal(result.scope.coverage, 'selected_group');
  noAppliedChange(result, source);
});

test('explicit estimate application preserves every spoken character and uses one measured word sequence', async () => {
  const { result, attempted, source } = await evaluate({
    options: { applyConsistentEstimates: true },
    provider: (window, call) => response(window, { start: call === 1 ? 10.4 : 10.45, end: call === 1 ? 12.5 : 12.55 }),
  });
  assert.equal(attempted.length, 2);
  assert.deepEqual(result.segments.map(segment => segment.text), source.map(segment => segment.text));
  assert.equal(result.segments[1].start, 10.45);
  assert.equal(result.segments[1].end, 12.55);
  assert.equal(result.segments[1].subtitleReview.timingStatus, 'unverified');
  assert.deepEqual(result.segments[1].sourceWords, consistent(result)[0].proposal.sourceWords);
  assert.deepEqual(result.segments[0], source[0]);
  assert.deepEqual(result.segments[2], source[2]);
});

for (const [id, sourceText, measuredText] of [
  ['changed-conjugation', '자료를 차분히 확인해요', '자료를 차분히 확인했어요'],
  ['decimal-value', '3.5 킬로를 준비해요', '35 킬로를 준비해요'],
  ['numeric-sign', '-3 도라고 말해요', '3 도라고 말해요'],
  ['repeat-count', '다시 다시 확인해요', '다시 확인해요'],
]) {
  test(`different spoken content cannot supply active timing: ${id}`, async () => {
    const { result, source } = await evaluate({ source: sources(sourceText),
      options: { applyConsistentEstimates: true }, provider: window => response(window, { text: measuredText }) });
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  });
}

const invalidWords = [
  ['missing-word', words => words.splice(1, 1)],
  ['zero-duration', words => { words[1].end = words[1].start; }],
  ['overlap', words => { words[1].start = words[0].end - 0.05; }],
  ['reversed', words => words.reverse()],
  ['null-start', words => { words[0].start = null; }],
  ['string-start', words => { words[0].start = String(words[0].start); }],
  ['infinite-end', words => { words[1].end = Infinity; }],
  ['negative-local-time', words => { words[0].start = -0.1; }],
  ['beyond-window', (words, window) => { words.at(-1).end = window.end - window.start + 0.1; }],
];
for (const [id, damage] of invalidWords) {
  test(`incomplete or invalid provider word evidence fails closed: ${id}`, async () => {
    const { result, source } = await evaluate({ options: { applyConsistentEstimates: true }, provider: window => {
      const measured = response(window); damage(measured.words, window); return measured;
    } });
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  });
}

test('two complete occurrences in a window do not establish a unique utterance', async () => {
  const { result, source } = await evaluate({ options: { applyConsistentEstimates: true }, provider: window => {
    const first = response(window);
    const second = response(window, { start: 12.7, end: 14.8 });
    return { ...first, segments: [...first.segments, ...second.segments], words: [...first.words, ...second.words] };
  } });
  assert.equal(consistent(result).length, 0);
  noAppliedChange(result, source);
});

test('one context or a duplicated context cannot establish independent agreement', async () => {
  for (const reviewWindows of [windows().slice(0, 1), [windows()[0], windows()[0]]]) {
    const { result, source } = await evaluate({ options: { reviewWindows, applyConsistentEstimates: true } });
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  }
});

test('disagreeing context estimates and a shared but excessive offset are not applied', async () => {
  for (const builder of [
    (window, call) => response(window, { start: call === 1 ? 10.3 : 10.6 }),
    window => response(window, { start: 12.2, end: 12.8 }),
  ]) {
    const { result, source } = await evaluate({ options: { applyConsistentEstimates: true }, provider: builder });
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  }
});

test('a candidate may not invade neighbouring speech or silently absorb overlapping speakers', async () => {
  for (const source of [
    sources().map((segment, index) => index === 0 ? { ...segment, end: 10.5 } : segment),
    sources().map((segment, index) => index === 2 ? { ...segment, start: 12.4 } : segment),
  ]) {
    const { result } = await evaluate({ source, options: { applyConsistentEstimates: true } });
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  }
});

test('every agreeing context must independently satisfy neighbouring speech and movement bounds', async () => {
  const cases = [
    { source: sources().map((segment, index) => index === 0 ? { ...segment, end: 10.4 } : segment),
      provider: (window, call) => response(window, { start: call === 1 ? 10.35 : 10.45 }) },
    { source: sources(),
      provider: (window, call) => response(window, { start: 10.4, end: call === 1 ? 10.95 : 11.05 }) },
  ];
  for (const entry of cases) {
    const { result, source } = await evaluate({ ...entry, options: { applyConsistentEstimates: true } });
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  }
});

test('unsupported source languages and opaque speaker zero do not call the provider', async () => {
  for (const options of [{ language: 'english' }, { language: 'japanese' }, { language: 'unknown' }]) {
    const { result, attempted, source } = await evaluate({ options });
    assert.equal(attempted.length, 0);
    noAppliedChange(result, source);
  }
  const { result, attempted, source } = await evaluate({
    source: sources().map((segment, index) => index === 1 ? { ...segment, speaker: 0 } : segment),
  });
  assert.equal(attempted.length, 0);
  noAppliedChange(result, source);
});

test('wrong-language and labelled provider responses cannot supply timing evidence', async () => {
  for (const modify of [
    measured => ({ ...measured, language: 'english' }),
    measured => ({ ...measured, segments: measured.segments.map(segment => ({ ...segment, speaker: 0 })) }),
  ]) {
    const { result, source } = await evaluate({ options: { applyConsistentEstimates: true },
      provider: window => modify(response(window)) });
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  }
});

test('failed requests consume the shared budget but never authorize a timing update', async () => {
  const prior = { requests: 1, seconds: 7 };
  const { result, attempted, source } = await evaluate({ options: { budget: prior, applyConsistentEstimates: true },
    provider: () => { throw new Error('anonymous provider failure'); } });
  assert.deepEqual(prior, { requests: 1, seconds: 7 });
  assert.ok(attempted.length > 0 && attempted.length <= 2);
  assert.equal(result.budget.requests, prior.requests + attempted.length);
  assert.equal(result.budget.seconds, prior.seconds + attempted.reduce((sum, window) => sum + window.end - window.start, 0));
  assert.equal(consistent(result).length, 0);
  noAppliedChange(result, source);
});

test('remaining compressed-review budget limits boundary calls and incomplete consensus stays detached', async () => {
  for (const budget of [{ requests: 2, seconds: 12 }, { requests: 3, seconds: 12 }, { requests: 0, seconds: 55 }]) {
    const { result, attempted, source } = await evaluate({ options: { budget, applyConsistentEstimates: true } });
    assert.ok(budget.requests + attempted.length <= 3);
    assert.ok(budget.seconds + attempted.reduce((sum, window) => sum + window.end - window.start, 0) <= 60);
    assert.equal(consistent(result).length, 0);
    noAppliedChange(result, source);
  }
});

test('the integrated budget counts a multi-row compressed window once before two boundary contexts', async () => {
  for (const failCompressed of [false, true]) {
    const source = [
      { start: 2, end: 2.1, text: '앞쪽 설명을 시작해요' },
      { start: 3, end: 3.2, text: '다른 설명도 시작해요' },
      sources()[1], sources()[2],
    ];
    const before = clone(source), calls = [];
    const reviewed = await reviewTranscriptionTiming({ language: 'korean', segments: source }, {
      durationSeconds: 20, boundaryReviewIndices: [2],
      boundaryReviewWindows: windows().map(window => ({ ...window, indices: [2] })),
      transcribeRange: async (window, options) => {
        calls.push({ window: clone(window), allowVocabulary: options?.allowVocabulary });
        if (calls.length === 1) {
          if (failCompressed) throw new Error('anonymous shared-window failure');
          return { language: 'korean', words: [] };
        }
        return response(window);
      },
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].allowVocabulary, true);
    assert.ok(calls.slice(1).every(call => call.allowVocabulary !== true));
    assert.equal(reviewed.timings.boundaryReviewBudget.requests, 3);
    assert.ok(Math.abs(reviewed.timings.boundaryReviewBudget.seconds
      - calls.reduce((sum, call) => sum + call.window.end - call.window.start, 0)) < 1e-9);
    assert.deepEqual(reviewed.segments.map(segment => segment.text), source.map(segment => segment.text));
    assert.equal(reviewed.segments[2].start, 10.4);
    assert.equal(reviewed.segments[2].subtitleReview.timingStatus, 'unverified');
    assert.deepEqual(source, before);
  }
});

test('planning and explicit requests never exceed the three-call twenty-second sixty-second contract', async () => {
  assert.equal(TRANSCRIPTION_BOUNDARY_LIMITS.maxRequests, 3);
  assert.equal(TRANSCRIPTION_BOUNDARY_LIMITS.maxWindowSeconds, 20);
  assert.equal(TRANSCRIPTION_BOUNDARY_LIMITS.maxTotalSeconds, 60);
  const planned = planTranscriptionBoundaryWindows(sources(), { language: 'korean', durationSeconds: 20, indices: [1] });
  assert.ok(planned.length <= 3);
  assert.ok(planned.every(window => window.end > window.start && window.end - window.start <= 20));
  assert.ok(planned.reduce((sum, window) => sum + window.end - window.start, 0) <= 60);
  const { result, attempted, source } = await evaluate({ options: {
    reviewWindows: [{ start: 0, end: 20.001, indices: [1] }, ...windows(), ...windows()],
  } });
  assert.ok(attempted.length <= 3);
  assert.ok(attempted.every(window => window.end - window.start <= 20));
  assert.ok(result.budget.seconds <= 60);
  noAppliedChange(result, source);
});

test('cancellation propagates before a call and after a provider settles', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(evaluate({ options: { signal: before.signal } }), { name: 'AbortError' });
  const during = new AbortController(); let calls = 0;
  await assert.rejects(evaluate({ options: { signal: during.signal }, provider: window => {
    calls += 1; during.abort(); return response(window);
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('an unsuccessful fresh recheck removes stale timing agreement without discarding text review', async () => {
  const source = sources();
  source[1].subtitleReview = { version: 1, issues: [], textStatus: 'candidate',
    originalText: source[1].text, candidateText: '자료를 차분히 확인했어요',
    timingCandidate: { sourceStart: 10, sourceEnd: 13, start: 10.4, end: 12.5,
      matchingText: source[1].text, status: 'consistent_estimate', windowCount: 2 } };
  const { result } = await evaluate({ source, provider: () => { throw new Error('anonymous retry failure'); } });
  assert.equal(result.segments[1].subtitleReview.timingCandidate, undefined);
  assert.equal(result.segments[1].subtitleReview.candidateText, source[1].subtitleReview.candidateText);
  noAppliedChange(result, source);
});

test('manual confirmation and JSON storage preserve original timing while old derived cue data cannot return', () => {
  const source = { ...sources()[1], timingSource: 'word', audioStartFloor: 9.9,
    wordAlignedCues: [[10, 11.1, '자료를'], [11.1, 13, '차분히 확인해요']],
    subtitleReview: { version: 1, issues: [{ code: 'audio_boundary_candidate', reason: 'window_agreement' }], timingCandidate: {
      sourceStart: 10, sourceEnd: 13, start: 10.4, end: 12.5,
      matchingText: '자료를 차분히 확인해요', status: 'unverified', windowCount: 2,
    } } };
  const before = clone(source);
  assert.ok(getSubtitleTimingCandidate(source));
  const manual = confirmSubtitleTiming(source, 10.4, 12.5);
  assert.equal(manual.text, source.text);
  assert.deepEqual(manual.subtitleReview.originalTiming, { start: 10, end: 13 });
  assert.equal(manual.sourceWords, undefined);
  assert.equal(manual.wordAlignedCues, undefined);
  assert.equal(manual.audioStartFloor, 9.9);
  assert.ok(manual.subtitleReview.issues.some(issue => issue.code === 'audio_boundary_candidate'));
  assert.equal(getSubtitleTimingCandidate(manual), undefined);
  assert.ok(getSubtitleTimingConfirmation(manual));
  const saved = JSON.parse(JSON.stringify({ ...manual, subtitleReview: mergeSubtitleReviews(manual.subtitleReview) }));
  assert.equal(saved.subtitleReview.timingStatus, 'unverified');
  assert.equal(retainManualSubtitleRange(saved).timingSource, 'manual');
  assert.match(generateSRT([saved], null, { holdShortGaps: false }), /00:00:10,400 --> 00:00:12,500/);
  const edited = editSubtitleText(saved, '자료를 천천히 확인해요');
  assert.equal(getSubtitleTimingConfirmation(edited), undefined);
  assert.equal(retainManualSubtitleRange(edited).timingSource, 'manual');
  assert.match(generateSRT([edited], null, { holdShortGaps: false }), /00:00:10,400 --> 00:00:12,500/);
  assert.deepEqual(source, before);
});

test('manual timing validation rejects neighbours, audio floor, invalid numbers and duration overflow', () => {
  const source = sources(); source[1].audioStartFloor = 9.9;
  for (const [start, end, durationSeconds] of [[8.9, 12, 20], [9.8, 12, 20], [11, 15.1, 20],
    [11, 12.6, 12.5], [NaN, 12, 20], [11, Infinity, 20], [12, 11, 20]]) {
    assert.ok(validateSubtitleTiming(source, 1, start, end, { durationSeconds }));
  }
  assert.equal(validateSubtitleTiming(source, 1, 10.4, 12.5, { durationSeconds: 20 }), null);
});

test('loading a submillisecond start estimate never rounds it to an earlier manual start', () => {
  for (const start of [0.0044, 10.0044, 123.4564]) {
    const input = formatSubtitleTimeInput(start, { isStart: true });
    const parsed = parseSubtitleTimeInput(input);
    assert.ok(parsed >= start, `${start} must not become ${input}`);
    assert.ok(parsed - start < 0.001);
    const source = { start, end: start + 1, text: '합성 시간 확인' };
    const manual = confirmSubtitleTiming(source, parsed, start + 1);
    assert.ok(srtCues(generateSRT([manual], null, { holdShortGaps: false }))[0].start >= start);
  }
  assert.equal(formatSubtitleTimeInput(10.0044), '10.004', 'ordinary ends retain nearest-millisecond display');
});

function timestamp(text) {
  return text.split(/[:,.]/).map(Number).reduce((seconds, part, index) => (
    index === 0 ? part * 3600 : index === 1 ? seconds + part * 60 : index === 2 ? seconds + part : seconds + part / 1000
  ), 0);
}
function srtCues(text) {
  return text.trim().split(/\n\n/).slice(1).map(block => {
    const lines = block.split('\n'), [start, end] = lines[1].split(' --> ');
    return { start: timestamp(start), end: timestamp(end), text: lines.slice(2).join(' ') };
  });
}

test('display continuity follows speech ends with an inclusive one-second threshold and no last-cue hold', () => {
  for (const gap of [0, 0.999, 1, 1.001]) {
    const source = [{ start: 10, end: 10.25, text: '첫 응답' },
      { start: 10.25 + gap, end: 13, text: '다음 응답' }];
    const before = clone(source), cues = srtCues(generateSRT(source));
    assert.equal(cues[0].end, gap > 0 && gap <= 1 ? cues[1].start : 10.25);
    assert.equal(cues[1].end, 13);
    assert.deepEqual(source, before);
  }
});

// The archive uses stored ZIP entries; parse their local records independently.
function archiveSrtContents(buffer) {
  const entries = [];
  for (let cursor = 0; buffer.readUInt32LE(cursor) === 0x04034b50;) {
    assert.equal(buffer.readUInt16LE(cursor + 8), 0);
    const size = buffer.readUInt32LE(cursor + 18);
    const nameLength = buffer.readUInt16LE(cursor + 26), extraLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
    const start = cursor + 30 + nameLength + extraLength;
    if (name.endsWith('.srt')) entries.push(buffer.subarray(start, start + size).toString('utf8'));
    cursor = start + size;
  }
  return entries;
}

test('five independent tracks and labelled speech keep speech ends while a single holds its display end', () => {
  const source = [{ start: 10.0044, end: 10.2044, text: '응답' }, { start: 11.0044, end: 11.4044, text: '다음 안내' }];
  const before = clone(source);
  assert.equal(srtCues(generateSRT(source))[0].end, 11.005);
  assert.match(generateASS(source), /0:00:10\.01,0:00:11\.01/);
  const archive = createBatchSrtArchive({ items: Array.from({ length: 5 }, (_, index) => ({
    label: `합성 ${index + 1}`, status: 'completed', segments: clone(source),
  })) });
  const entries = archiveSrtContents(archive.buffer);
  assert.equal(entries.length, 5);
  for (const entry of entries) assert.equal(srtCues(entry)[0].end, 10.204);
  assert.equal(srtCues(generateSRT(source.map(segment => ({ ...segment, speaker: 0 }))))[0].end, 10.204);
  assert.equal(srtCues(generateSRT(source, null, { holdShortGaps: false }))[0].end, 10.204);
  assert.deepEqual(source, before);
});
