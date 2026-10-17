import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';

const { buildCorrectionRequest, shouldFallbackToGpt4o } = await import('../src/services/gpt.js');

test('Luna correction request uses model-default sampling', () => {
  const request = buildCorrectionRequest('테스트 자막', 'gpt-5.6-luna');

  assert.equal(request.model, 'gpt-5.6-luna');
  assert.equal('temperature' in request, false);
  assert.equal(request.messages[1].content, '테스트 자막');
  assert.deepEqual(Object.keys(request).sort(), ['messages', 'model']);
  assert.equal(request.messages.length, 2);
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
  assert.match(systemPrompt, /각 줄의 대상·행위·서술어를 앞뒤 문맥에서 확인하세요/);
  assert.match(systemPrompt, /대상과 행위가 뜻을 명확히 결정하면 그 뜻에 맞는 표기를 해당 줄에서 고치세요/);
  assert.match(systemPrompt, /사전상 다른 뜻이 있다는 이유만으로 입력 문맥에서 명백한 교정을 생략하지 마세요/);
  assert.match(systemPrompt, /실제 입력 문맥에 뜻을 가를 단서가 부족하거나 서로 다른 해석이 함께 뒷받침될 때는 원문을 유지하세요/);
  assert.match(systemPrompt, /원문을 유지하세요\.\n- 한 줄만으로/);
  assert.doesNotMatch(systemPrompt, /다른 뜻도 가능한 경우에는 원문을 유지하세요/);
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
  assert.match(systemPrompt, /반복된 독립 어절을 뒤 단어의 일부로 흡수하거나 생략하지 마세요/);
  assert.match(systemPrompt, /반복 옆 단어의 철자를 고쳐도 독립 반복은 각각 남겨야 합니다/);
  assert.match(systemPrompt, /문맥상 명백한 교정을 놓치지 않았는지 확인하세요/);
  assert.match(systemPrompt, /숫자, 소수점, 부호, 수량과 단위를 보존/);
  assert.match(systemPrompt, /사람 이름, 지명, 상호와 고유명사는 추측해 바꾸지 마세요/);
});

test('only Luna client errors use the gpt-4o fallback', () => {
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-5.6-luna'), true);
  assert.equal(shouldFallbackToGpt4o({ status: 500 }, 'gpt-5.6-luna'), false);
  assert.equal(shouldFallbackToGpt4o({ status: 400 }, 'gpt-4o'), false);
});

test('context examples preserve each line and distinguish explicit mailing from attachment', () => {
  const input = '첫 줄은 문맥입니다.\n둘째 줄도 제자리에 남습니다.';
  const request = buildCorrectionRequest(input, 'gpt-5.6-luna');
  const systemPrompt = request.messages[0].content;
  const examples = [...systemPrompt.matchAll(/입력:\n([^\n]+\n[^\n]+)\n출력:\n([^\n]+\n[^\n]+)/g)];
  assert.equal(examples.length, 2);
  for (const [, source, candidate] of examples) {
    assert.equal(source.split('\n').length, 2);
    assert.equal(candidate.split('\n').length, 2);
    assert.equal(source.split('\n')[0], candidate.split('\n')[0]);
  }
  assert.equal(examples[0][2].split('\n')[1], '오후에 그렇게 부쳤어.');
  assert.equal(examples[1][2], examples[1][1]);
  assert.match(systemPrompt, /예시의 행위가 실제 입력에 명시되지 않으면 같은 뜻을 추정해 적용하지 마세요/);
  assert.match(systemPrompt, /문맥이 애매하면 원문을 그대로 두세요/);
  assert.equal(request.messages[1].content, input);
});
