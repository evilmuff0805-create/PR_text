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

test('correction prompt keeps word preservation with a homophone-only exception', () => {
  const request = buildCorrectionRequest('테스트 자막', 'gpt-5.6-luna');
  const systemPrompt = request.messages[0].content;

  assert.match(systemPrompt, /단어를 다른 단어로 바꾸지 마세요/);
  assert.match(systemPrompt, /발음이 사실상 동일한 다른 단어로 잘못 받아 적었고 문맥상 오인식이 명백한 경우에만/);
  assert.match(systemPrompt, /문맥이 조금이라도 애매한 경우의 교체는 금지합니다/);
});

test('only Luna client errors use the gpt-4o fallback', () => {
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-5.6-luna'), true);
  assert.equal(shouldFallbackToGpt4o({ status: 500 }, 'gpt-5.6-luna'), false);
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-4o'), false);
});
