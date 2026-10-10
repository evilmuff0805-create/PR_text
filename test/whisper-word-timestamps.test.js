import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key-not-real';
const { attachSourceWords, requestsWordTimings } = await import('../src/services/whisper.js');

test('word timestamps are requested for Korean, English, and automatic transcription', () => {
  assert.equal(requestsWordTimings('en'), true);
  assert.equal(requestsWordTimings('english'), true);
  assert.equal(requestsWordTimings(null), true);
  assert.equal(requestsWordTimings(''), true);
  assert.equal(requestsWordTimings('ko'), true);
  assert.equal(requestsWordTimings('korean'), true);
  assert.equal(requestsWordTimings('한국어'), true);
  assert.equal(requestsWordTimings('ja'), false);
  assert.equal(requestsWordTimings('zh'), false);
});
test('malformed provider word collections become an empty per-segment fallback', () => {
  const segments = [{ start: 1, end: 2, text: 'Keep original text.' }];
  for (const words of [null, { word: 'not-an-array' }, [null]]) {
    assert.deepEqual(attachSourceWords(segments, words), [{
      start: 1, end: 2, text: 'Keep original text.', sourceWords: [],
    }]);
  }
});

test('single-request word times reject coercible values just like chunk word times', () => {
  const segments = [{ start: 0, end: 2, text: '자료를 확인합니다' }];
  for (const value of [null, '', false, '0.1', NaN, Infinity]) {
    for (const field of ['start', 'end']) {
      const [segment] = attachSourceWords(segments, [
        { word: '자료를', start: 0.1, end: 0.3, [field]: value },
      ]);
      assert.deepEqual(segment.sourceWords, []);
      assert.equal(segment.text, segments[0].text);
    }
  }
});
