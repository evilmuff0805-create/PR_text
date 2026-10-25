import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeChunkSegments } from '../src/services/audio-chunks.js';
import { generateSRT } from '../src/services/subtitle.js';

// Independent, anonymous fixtures: overlap context must not erase genuine repeats.
function textStream(segments) {
  return segments.map(({ text }) => text).join('').replace(/\s+/gu, '');
}

function response(segments, words) {
  return { segments, words };
}

test('chunk ownership removes a long repeated context prefix without losing actual repeated words', () => {
  const chunks = [
    {
      chunk: { ownedStart: 0, ownedEnd: 180, inputStart: 0 },
      response: response([
        { start: 175, end: 177, text: '함께 준비해 주세요' },
        { start: 177.1, end: 179.8, text: '다시 다시' },
      ], [
        { word: '함께', start: 175, end: 175.4 },
        { word: '준비해', start: 175.4, end: 176.1 },
        { word: '주세요', start: 176.1, end: 177 },
        { word: '다시', start: 177.1, end: 178 },
        { word: '다시', start: 178.1, end: 179.8 },
      ]),
    },
    {
      chunk: { ownedStart: 180, ownedEnd: 360, inputStart: 175 },
      response: response([
        { start: 0, end: 10.9, text: '함께 준비해 주세요 다시 다시 기록을 남겨요' },
      ], [
        { word: '함께', start: 0, end: 0.4 },
        { word: '준비해', start: 0.4, end: 1.1 },
        { word: '주세요', start: 1.1, end: 2 },
        { word: '다시', start: 2.1, end: 3 },
        { word: '다시', start: 3.1, end: 4.8 },
        { word: '기록을', start: 5.2, end: 6 },
        { word: '남겨요', start: 6.2, end: 10.9 },
      ]),
    },
  ];
  const before = structuredClone(chunks);
  const merged = mergeChunkSegments(chunks);
  assert.equal(textStream(merged), '함께준비해주세요다시다시기록을남겨요');
  assert.equal(merged.flatMap(({ sourceWords }) => sourceWords ?? [])
    .filter(({ word }) => word === '다시').length, 2);
  assert.deepEqual(chunks, before);
  const exported = generateSRT(merged, null, { holdShortGaps: false });
  assert.equal((exported.match(/함께/g) ?? []).length, 1);
  assert.equal((exported.match(/다시/g) ?? []).length, 2);
});

test('a word straddling ownership boundary is retained once with its original start and end', () => {
  const chunks = [
    {
      chunk: { ownedStart: 0, ownedEnd: 10, inputStart: 0 },
      response: response([{ start: 9.8, end: 10.2, text: '계속' }], [
        { word: '계속', start: 9.8, end: 10.2 },
      ]),
    },
    {
      chunk: { ownedStart: 10, ownedEnd: 20, inputStart: 5 },
      response: response([{ start: 4.8, end: 5.8, text: '계속 갑니다' }], [
        { word: '계속', start: 4.8, end: 5.2 },
        { word: '갑니다', start: 5.4, end: 5.8 },
      ]),
    },
  ];
  const merged = mergeChunkSegments(chunks);
  assert.equal(textStream(merged), '계속갑니다');
  const words = merged.flatMap(({ sourceWords }) => sourceWords ?? [])
    .filter(({ word }) => word === '계속');
  assert.equal(words.length, 1);
  assert.equal(words[0].start, 9.8);
  assert.equal(words[0].end, 10.2);
});

test('the same phrase actually spoken on both sides of a boundary keeps every repeat', () => {
  const chunks = [
    {
      chunk: { ownedStart: 0, ownedEnd: 10, inputStart: 0 },
      response: response([{ start: 8, end: 9.4, text: '다시 다시' }], [
        { word: '다시', start: 8, end: 8.5 },
        { word: '다시', start: 8.8, end: 9.4 },
      ]),
    },
    {
      chunk: { ownedStart: 10, ownedEnd: 20, inputStart: 5 },
      response: response([{ start: 3, end: 6.4, text: '다시 다시 다시 다시' }], [
        { word: '다시', start: 3, end: 3.5 },
        { word: '다시', start: 3.8, end: 4.4 },
        { word: '다시', start: 5.2, end: 5.7 },
        { word: '다시', start: 5.9, end: 6.4 },
      ]),
    },
  ];
  const merged = mergeChunkSegments(chunks);
  assert.equal(textStream(merged), '다시다시다시다시');
  const starts = merged.flatMap(({ sourceWords }) => sourceWords ?? [])
    .filter(({ word }) => word === '다시').map(({ start }) => start);
  assert.deepEqual(starts, [8, 8.8, 10.2, 10.9]);
});

test('conflicting cross-chunk word estimates preserve speech and explicitly require review', () => {
  const chunks = [
    {
      chunk: { index: 0, ownedStart: 0, ownedEnd: 10, inputStart: 0 },
      response: response([{ start: 9.4, end: 9.99, text: '확인' }], [
        { word: '확인', start: 9.4, end: 9.99 },
      ]),
    },
    {
      chunk: { index: 1, ownedStart: 10, ownedEnd: 20, inputStart: 5 },
      response: response([{ start: 4.42, end: 6, text: '확인 다음' }], [
        { word: '확인', start: 4.42, end: 5.01 },
        { word: '다음', start: 5.2, end: 6 },
      ]),
    },
  ];
  const before = structuredClone(chunks);
  const merged = mergeChunkSegments(chunks);
  // Independent estimates cross the ownership cut in opposite directions.
  // They are ambiguous; text-only deduplication would also erase real repeats.
  assert.equal(textStream(merged), '확인확인다음');
  assert(merged.some(({ subtitleReview }) => subtitleReview?.issues?.some(({ code, reason }) => (
    code === 'chunk_boundary_unverified' && reason === 'conflicting_word_estimates'
  ))));
  assert.deepEqual(chunks, before);
});
