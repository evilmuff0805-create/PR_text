import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeShortSegments, MIN_SEGMENT_CHARS } from '../src/services/transcription-processing.js';

test('short segments are folded into the following one', () => {
  const merged = mergeShortSegments([
    { start: 0, end: 0.4, text: '네' },
    { start: 0.4, end: 3, text: '그렇게 진행하겠습니다' },
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { start: 0, end: 3, text: '네 그렇게 진행하겠습니다' });
});

test('merging keeps the earliest start and the latest end', () => {
  const merged = mergeShortSegments([
    { start: 1.5, end: 1.9, text: '응' },
    { start: 1.9, end: 4.25, text: '맞아요 저도 그렇게 봤어요' },
  ]);

  assert.equal(merged[0].start, 1.5);
  assert.equal(merged[0].end, 4.25);
});

test('segments from different speakers are never merged together', () => {
  const merged = mergeShortSegments([
    { start: 0, end: 0.4, text: '네', speaker: 0 },
    { start: 0.4, end: 3, text: '그건 아니죠', speaker: 1 },
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].speaker, 0);
  assert.equal(merged[1].speaker, 1);
});

test('a trailing short segment survives because there is nothing to merge into', () => {
  const merged = mergeShortSegments([
    { start: 0, end: 3, text: '오늘은 여기까지 하겠습니다' },
    { start: 3, end: 3.4, text: '네' },
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged.at(-1).text, '네');
});

test('long enough segments pass through untouched', () => {
  const input = [
    { start: 0, end: 2, text: '가'.repeat(MIN_SEGMENT_CHARS) },
    { start: 2, end: 4, text: '충분히 긴 문장입니다' },
  ];

  assert.deepEqual(mergeShortSegments(input), input);
});
