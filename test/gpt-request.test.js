import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';

process.env.OPENAI_API_KEY ||= 'test-key';

const { buildCorrectionRequest, shouldFallbackToGpt4o, getCorrectionModel,
  correctTextWithUsage, translateToEnglish, translateToKorean,
  rewriteKoreanSentenceLines, verifyKoreanSentenceLines } = await import('../src/services/gpt.js');

test('both Luna correction requests use explicit medium reasoning without sampling overrides', () => {
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    const request = buildCorrectionRequest('테스트 자막', model);
    assert.equal(request.model, model);
    assert.equal(request.reasoning_effort, 'medium');
    assert.equal('temperature' in request, false);
    assert.equal('top_p' in request, false);
    assert.equal(request.messages[1].content, '테스트 자막');
    assert.deepEqual(Object.keys(request).sort(), ['messages', 'model', 'reasoning_effort']);
    assert.equal(request.messages.length, 2);
  }
  assert.equal(buildCorrectionRequest('', 'gpt-6-luna').messages[0].content,
    buildCorrectionRequest('', 'gpt-5.6-luna').messages[0].content);
});

test('correction defaults to GPT-6 Luna while retaining explicit model configuration', () => {
  const saved = process.env.GPT_CORRECTION_MODEL;
  try {
    delete process.env.GPT_CORRECTION_MODEL;
    assert.equal(getCorrectionModel(), 'gpt-6-luna');
    process.env.GPT_CORRECTION_MODEL = '   ';
    assert.equal(getCorrectionModel(), 'gpt-6-luna');
    process.env.GPT_CORRECTION_MODEL = '  gpt-5.6-luna  ';
    assert.equal(getCorrectionModel(), 'gpt-5.6-luna');
    process.env.GPT_CORRECTION_MODEL = 'custom-model';
    assert.equal(getCorrectionModel(), 'custom-model');
  } finally {
    if (saved === undefined) delete process.env.GPT_CORRECTION_MODEL;
    else process.env.GPT_CORRECTION_MODEL = saved;
  }
});

test('gpt-4o correction request preserves the existing temperature', () => {
  const request = buildCorrectionRequest('테스트 자막', 'gpt-4o');

  assert.equal(request.temperature, 0.3);
  assert.equal('reasoning_effort' in request, false);
  assert.equal(buildCorrectionRequest('테스트 자막', 'custom-model').temperature, 0.3);
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

test('sentence rewrite and independent verifier prompts require grammatical and natural improvement', async t => {
  const prompts = [];
  t.mock.method(OpenAI.prototype, 'post', async (path, { body }) => {
    prompts.push(body.messages[0].content);
    return sdkResponse(prompts.length === 1
      ? JSON.stringify({ groups: [{ lines: ['문장입니다'] }] })
      : JSON.stringify({ accepted: [false] }));
  });
  const source = [['문맥상 자연스럽지 않은 어미입니다']];
  await rewriteKoreanSentenceLines(source);
  await verifyKoreanSentenceLines(source, [['어색한 후보입니다']]);
  assert.match(prompts[0], /주어와 서술어, 목적·이유와 뒤따르는 서술/);
  assert.match(prompts[0], /연결 어미와 종결 표현이 자연스럽게 호응/);
  assert.match(prompts[0], /합니다체는 합니다체, 해요체는 해요체, 반말은 반말/);
  assert.match(prompts[1], /원문보다 문법과 말맛을 실제로 개선/);
  assert.match(prompts[1], /원문만큼 부자연스럽거나 더 어색하면 거부/);
  assert.match(prompts[1], /높임 수준과 종결 말투/);
  assert.match(prompts[1], /맞춤법·띄어쓰기·문장부호의 명백한 개선도 허용/);
});

test('only Luna client errors use the gpt-4o fallback', () => {
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    for (const status of [400, 403, 404]) assert.equal(shouldFallbackToGpt4o({ status }, model), true);
    for (const status of [401, 429, 500, 503, undefined]) assert.equal(shouldFallbackToGpt4o({ status }, model), false);
  }
  for (const model of ['gpt-4o', 'custom-model', undefined]) {
    assert.equal(shouldFallbackToGpt4o({ status: 400 }, model), false);
  }
});

function sdkResponse(text = '테스트 자막') {
  return { choices: [{ message: { content: text } }], usage: {
    prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    completion_tokens_details: { reasoning_tokens: 400 },
  } };
}

function skipRetryDelays(t) {
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) =>
    timeout(fn, delay === 1000 || delay === 2000 ? 0 : delay, ...args));
}

test('the actual correction path sends the default and legacy model payloads and reports cache-write cost', async t => {
  const requests = [];
  t.mock.method(OpenAI.prototype, 'post', async (path, options) => {
    assert.equal(path, '/chat/completions');
    requests.push(options.body);
    return sdkResponse('  테스트 자막  ');
  });
  const saved = process.env.GPT_CORRECTION_MODEL;
  try {
    delete process.env.GPT_CORRECTION_MODEL;
    const result = await correctTextWithUsage('테스트 자막', 'ko');
    assert.equal(result.model, 'gpt-6-luna');
    assert.equal(result.requestedModel, 'gpt-6-luna');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.text, '테스트 자막');
    assert.deepEqual(result.usage, { promptTokens: 1_000, cachedTokens: 200, cacheWriteTokens: 300,
      completionTokens: 500, totalTokens: 1_500 });
    assert.equal(result.estimatedCostUsd, 0.0003395);
    const legacy = await correctTextWithUsage('테스트 자막', 'ko', { model: 'gpt-5.6-luna' });
    assert.equal(legacy.model, 'gpt-5.6-luna');
    assert.equal(legacy.estimatedCostUsd, 0.000779);
    assert.deepEqual(requests.map(r => r.reasoning_effort), ['medium', 'medium']);
    assert.ok(requests.every(r => !('temperature' in r)));
  } finally {
    if (saved === undefined) delete process.env.GPT_CORRECTION_MODEL;
    else process.env.GPT_CORRECTION_MODEL = saved;
  }
});

test('both Luna aliases retain retries and use only the pinned GPT-4o support-error fallback', async t => {
  skipRetryDelays(t);
  t.mock.method(console, 'warn', () => {});
  const requests = [];
  t.mock.method(OpenAI.prototype, 'post', async (path, { body }) => {
    requests.push(body);
    if (body.model !== 'gpt-4o') throw Object.assign(new Error('synthetic unavailable model'), { status: 404 });
    return sdkResponse();
  });
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    requests.length = 0;
    const result = await correctTextWithUsage('테스트 자막', 'ko', { model });
    assert.equal(result.requestedModel, model);
    assert.equal(result.model, 'gpt-4o');
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(requests.map(r => r.model), [model, model, model, 'gpt-4o']);
    assert.equal(requests[3].temperature, 0.3);
    assert.equal('reasoning_effort' in requests[3], false);
    assert.equal(result.estimatedCostUsd, 0.00725);
  }
});

test('rate-limit and empty responses never change the selected correction model', async t => {
  skipRetryDelays(t);
  const requests = [];
  t.mock.method(OpenAI.prototype, 'post', async (path, { body }) => {
    requests.push(body.model);
    throw Object.assign(new Error('synthetic rate limit'), { status: 429 });
  });
  await assert.rejects(correctTextWithUsage('테스트 자막', 'ko', { model: 'gpt-6-luna' }));
  assert.deepEqual(requests, ['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna']);
  requests.length = 0;
  t.mock.method(OpenAI.prototype, 'post', async (path, { body }) => {
    requests.push(body.model);
    return sdkResponse(' ');
  });
  await assert.rejects(correctTextWithUsage('테스트 자막', 'ko', { model: 'gpt-6-luna' }));
  assert.deepEqual(requests, ['gpt-6-luna']);
});

test('both translation request paths remain on GPT-4o with their existing sampling', async t => {
  const requests = [];
  t.mock.method(OpenAI.prototype, 'post', async (path, { body }) => {
    requests.push(body);
    return sdkResponse('translation');
  });
  await translateToEnglish('1: 테스트 자막');
  await translateToKorean('synthetic input', 'English');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.model === 'gpt-4o' && r.temperature === 0.3 && !('reasoning_effort' in r)));
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
