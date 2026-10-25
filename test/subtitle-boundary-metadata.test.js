import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSubtitleReviews, retainManualSubtitleRange } from '../src/services/subtitle-review.js';
import { buildSubtitleCues, generateSRT, generateASS } from '../src/services/subtitle.js';
import { processTranscriptionSegments } from '../src/services/transcription-processing.js';
import { reviewTranscriptionTiming } from '../src/services/transcription-review-pipeline.js';

const originalTiming = { start: 3, end: 4 };
const timing = { sourceStart: 3, sourceEnd: 4, start: 2.8, end: 4.5,
  matchingText: '준비해 주세요', status: 'consistent_estimate', windowCount: 2, startSpread: .02, endSpread: .04 };
const wrap = value => ({ version: 1, issues: [], ...value });

test('timing metadata preserves bounded known fields and discards malformed or speculative values', () => {
  const confirmation = { ...timing, status: 'confirmed' };
  const review = mergeSubtitleReviews(wrap({ originalTiming, timingCandidate: { ...timing, wordTruth: true }, timingConfirmation: confirmation }));
  assert.deepEqual(review.originalTiming, originalTiming);
  assert.deepEqual(review.timingCandidate, timing);
  assert.equal(review.timingConfirmation.status, 'confirmed');
  assert.equal(Object.hasOwn(review.timingConfirmation, 'windowCount'), false);
  for (const value of [{ ...timing, start: NaN }, { ...timing, end: Infinity }, { ...timing, start: -1 },
    { ...timing, sourceEnd: 2 }, { ...timing, end: 1 }, { ...timing, status: 'verified' },
    { ...timing, matchingText: 'x'.repeat(10_001) }]) {
    assert.equal(mergeSubtitleReviews(wrap({ timingCandidate: value })), undefined);
  }
});

function manualSegment() {
  return { start: 2.8, end: 4.5, text: timing.matchingText, timingSource: 'word',
    sourceWords: [{ word: timing.matchingText, start: 3.2, end: 3.8 }],
    wordAlignedCues: [[3.2, 3.8, timing.matchingText]],
    subtitleReview: wrap({ originalTiming, timingConfirmation: { ...timing, status: 'confirmed' } }) };
}

test('explicit manual ranges override stale word-derived cues in SRT and ASS without mutating the saved input', () => {
  const input = manualSegment();
  const before = structuredClone(input);
  const manual = retainManualSubtitleRange(input);
  assert.equal(manual.timingSource, 'manual');
  assert.equal(manual.sourceWords, undefined);
  assert.equal(manual.wordAlignedCues, undefined);
  assert.deepEqual(buildSubtitleCues([input], { holdShortGaps: false }).map(c => [c.start, c.end]), [[2.8, 4.5]]);
  assert.match(generateSRT([input], null, { holdShortGaps: false }), /00:00:02,800 --> 00:00:04,500/);
  assert.match(generateASS([input], { holdShortGaps: false }), /0:00:02\.80,0:00:04\.50/);
  assert.deepEqual(input, before);
});

test('stale text/time confirmation, a verified audio floor and labelled sources cannot override word metadata', () => {
  for (const value of [
    { ...manualSegment(), text: '문구 변경' }, { ...manualSegment(), start: 2.7 },
    { ...manualSegment(), audioStartFloor: 3 }, { ...manualSegment(), speaker: 0 },
  ]) assert.equal(retainManualSubtitleRange(value), value);
});

test('manual ranges keep dependent-predicate rows separate while display-only gaps retain the existing inclusive rule', () => {
  const first = { start: 10, end: 11, text: '차근차근 준비해', timingSource: 'manual', subtitleReview: wrap({ originalTiming: { start: 10, end: 10.9 } }) };
  const second = { start: 11.2, end: 12, text: '주시면 됩니다', timingSource: 'manual', subtitleReview: wrap({ originalTiming: { start: 11.2, end: 11.9 } }) };
  assert.equal(buildSubtitleCues([first, second], { holdShortGaps: false }).length, 2);
  assert.deepEqual(buildSubtitleCues([first, second]).map(c => [c.start, c.end]), [[10, 11.2], [11.2, 12]]);
});

test('native audio start evidence survives result serialization for later explicit time edits', async () => {
  const source = [{ start: 1, end: 3, text: '준비해 주세요', audioStartFloor: 1.4 }];
  const result = await processTranscriptionSegments(source, 'ko', { correct: async text => text });
  assert.equal(result.segments[0].start, 1.4);
  assert.equal(result.segments[0].audioStartFloor, 1.4);
  assert.equal(result.segments[0].sourceWords, undefined);
});

const longSource = () => ({ start: 10, end: 12, text: '차근차근 준비해 주세요', sourceWords: [
  { word: '차근차근', start: 10, end: 11.1 }, { word: '준비해', start: 11.1, end: 11.6 }, { word: '주세요', start: 11.6, end: 12 },
] });
const compressedSource = start => ({ start, end: start + .2, text: '앞쪽 설명을 시작해요' });
function measured(window) {
  return { language: 'korean', model: 'whisper-1', text: '차근차근 준비해 주세요', words: [
    { word: '차근차근', start: 10.4 - window.start, end: 10.9 - window.start },
    { word: '준비해', start: 10.9 - window.start, end: 11.3 - window.start },
    { word: '주세요', start: 11.3 - window.start, end: 11.8 - window.start },
  ] };
}

test('production timing pipeline shares one three-request allowance and keeps dialogue unchanged', async () => {
  const result = { language: 'korean', segments: [compressedSource(2), longSource()], timings: { chunkCount: 1 } };
  const before = structuredClone(result);
  const calls = [];
  const reviewed = await reviewTranscriptionTiming(result, { durationSeconds: 30,
    transcribeRange: async (window, options) => {
      calls.push({ window, options });
      return calls.length === 1 ? { words: [] } : measured(window);
    } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.allowVocabulary, true);
  assert.ok(calls.slice(1).every(call => call.options?.allowVocabulary !== true));
  assert.equal(reviewed.timings.boundaryReviewBudget.requests, 3);
  assert.ok(reviewed.timings.boundaryReviewBudget.seconds <= 60);
  assert.deepEqual(reviewed.segments.map(s => s.text), result.segments.map(s => s.text));
  assert.equal(reviewed.segments[1].start, 10.4);
  assert.equal(reviewed.segments[1].end, 11.8);
  assert.equal(reviewed.segments[1].subtitleReview.timingStatus, 'unverified');
  assert.deepEqual(result, before);
});

test('three failed compressed attempts exhaust the shared allowance without a fourth boundary request', async () => {
  let calls = 0;
  const source = [compressedSource(2), longSource(), compressedSource(30), compressedSource(58)];
  const reviewed = await reviewTranscriptionTiming({ language: 'ko', segments: source }, { durationSeconds: 90,
    transcribeRange: async () => { calls += 1; throw new Error('synthetic unavailable'); } });
  assert.equal(calls, 3);
  assert.equal(reviewed.timings.boundaryReviewBudget.requests, 3);
  assert.equal(reviewed.timings.boundaryReviewMeasurements.length, 0);
  assert.deepEqual(reviewed.segments.map(s => [s.start, s.end]), source.map(s => [s.start, s.end]));
});

test('disabled or non-Korean review performs no requests; cancellation cannot return an applied estimate', async () => {
  const source = { language: 'en', segments: [longSource()] };
  let calls = 0;
  assert.equal(await reviewTranscriptionTiming(source, { durationSeconds: 30, transcribeRange: () => { calls += 1; } }), source);
  await reviewTranscriptionTiming({ ...source, language: 'ko' }, { durationSeconds: 30, recheckCompressed: false, recheckBoundaries: false, transcribeRange: () => { calls += 1; } });
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(reviewTranscriptionTiming({ language: 'ko', segments: [longSource()] }, {
    durationSeconds: 30, recheckCompressed: false, signal: controller.signal,
    transcribeRange: async window => { controller.abort(); return measured(window); },
  }), error => error.name === 'AbortError');
});
