import assert from 'node:assert/strict';
import test from 'node:test';
import { annotateSubtitleReviews, mergeSubtitleReviews } from '../src/services/subtitle-review.js';
import { buildSubtitleCues, generateSRT } from '../src/services/subtitle.js';
import { alignKoreanSegmentWithWordTimings } from '../src/services/korean-word-timing.js';
import { koreanSubtitleBoundaryCost, splitKoreanSubtitleText } from '../src/services/korean-subtitle.js';

test('review signals preserve genuine brief responses and compressed long text without padding', () => {
  const input = [
    { start: 1, end: 1.06, text: '네' },
    { start: 3, end: 3.14, text: '현재 안내를 차근차근 확인하고 다시 설명하겠습니다' },
  ];
  const before = structuredClone(input);
  const result = annotateSubtitleReviews(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.map(({ subtitleReview: ignored, ...cue }) => cue), before);
  assert.equal(result[0].subtitleReview.issues[0].shortResponse, true);
  assert.equal(result[0].subtitleReview.issues.some(issue => issue.code === 'high_reading_speed'), false);
  assert.deepEqual(result[1].subtitleReview.issues.map(issue => issue.code), ['short_cue', 'high_reading_speed']);
  assert.equal(result[1].subtitleReview.timingStatus, 'unverified');
  assert.equal(result[1].subtitleReview.textStatus, undefined);
});

test('review duration and reading-density thresholds are diagnostic boundaries only', () => {
  const result = annotateSubtitleReviews([
    { start: 0, end: .3, text: '안내문' },
    { start: 1, end: 1.5, text: '가'.repeat(10) },
    { start: 2, end: 2.5, text: '가'.repeat(11) },
    { start: 3, end: 3.299, text: '응' },
  ]);
  assert.equal(result[0].subtitleReview, undefined);
  assert.equal(result[1].subtitleReview, undefined);
  assert.deepEqual(result[2].subtitleReview.issues.map(issue => issue.code), ['high_reading_speed']);
  assert.deepEqual(result[3].subtitleReview.issues.map(issue => issue.code), ['short_cue']);
});

test('review analysis leaves English, speaker zero and mixed diarization outside ordinary policy', () => {
  const english = [{ start: 0, end: .02, text: 'hello there' }];
  const labelled = [{ start: 0, end: .02, text: '안내합니다', speaker: 0 }];
  const mixed = [...labelled, { start: .02, end: .04, text: '네' }];
  for (const input of [english, labelled, mixed]) assert.deepEqual(annotateSubtitleReviews(input), input);
  assert.deepEqual(annotateSubtitleReviews([{ start: 0, end: 0, text: '안내' }]), [{ start: 0, end: 0, text: '안내' }]);
});

test('oversized overlap trimming is visible before any ordinary display hold', () => {
  const input = [
    { start: 10, end: 12, text: '앞에서 설명한 안내입니다' },
    { start: 10.06, end: 14, text: '다음 안내를 확인합니다' },
  ];
  const before = structuredClone(input);
  const reviewed = annotateSubtitleReviews(input);
  assert.equal(reviewed[0].end, 12);
  const planned = buildSubtitleCues(input);
  assert.equal(planned[0].start, 10);
  assert.equal(planned[0].end, 10.06);
  const overlap = planned[0].subtitleReview.issues.find(issue => issue.code === 'overlap_trim');
  assert.equal(overlap.originalEnd, 12);
  assert.equal(overlap.clippedEnd, 10.06);
  assert.ok(planned[0].subtitleReview.issues.some(issue => issue.code === 'short_cue'));
  assert.deepEqual(input, before);
});

test('hold remains presentation-only and explicit opt-out leaves speech ends intact', () => {
  const input = [{ start: 2, end: 2.06, text: '네' }, { start: 2.8, end: 4, text: '다음 안내입니다' }];
  const held = buildSubtitleCues(input);
  const speech = buildSubtitleCues(input, { holdShortGaps: false });
  assert.equal(held[0].end, 2.8);
  assert.equal(speech[0].end, 2.06);
  assert.ok(held[0].subtitleReview.issues.some(issue => issue.code === 'short_cue' && issue.durationSeconds < .061));
  assert.equal(held[1].start, 2.8);
});

test('metadata is bounded data and never inserts a candidate into subtitle text', () => {
  const review = mergeSubtitleReviews({
    version: 1,
    issues: Array.from({ length: 30 }, (_, sourceIndex) => ({
      code: 'word_timing_fallback', sourceIndex, reason: 'missing-words',
      charactersPerSecond: NaN, ignored: 'not retained',
    })),
    originalText: '원문입니다', candidateText: '다른 후보입니다', textStatus: 'candidate', timingStatus: 'unverified',
    arbitrary: 'not retained',
  });
  assert.equal(review.issues.length, 16);
  assert.ok(review.issues.every(issue => !Object.hasOwn(issue, 'ignored') && !Object.hasOwn(issue, 'charactersPerSecond')));
  assert.equal(review.arbitrary, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(review)), review);
  const srt = generateSRT([{ start: 2, end: 4, text: review.originalText, subtitleReview: review }]);
  assert.ok(srt.includes(review.originalText));
  assert.equal(srt.includes(review.candidateText), false);
  assert.equal(mergeSubtitleReviews({ version: 2, issues: [{ code: 'short_cue' }] }), undefined);
  assert.equal(mergeSubtitleReviews({ version: 1, issues: [{ code: ['short_cue'] }] }), undefined);
  const strict = mergeSubtitleReviews({ version: 1, issues: [{ code: 'word_timing_fallback', sourceIndex: .5, wordCount: '3' }] });
  assert.deepEqual(strict.issues, [{ code: 'word_timing_fallback' }]);
  const crowded = mergeSubtitleReviews({ version: 1, issues: [
    { code: 'correction_guard_rejected', reason: 'repetition_change' },
    ...Array.from({ length: 30 }, (_, cueStart) => ({ code: 'short_cue', cueStart })),
  ] });
  assert.equal(crowded.issues.length, 16);
  assert.equal(crowded.issues[0].code, 'correction_guard_rejected');
});

test('locative adnominal phrases use a shared boundary cost without a customer word exception', () => {
  const text = '오늘은 처음 가본 해안에서 자라는 식물을 조심스럽게 살펴봤습니다';
  assert.ok(koreanSubtitleBoundaryCost('해안에서', '자라는 식물을') > 0);
  const parts = splitKoreanSubtitleText(text);
  assert.equal(parts.join(' '), text);
  assert.ok(parts.every(part => part.length <= 28));
  assert.ok(parts.some(part => part.includes('해안에서 자라는 식물을')));
});

test('safe timed-edge replanning retains dependency preferences when the ideal cut lies inside a token', () => {
  const text = '오늘은 처음 가본 해안에서 자라는 식물을 조심스럽게 살펴봤습니다';
  const tokens = ['오늘은', '처음', '가본', '해안에서', '자라는', '식물을 조심스럽게', '살펴봤습니다'];
  const source = { start: 0, end: 7, text,
    sourceWords: tokens.map((word, index) => ({ word, start: index, end: index + .8 })) };
  const result = alignKoreanSegmentWithWordTimings(source);
  assert.equal(result.aligned, true);
  assert.equal(result.segments.map(cue => cue.text).join(' '), text);
  assert.ok(result.segments.every(cue => cue.text.length <= 28));
  assert.equal(result.segments.some(cue => /해안에서$/u.test(cue.text)), false);
  assert.equal(result.segments.some(cue => /자라는$/u.test(cue.text)), false);
  for (const cue of result.segments) {
    assert.ok(source.sourceWords.some(word => word.start === cue.start));
    assert.ok(source.sourceWords.some(word => word.end === cue.end));
  }
});

test('question dependency is retained at real word edges without crossing a pause', () => {
  const text = '처음 안내를 확인하며 누가 만든 건지 차근차근 살펴보겠습니다';
  const tokens = ['처음', '안내를', '확인하며 누가', '만든', '건지', '차근차근', '살펴보겠습니다'];
  const source = { start: 0, end: 7, text,
    sourceWords: tokens.map((word, index) => ({ word, start: index, end: index + .8 })) };
  const result = alignKoreanSegmentWithWordTimings(source);
  assert.equal(result.aligned, true);
  assert.equal(result.segments.map(cue => cue.text).join(' '), text);
  assert.equal(result.segments.some(cue => /누가$/u.test(cue.text)), false);
  const paused = structuredClone(source);
  paused.sourceWords[3].start += .11;
  const separated = alignKoreanSegmentWithWordTimings(paused);
  assert.equal(separated.aligned, true);
  assert.ok(separated.segments.some(cue => /누가$/u.test(cue.text)));
});
