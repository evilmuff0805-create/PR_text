import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeChunkSegments } from '../src/services/audio-chunks.js';
import { processTranscriptionSegments } from '../src/services/transcription-processing.js';
import { generateSRT } from '../src/services/subtitle.js';

test('chunk ownership keeps boundary segments once and offsets their words once', () => {
  const segments = mergeChunkSegments([
    {
      chunk: { ownedStart: 0, ownedEnd: 10, inputStart: 0 },
      response: {
        segments: [
          { start: 8, end: 10, text: 'first boundary' },
          { start: 8, end: 12, text: 'duplicate overlap' },
        ],
        words: [
          { word: 'first', start: 8, end: 9 },
          { word: 'boundary', start: 9, end: 10 },
        ],
      },
    },
    {
      chunk: { ownedStart: 10, ownedEnd: 20, inputStart: 5 },
      response: {
        segments: [{ start: 5, end: 7, text: 'second boundary' }],
        words: [
          { word: 'second', start: 5, end: 6 },
          { word: 'boundary', start: 6, end: 7 },
        ],
      },
    },
  ]);

  assert.deepEqual(segments.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 8, end: 10, text: 'first boundary' },
    { start: 10, end: 12, text: 'second boundary' },
  ]);
  assert.deepEqual(segments[1].sourceWords, [
    { word: 'second', start: 10, end: 11 },
    { word: 'boundary', start: 11, end: 12 },
  ]);
});
test('a retained chunk segment carries its offset words through English SRT timing', async () => {
  const [segment] = mergeChunkSegments([{
    chunk: { ownedStart: 180, ownedEnd: 190, inputStart: 175 },
    response: {
      segments: [{ start: 5, end: 7, text: 'Hello there' }],
      words: [
        { word: 'Hello', start: 5.2, end: 5.5 },
        { word: 'there', start: 6.4, end: 6.7 },
      ],
    },
  }]);
  const result = await processTranscriptionSegments([segment], 'en');

  assert.deepEqual(result.segments, [
    { start: 180.2, end: 180.5, text: 'Hello' },
    { start: 181.4, end: 181.7, text: 'there' },
  ]);
  assert.match(generateSRT(result.segments), /00:03:00,200 --> 00:03:00,500/);
  assert.match(generateSRT(result.segments), /00:03:01,400 --> 00:03:01,700/);
});
test('malformed chunk words leave the retained source segment available for fallback', () => {
  for (const words of [null, { word: 'not-an-array' }, [null]]) {
    const [segment] = mergeChunkSegments([{
      chunk: { ownedStart: 0, ownedEnd: 10, inputStart: 0 },
      response: { segments: [{ start: 1, end: 2, text: 'Keep original text.' }], words },
    }]);
    assert.deepEqual(segment.sourceWords, []);
    assert.equal(segment.text, 'Keep original text.');
  }
});