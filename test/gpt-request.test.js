import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';

const { buildCorrectionRequest, shouldFallbackToGpt4o } = await import('../src/services/gpt.js');

test('Luna correction request uses model-default sampling', () => {
  const request = buildCorrectionRequest('테스트 자막', 'gpt-5.6-luna');

  assert.equal(request.model, 'gpt-5.6-luna');
  assert.equal('temperature' in request, false);
  assert.equal(request.messages[1].content, '테스트 자막');
});

test('gpt-4o correction request preserves the existing temperature', () => {
  const request = buildCorrectionRequest('테스트 자막', 'gpt-4o');

  assert.equal(request.temperature, 0.3);
});

test('only Luna client errors use the gpt-4o fallback', () => {
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-5.6-luna'), true);
  assert.equal(shouldFallbackToGpt4o({ status: 500 }, 'gpt-5.6-luna'), false);
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-4o'), false);
});
