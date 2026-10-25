import assert from 'node:assert/strict';
import test from 'node:test';
import { completeProviderWordSpans } from '../src/services/provider-word-spans.js';
import { buildTranscriptionReviewWindows, buildTranscriptionVocabularyPrompt,
  recheckCompressedTranscriptionSegments } from '../src/services/transcription-review.js';

test('compressed rechecks exclude genuine brief replies and stay within three bounded windows', () => {
  const source = [{ start: 0, end: .1, text: '네' }, ...Array.from({ length: 10 }, (_, index) => ({
    start: 10 + index * 30, end: 10.1 + index * 30, text: '잘 지내셨어요',
  }))];
  const windows = buildTranscriptionReviewWindows(source, { durationSeconds: 400 });
  assert.equal(windows.length, 3);
  assert.deepEqual(windows.flatMap((window) => window.indices), [1, 2, 3]);
  assert.ok(windows.every((window) => window.end - window.start <= 20));
  assert.ok(windows.reduce((sum, window) => sum + window.end - window.start, 0) <= 60);
  assert.deepEqual(buildTranscriptionReviewWindows(source.map((segment) => ({ ...segment, speaker: 0 }))), []);
});

const compressedSource = () => [
  { start: 8, end: 9, text: '그럼요' },
  { start: 10, end: 10.1, text: '잘 지내셨어요' },
  { start: 12, end: 13, text: '네 맞아요' },
];

test('exact unique remeasurement restores only the measured words without modifying dialogue or neighbours', async () => {
  const source = compressedSource();
  const frozen = structuredClone(source);
  let calls = 0;
  const reviewed = await recheckCompressedTranscriptionSegments(source, { durationSeconds: 20,
    transcribeRange: async () => { calls += 1; return { words: [
      { word: '잘', start: 3.1, end: 3.4 }, { word: '지내셨어요', start: 3.4, end: 4.1 },
    ] }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(source, frozen);
  assert.equal(reviewed.segments[1].text, source[1].text);
  assert.equal(reviewed.segments[1].start, 10.1);
  assert.equal(reviewed.segments[1].end, 11.1);
  assert.equal(reviewed.segments[1].subtitleReview.timingStatus, 'unverified');
  assert.equal(reviewed.segments[1].subtitleReview.textStatus, undefined);
  assert.deepEqual(reviewed.segments[0], source[0]);
  assert.deepEqual(reviewed.segments[2], source[2]);
});

test('disagreement, duplicate phrases, invalid words and neighbour overlap keep original timing for review', async () => {
  const responseWords = [
    [{ word: '잘 지내셨어요', start: 1, end: 2 }], // Would intrude into the previous cue.
    [{ word: '잘 지내셨어요', start: 4, end: 6 }], // Would intrude into the next cue.
    [{ word: '잘 지내셨어요', start: 3, end: 4 }, { word: '잘 지내셨어요', start: 4, end: 5 }],
    [{ word: '새로운 대사입니다', start: 3, end: 4 }],
    [{ word: '잘 지내셨어요', start: null, end: 4 }],
    [{ word: '잘', start: 3.5, end: 4 }, { word: '지내셨어요', start: 3, end: 3.4 }],
  ];
  for (const words of responseWords) {
    const source = compressedSource();
    const { segments } = await recheckCompressedTranscriptionSegments(source, {
      durationSeconds: 20, transcribeRange: async () => ({ words }),
    });
    assert.equal(segments[1].start, source[1].start);
    assert.equal(segments[1].end, source[1].end);
    assert.equal(segments[1].text, source[1].text);
    assert.ok(segments[1].subtitleReview.issues.some((issue) => issue.code === 'audio_recheck_inconclusive'));
  }
});

test('failed rechecks remain reviewable and cancellation does not silently finish a conversion', async () => {
  const { segments, measurements } = await recheckCompressedTranscriptionSegments(compressedSource(), {
    durationSeconds: 20, transcribeRange: async () => { throw new Error('synthetic provider failure'); },
  });
  assert.equal(segments[1].text, '잘 지내셨어요');
  assert.equal(segments[1].end, 10.1);
  assert.equal(measurements[0].outcome, 'failed');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recheckCompressedTranscriptionSegments(compressedSource(), {
    signal: controller.signal, transcribeRange: async () => { throw new Error('must not reach provider'); },
  }), { name: 'AbortError' });
});

test('complete provider spans preserve repeated words and Unicode while rejecting ambiguous or partial matches', () => {
  const text = '다시 다시 확인해요';
  const segment = { start: 1, end: 3, text };
  const words = [
    { word: '다시', start: 1, end: 1.5 }, { word: '다시', start: 1.5, end: 2 },
    { word: '확인해요', start: 2, end: 3 },
  ];
  const complete = completeProviderWordSpans(segment, words);
  assert.deepEqual(complete.words, words);
  assert.equal(text.slice(complete.cuts[1], complete.cuts[3]).trim(), '다시 확인해요');
  assert.equal(completeProviderWordSpans(segment, words.slice(1)), null);
  assert.equal(completeProviderWordSpans({ start: 1, end: 2, text: '다시' }, words), null);
  const nfd = '자료 확인'.normalize('NFD');
  assert.ok(completeProviderWordSpans({ start: 0, end: 2, text: nfd }, [
    { word: '자료', start: 0, end: 1 }, { word: '확인', start: 1, end: 2 },
  ]));
});

test('optional vocabulary stays below Whisper token budget and leaves default requests untouched', () => {
  assert.equal(buildTranscriptionVocabularyPrompt(undefined), undefined);
  assert.equal(buildTranscriptionVocabularyPrompt('not-an-array'), undefined);
  const prompt = buildTranscriptionVocabularyPrompt(Array.from({ length: 10 }, () => '관련음식이름관련음식이름'));
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 192);
  assert.equal(buildTranscriptionVocabularyPrompt(['자료\n확인', null, '한'.repeat(17)]), '자료 확인');
});

test('explicit audio review offers a changed wording only as a separate candidate, with original times intact', async () => {
  const source = [{ start: 10, end: 12, text: '여기는 바람이 잔잔해' }];
  const result = await recheckCompressedTranscriptionSegments(source, {
    durationSeconds: 20, reviewWindows: [{ start: 8, end: 15, indices: [0] }],
    transcribeRange: async () => ({ words: [
      { word: '저기는', start: 2.1, end: 2.6 }, { word: '바람이', start: 2.6, end: 3.2 },
      { word: '잔잔해', start: 3.2, end: 3.8 },
    ] }),
  });
  assert.equal(result.segments[0].text, source[0].text);
  assert.equal(result.segments[0].subtitleReview.candidateText, '저기는 바람이 잔잔해');
  assert.equal(result.segments[0].subtitleReview.textStatus, 'candidate');
  assert.equal(result.segments[0].subtitleReview.timingStatus, 'unverified');
  assert.equal(result.segments[0].start, 10);
  assert.equal(result.segments[0].end, 12);
});

test('audio-review alternatives cannot silently remove real repeats or change numeric expressions', async () => {
  for (const [text, word] of [['좋아요 좋아요 준비해요', '좋아요 준비해요'], ['3.5 킬로만 준비해요', '35 킬로만 준비해요']]) {
    const { segments } = await recheckCompressedTranscriptionSegments([{ start: 10, end: 12, text }], {
      durationSeconds: 20, reviewWindows: [{ start: 8, end: 15, indices: [0] }],
      transcribeRange: async () => ({ words: [{ word, start: 2.1, end: 3.8 }] }),
    });
    assert.equal(segments[0].text, text);
    assert.equal(segments[0].subtitleReview.candidateText, undefined);
  }
});
