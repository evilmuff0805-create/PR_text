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

test('correction prompt permits clear dictation and spelling errors while retaining each line', () => {
  const request = buildCorrectionRequest('테스트 자막', 'gpt-5.6-luna');
  const systemPrompt = request.messages[0].content;

  assert.match(systemPrompt, /발음이 사실상 같고 문맥상 명백한 받아쓰기 오류만/);
  assert.match(systemPrompt, /함께 입력된 앞뒤 줄을 문맥으로 읽으세요/);
  assert.match(systemPrompt, /다른 줄의 단어나 대사를 옮기거나 복사하지 마세요/);
  assert.match(systemPrompt, /동일한 줄 수와 순서를 유지/);
  assert.match(systemPrompt, /문맥이 애매하면 원문을 그대로 두세요/);
  assert.match(systemPrompt, /발음이 다른 단어를 추측해 넣지 마세요/);
  assert.match(systemPrompt, /나물을 묻혀서 반찬을 만들었어 → 나물을 무쳐서 반찬을 만들었어/);
  assert.match(systemPrompt, /옷에 양념을 묻혔어 → 옷에 양념을 묻혔어/);
  assert.match(systemPrompt, /상자가 땅에 묻혔어 → 상자가 땅에 묻혔어/);
  assert.match(systemPrompt, /이유를 물었어 → 이유를 물었어/);
  assert.match(systemPrompt, /잘 묻혀서 해봐 → 잘 묻혀서 해봐/);
  assert.match(systemPrompt, /거에요 → 내일 할 거예요/);
  assert.match(systemPrompt, /되요 → 이렇게 하면 돼요/);
  assert.match(systemPrompt, /반복 횟수를 보존/);
  assert.match(systemPrompt, /숫자, 소수점, 부호, 수량과 단위를 보존/);
  assert.match(systemPrompt, /사람 이름, 지명, 상호와 고유명사는 추측해 바꾸지 마세요/);
});

test('only Luna client errors use the gpt-4o fallback', () => {
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-5.6-luna'), true);
  assert.equal(shouldFallbackToGpt4o({ status: 500 }, 'gpt-5.6-luna'), false);
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-4o'), false);
});
