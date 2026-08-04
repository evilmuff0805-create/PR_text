import assert from 'node:assert/strict';
import test from 'node:test';
import {
  processTranscriptionSegments,
  removeCommas,
} from '../src/services/transcription-processing.js';
import { removeCaptionPeriods } from '../src/services/caption-text.js';

const periodPattern = /[.。．｡]/;

test('removes every supported period form and keeps other sentence marks', () => {
  assert.equal(
    removeCaptionPeriods('좋아요. 맞아요。 정말요． 네｡ 그렇죠! 왜요?'),
    '좋아요 맞아요 정말요 네 그렇죠! 왜요?',
  );
  assert.equal(removeCommas('하나, 둘， 셋'), '하나 둘 셋');
});

test('removes periods and commas after successful Korean correction', async () => {
  const segments = [
    { start: 0, end: 1, text: '안녕 하세요.' },
    { start: 1, end: 2, text: '반갑습니다。' },
  ];
  const result = await processTranscriptionSegments(segments, 'korean', async () => (
    '안녕하세요, 반가워요.\n반갑습니다．'
  ));

  assert.deepEqual(result.segments.map(segment => segment.text), [
    '안녕하세요 반가워요',
    '반갑습니다',
  ]);
  assert.equal(result.segments.some(segment => periodPattern.test(segment.text)), false);
});

test('removes periods when correction falls back to the original segments', async () => {
  const segments = [{ start: 0, end: 1, text: '교정에 실패해도. 마침표는， 없어야 합니다。' }];
  const result = await processTranscriptionSegments(segments, 'korean', async () => {
    throw new Error('simulated provider failure');
  });

  assert.equal(result.segments[0].text, '교정에 실패해도 마침표는 없어야 합니다');
});

test('removes periods from non-Korean segments without invoking correction', async () => {
  const segments = [{ start: 0, end: 1, text: 'Hello. Nice to meet you。' }];
  const result = await processTranscriptionSegments(segments, 'english', async () => {
    throw new Error('correction must not run');
  });

  assert.equal(result.segments[0].text, 'Hello Nice to meet you');
  assert.equal(result.correctionTimings.eligible, false);
});
