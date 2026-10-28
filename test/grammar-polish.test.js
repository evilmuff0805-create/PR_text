import test from 'node:test';
import assert from 'node:assert/strict';
import { polishKoreanSegments } from '../src/services/grammar-polish.js';
import { buildSubtitleCues, generateASS, generateSRT } from '../src/services/subtitle.js';
import { processTranscriptionSegments } from '../src/services/transcription-processing.js';

const cue = (text, extra = {}) => ({ start: 2.25, end: 2.7, text, ...extra });

test('omitted and preserve modes have identical outputs and never invoke the grammar model', async () => {
  const source = [{ start: 0, end: 0.5, text: '사과을 먹었다' }];
  let grammarCalls = 0;
  const options = { correct: async (text) => text, polishLines: async (lines) => { grammarCalls += 1; return lines; } };
  const omitted = await processTranscriptionSegments(source, 'ko', options);
  const explicit = await processTranscriptionSegments(source, 'ko', { ...options, polishMode: 'preserve' });
  assert.deepEqual(omitted.segments, explicit.segments);
  assert.equal(omitted.text, explicit.text);
  assert.equal(grammarCalls, 0);
  assert.equal(Object.hasOwn(omitted.segments[0], 'grammarPolish'), false);
});

test('grammar mode accepts a narrow Korean particle correction and keeps the corrected source text', async () => {
  const source = [cue('사과을 먹었다')];
  const result = await polishKoreanSegments(source, 'ko', { polishLines: async () => ({
    lines: ['사과를 먹었다'], model: 'mock-grammar-model',
    usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
  }) });
  assert.equal(result.applied, 1);
  assert.equal(result.segments[0].text, '사과를 먹었다');
  assert.equal(result.segments[0].grammarPolish.originalText, '사과을 먹었다');
  assert.equal(result.segments[0].grammarPolish.status, 'applied');
  assert.equal(result.metrics.calls, 1);
  assert.equal(result.metrics.model, 'mock-grammar-model');
  assert.equal(result.metrics.usage.totalTokens, 28);
});

test('flat word-timed rows may change grammar while retaining their range and timing marker', async () => {
  const source = [cue('사과을 먹었다', { timingSource: 'word' })];
  const result = await polishKoreanSegments(source, 'ko', { polishLines: async () => ['사과를 먹었다'] });
  assert.equal(result.segments[0].text, '사과를 먹었다');
  assert.equal(result.segments[0].start, source[0].start);
  assert.equal(result.segments[0].end, source[0].end);
  assert.equal(result.segments[0].timingSource, 'word');
});

test('preserves argument roles, punctuation, negation, numeric values, English tokens and repetition', async () => {
  const inputs = [
    ['철수가 영희를 도왔다', '철수를 영희가 도왔다'],
    ['회의에 가요?', '회의에 가요.'],
    ['고양이', '고양가'],
    ['안 먹었다', '먹었다'],
    ['못 먹었다', '안 먹었다'],
    ['-3.5 kg을 넣었다', '3,5 kg을 넣었다'],
    ['네 네 왔어요', '네 왔어요'],
    ['사과가 Hello 2개예요', '사과가 Hello 3개예요'],
  ];
  const result = await polishKoreanSegments(inputs.map(([text]) => cue(text)), 'ko', {
    polishLines: async () => inputs.map(([, candidate]) => candidate),
  });
  assert.equal(result.applied, 0);
  assert.deepEqual(result.segments.map(({ text }) => text), inputs.map(([text]) => text));
});

test('skips long, compact-word-aligned, unresolved-review and non-Korean rows', async () => {
  let calls = 0;
  const source = [
    cue('이 문장은 스물아홉 글자보다 길어서 대상이 되지 않습니다'),
    cue('정렬 보존', { wordAlignedCues: [[2.25, 2.4, '정렬'], [2.4, 2.7, '보존']] }),
    cue('검토 후보', { subtitleReview: { candidateText: '검토한 후보' } }),
    cue('Hello world', { start: 3, end: 4 }),
  ];
  const result = await polishKoreanSegments(source, 'ko', { polishLines: async (lines) => { calls += 1; return lines; } });
  assert.equal(calls, 0);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.segments.map(({ text }) => text), source.map(({ text }) => text));
  assert.deepEqual(result.segments.map(({ grammarPolish }) => grammarPolish?.status), ['long_line', 'word_timing', 'review_pending', 'non_korean_row']);

  let englishCalls = 0;
  const english = await polishKoreanSegments([cue('Hello')], 'en', { polishLines: async () => { englishCalls += 1; return ['Hello!']; } });
  assert.equal(englishCalls, 0);
  assert.equal(english.segments[0].text, 'Hello');
  assert.equal(english.skipped, 1);
});

test('candidate cue count, order, speaker and exact times must match for all exports', async () => {
  const source = [cue('사과을 먹었다'), { start: 3, end: 3.5, text: '다음 대사', speaker: 'opaque-2' }];
  let candidate = [source[0].text, source[1].text];
  const changed = await polishKoreanSegments(source, 'ko', { polishLines: async () => { candidate = ['사과를 먹었다', '다음 대사']; return candidate; } });
  assert.equal(changed.segments[0].text, '사과를 먹었다');
  assert.deepEqual(buildSubtitleCues(source, { holdShortGaps: false }).map(({ start, end, speaker }) => [start, end, speaker]),
    buildSubtitleCues(changed.segments, { holdShortGaps: false }).map(({ start, end, speaker }) => [start, end, speaker]));

  const mismatch = await polishKoreanSegments(source, 'ko', {
    polishLines: async () => ['사과를 먹었다', '다음 대사'],
    buildCues: (rows, options) => buildSubtitleCues(rows, options).map((item, index) => index === 0 ? { ...item, end: item.end + (rows[0].text === '사과를 먹었다' ? 0.01 : 0) } : item),
  });
  assert.equal(mismatch.applied, 0);
  assert.equal(mismatch.segments[0].text, '사과을 먹었다');
  assert.equal(mismatch.segments[0].grammarPolish.status, 'timeline_fallback');

  const baselineSrtTimes = generateSRT(source, null, { holdShortGaps: true }).split('\n').filter((line) => line.includes(' --> '));
  const changedSrtTimes = generateSRT(changed.segments, null, { holdShortGaps: true }).split('\n').filter((line) => line.includes(' --> '));
  assert.deepEqual(changedSrtTimes, baselineSrtTimes);
  const baselineAssTimes = generateASS(source, { holdShortGaps: true }).split('\n').filter((line) => /^Dialogue:/u.test(line)).map((line) => line.split(',').slice(1, 3).join(','));
  const changedAssTimes = generateASS(changed.segments, { holdShortGaps: true }).split('\n').filter((line) => /^Dialogue:/u.test(line)).map((line) => line.split(',').slice(1, 3).join(','));
  assert.deepEqual(changedAssTimes, baselineAssTimes);
});

test('model failure, malformed output, abort, and input cap retain baseline lines', async () => {
  const source = Array.from({ length: 121 }, (_, index) => cue(`사과을 먹었다 ${index}`));
  const inputSizes = [];
  const capped = await polishKoreanSegments(source, 'ko', { polishLines: async (lines) => { inputSizes.push(lines.length); return lines.map((line) => line.replace('사과을', '사과를')); } });
  assert.deepEqual(inputSizes, Array(10).fill(12));
  assert.equal(capped.applied, 120);
  assert.equal(capped.segments[12].text, '사과를 먹었다 12');
  assert.equal(capped.segments.at(-1).text, source.at(-1).text);
  assert.ok(capped.limited);

  const failed = await polishKoreanSegments([cue('사과을 먹었다')], 'ko', { polishLines: async () => { throw new Error('mock failure'); } });
  assert.equal(failed.segments[0].text, '사과을 먹었다');
  assert.equal(failed.unavailable, true);
  const malformed = await polishKoreanSegments([cue('사과을 먹었다')], 'ko', { polishLines: async () => ({ lines: [] }) });
  assert.equal(malformed.segments[0].text, '사과을 먹었다');
  const controller = new AbortController(); controller.abort();
  const aborted = await polishKoreanSegments([cue('사과을 먹었다')], 'ko', { signal: controller.signal, polishLines: async () => ['사과를 먹었다'] });
  assert.equal(aborted.segments[0].text, '사과을 먹었다');
});
