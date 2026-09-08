import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeShortSegments, MIN_SEGMENT_CHARS, processTranscriptionSegments } from '../src/services/transcription-processing.js';
import { generateASS, generateSRT } from '../src/services/subtitle.js';

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

test('short segments never merge across a silent gap', () => {
  const merged = mergeShortSegments([
    { start: 0, end: 0.3, text: 'Yes' },
    { start: 8, end: 10, text: 'We can begin now' },
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 0.3, text: 'Yes' },
    { start: 8, end: 10, text: 'We can begin now' },
  ]);
});

test('short adjacent segments merge through a 0.3 second pause', () => {
  const merged = mergeShortSegments([
    { start: 0, end: 1, text: '네' },
    { start: 1.3, end: 2, text: '맞습니다' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, '네 맞습니다');
});

test('English word timings preserve punctuation, pauses, and source boundaries', async () => {
  const result = await processTranscriptionSegments([{
    start: 0, end: 3, text: 'Hello, there.', sourceWords: [
      { word: 'Hello', start: 0, end: 0.5 },
      { word: 'there', start: 2, end: 2.5 },
    ],
  }], 'english');
  assert.deepEqual(result.segments, [
    { start: 0, end: 0.5, text: 'Hello,' },
    { start: 2, end: 2.5, text: 'there.' },
  ]);
});

test('unreliable English word timings retain the original segment without text loss', async () => {
  const result = await processTranscriptionSegments([{
    start: 4, end: 6, text: 'Keep this sentence.', sourceWords: [{ word: 'Keep', start: 4, end: 4.2 }],
  }], 'en');
  assert.deepEqual(result.segments, [{ start: 4, end: 6, text: 'Keep this sentence.' }]);
});
test('merge pause threshold stays stable near 0.3 seconds at large offsets', () => {
  const left = { start: 180, end: 181, text: '짧아' };
  for (const [gap, expectedCount] of [[0.299, 1], [0.3, 1], [0.301, 2]]) {
    const merged = mergeShortSegments([left, {
      start: 181 + gap,
      end: 182 + gap,
      text: '이어지는 말',
    }]);
    assert.equal(merged.length, expectedCount, `${gap}초 간격`);
  }
});

test('English long lines use unequal word timings in both subtitle exports', async () => {
  const result = await processTranscriptionSegments([{
    start: 180,
    end: 186,
    text: 'alpha bravo charlie delta echo foxtrot golf',
    sourceWords: [
      { word: 'alpha', start: 180, end: 180.2 },
      { word: 'bravo', start: 180.3, end: 181.1 },
      { word: 'charlie', start: 181.2, end: 181.3 },
      { word: 'delta', start: 182, end: 182.8 },
      { word: 'echo', start: 183, end: 183.1 },
      { word: 'foxtrot', start: 184, end: 184.7 },
      { word: 'golf', start: 185, end: 185.1 },
    ],
  }], 'en');

  assert.deepEqual(result.segments, [
    { start: 180, end: 181.3, text: 'alpha bravo charlie' },
    { start: 182, end: 183.1, text: 'delta echo' },
    { start: 184, end: 185.1, text: 'foxtrot golf' },
  ]);
  assert.match(generateSRT(result.segments), /00:03:00,000 --> 00:03:01,300/);
  assert.match(generateASS(result.segments), /0:03:00\.00,0:03:01\.30/);
});

test('null, malformed, and overlapping English words retain original segments', async () => {
  const source = [
    { start: 0, end: 2, text: 'Null word.', sourceWords: [null, { word: 'word', start: 1, end: 1.2 }] },
    { start: 3, end: 5, text: 'Bad order.', sourceWords: [
      { word: 'Bad', start: 4, end: 4.4 },
      { word: 'order', start: 4.2, end: 4.6 },
    ] },
  ];
  const result = await processTranscriptionSegments(source, 'english');
  assert.deepEqual(result.segments, [
    { start: 0, end: 2, text: 'Null word.' },
    { start: 3, end: 5, text: 'Bad order.' },
  ]);
});

test('a single long English token falls back so TXT keeps the original token', async () => {
  const token = 'a'.repeat(32);
  const result = await processTranscriptionSegments([{
    start: 10, end: 12, text: token, sourceWords: [{ word: token, start: 10, end: 12 }],
  }], 'en');
  assert.deepEqual(result.segments, [{ start: 10, end: 12, text: token }]);
});
test('English word pause threshold stays stable near 0.3 seconds at large offsets', async () => {
  for (const offset of [175, 180]) {
    for (const [gap, expectedCount] of [[0.299, 1], [0.3, 1], [0.301, 2]]) {
      const result = await processTranscriptionSegments([{
        start: offset,
        end: offset + 3,
        text: 'first second',
        sourceWords: [
          { word: 'first', start: offset, end: offset + 1 },
          { word: 'second', start: offset + 1 + gap, end: offset + 2 + gap },
        ],
      }], 'en');
      assert.equal(result.segments.length, expectedCount, `offset=${offset}, gap=${gap}`);
    }
  }
});