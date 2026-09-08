import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key-not-real';
const { attachSourceWords, requestsWordTimings } = await import('../src/services/whisper.js');

test('word timestamps are requested for English and automatic transcription only', () => {
  assert.equal(requestsWordTimings('en'), true);
  assert.equal(requestsWordTimings('english'), true);
  assert.equal(requestsWordTimings(null), true);
  assert.equal(requestsWordTimings(''), true);
  assert.equal(requestsWordTimings('ko'), false);
});
test('malformed provider word collections become an empty per-segment fallback', () => {
  const segments = [{ start: 1, end: 2, text: 'Keep original text.' }];
  for (const words of [null, { word: 'not-an-array' }, [null]]) {
    assert.deepEqual(attachSourceWords(segments, words), [{
      start: 1, end: 2, text: 'Keep original text.', sourceWords: [],
    }]);
  }
});