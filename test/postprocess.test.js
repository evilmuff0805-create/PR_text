import assert from 'node:assert/strict';
import test from 'node:test';
import { processSegmentsWithTiming } from '../src/services/postprocess.js';

const koreanSegments = [
  { start: 0, end: 1, text: '오늘 날씨가 조아요' },
  { start: 1, end: 2, text: '그래서 나갓어' },
];

test('corrects Korean segments when diarization language is unknown', async () => {
  const result = await processSegmentsWithTiming(koreanSegments, 'unknown', async (text) => text);

  assert.equal(result.timings.eligible, true);
  assert.equal(result.timings.languageDecision, 'inferred_from_hangul_segments');
  assert.deepEqual(result.segments, koreanSegments);
});

test('does not correct unknown English or explicitly detected English segments', async () => {
  const correct = async () => { throw new Error('correction must not run'); };
  const unknownEnglish = await processSegmentsWithTiming(
    [{ start: 0, end: 1, text: 'This is an English subtitle' }],
    'unknown',
    correct
  );
  const detectedEnglish = await processSegmentsWithTiming(koreanSegments, 'english', correct);

  assert.equal(unknownEnglish.timings.eligible, false);
  assert.equal(detectedEnglish.timings.eligible, false);
});

test('records actual model, fallback, usage, and cost from a correction response', async () => {
  const usage = { promptTokens: 100, cachedTokens: 0, completionTokens: 50, totalTokens: 150 };
  const result = await processSegmentsWithTiming(koreanSegments, 'korean', async (text) => ({
    text,
    model: 'gpt-5.6-luna',
    requestedModel: 'gpt-5.6-luna',
    fallbackUsed: false,
    usage,
    estimatedCostUsd: 0.0004,
  }));

  assert.equal(result.timings.model, 'gpt-5.6-luna');
  assert.equal(result.timings.fallbackCount, 0);
  assert.deepEqual(result.timings.usage, { ...usage, cacheWriteTokens: 0 });
  assert.deepEqual(result.timings.chunks[0].usage, usage);
  assert.equal(result.timings.estimatedCostUsd, 0.0004);
});

test('aggregates cache writes across correction chunks, legacy fallback and a failed chunk without changing speech', async () => {
  const source = Array.from({ length: 91 }, (_, index) => ({
    start: index * 2 + 0.125, end: index * 2 + 1.875, text: '안내 내용을 확인합니다',
  }));
  const original = structuredClone(source);
  let calls = 0;
  const result = await processSegmentsWithTiming(source, 'ko', async (text) => {
    const index = calls++;
    if (index === 3) throw new Error('synthetic correction chunk failure');
    const usages = [
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
        completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 }, total_tokens: 150 },
      { promptTokens: 200, cachedTokens: 40, cacheWriteTokens: 60, completionTokens: 80, totalTokens: 280,
        unknownField: 'ignored' },
      { promptTokens: 80, cachedTokens: 10, completionTokens: 20, totalTokens: 100 },
    ];
    return { text, model: index === 2 ? 'gpt-4o' : 'gpt-6-luna', fallbackUsed: index === 2, usage: usages[index] };
  });

  assert.equal(calls, 4);
  assert.deepEqual(result.timings.usage, {
    promptTokens: 380, cachedTokens: 70, cacheWriteTokens: 90, completionTokens: 150, totalTokens: 530,
  });
  assert.deepEqual(result.timings.chunks.map(({ outcome }) => outcome), ['success', 'success', 'success', 'fallback']);
  assert.equal(result.timings.fallbackCount, 1);
  assert.deepEqual(result.timings.model, ['gpt-6-luna', 'gpt-4o']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).timings.usage, result.timings.usage);
  assert.deepEqual(result.segments, original);
  assert.deepEqual(source, original);
});

test('absent or malformed cache-write usage cannot poison the numeric aggregate', async () => {
  const source = Array.from({ length: 61 }, (_, index) => ({ start: index, end: index + 0.5, text: '네 그대로 확인합니다' }));
  let calls = 0;
  const result = await processSegmentsWithTiming(source, 'ko', async (text) => {
    const index = calls++;
    if (index === 2) return text;
    return { text, usage: index === 0
      ? { promptTokens: 64, cachedTokens: 16, completionTokens: 32, totalTokens: 96 }
      : { promptTokens: '100', cachedTokens: Infinity, cacheWriteTokens: -5,
        completionTokens: null, totalTokens: NaN, unknownField: 'ignored' } };
  });

  assert.equal(calls, 3);
  assert.deepEqual(result.timings.usage, {
    promptTokens: 64, cachedTokens: 16, cacheWriteTokens: 0, completionTokens: 32, totalTokens: 96,
  });
  assert.ok(Object.values(result.timings.usage).every(Number.isFinite));
  assert.deepEqual(JSON.parse(JSON.stringify(result)).timings.usage, result.timings.usage);
  assert.deepEqual(result.segments, source);
});

test('accepts minimal Korean dictation and conjugation candidates without changing source timings', async () => {
  const pairs = [
    ['나물을 묻혀서', '나물을 무쳐서'],
    ['국을 팔팔 끌였어', '국을 팔팔 끓였어'],
    ['이거 몇일 걸렸어?', '이거 며칠 걸렸어?'],
    ['내일 할 거에요', '내일 할 거예요'],
    ['이렇게 하면 되요', '이렇게 하면 돼요'],
  ];
  const source = pairs.map(([text], index) => ({
    start: index * 2 + 0.125,
    end: index * 2 + 1.875,
    text,
    sourceWords: [{ word: text, start: index * 2 + 0.25, end: index * 2 + 1.5 }],
  }));
  const original = structuredClone(source);
  let calls = 0;
  const result = await processSegmentsWithTiming(source, 'ko', async (text, language) => {
    calls += 1;
    assert.equal(text, pairs.map(([before]) => before).join('\n'));
    assert.equal(language, 'ko');
    return pairs.map(([, after]) => after).join('\n');
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.segments, source.map((segment, index) => ({ ...segment, text: pairs[index][1] })));
  assert.deepEqual(source, original);
});

test('rejects numeric value, notation, order, and unit changes even alongside spelling correction', async () => {
  const pairs = [
    ['3개 넣으면 되요', '4개 넣으면 돼요'],
    ['3.5초면 되요', '3.6초면 돼요'],
    ['3.5초면 되요', '35초면 돼요'],
    ['.5초면 되요', '5초면 돼요'],
    ['1,000원이면 되요', '1.000원이면 돼요'],
    ['1,000원이면 되요', '1000원이면 돼요'],
    ['3.50초면 되요', '3.5초면 돼요'],
    ['-3도면 되요', '3도면 돼요'],
    ['−3도면 되요', '+3도면 돼요'],
    ['±3도면 되요', '3도면 돼요'],
    ['2개랑 3개면 되요', '3개랑 2개면 돼요'],
    ['3kg이면 되요', '3g이면 돼요'],
    ['3km/h면 되요', '3km/s면 돼요'],
    ['3.5킬로면 되요', '3.5미터면 돼요'],
    ['3만원이면 되요', '3원이면 돼요'],
    ['3만 개면 되요', '3만 명이면 돼요'],
    ['3%면 되요', '3이면 돼요'],
    ['3~5개면 되요', '35개면 돼요'],
    ['1/2개면 되요', '12개면 돼요'],
    ['3:50에 되요', '3:05에 돼요'],
    ['A3이면 되요', 'A4이면 돼요'],
    ['3개면 되요', '세 개면 돼요'],
    ['조금 넣으면 되요', '3개 넣으면 돼요'],
  ];
  const source = pairs.map(([text], index) => ({ start: index, end: index + 0.8, text }));
  const result = await processSegmentsWithTiming(source, 'ko', async () => pairs.map(([, after]) => after).join('\n'));

  assert.deepEqual(result.segments, source);
});

test('allows spacing next to unchanged numeric units and Korean spelling corrections', async () => {
  const pairs = [
    ['3kg 넣으면 되요', '3 kg 넣으면 돼요'],
    ['3km/h면 되요', '3 km / h면 돼요'],
    ['3.5킬로 넣으면 되요', '3.5 킬로 넣으면 돼요'],
    ['3.5 킬로 넣으면 되요', '3.5킬로 넣으면 돼요'],
    ['3개에요', '3 개예요'],
    ['3만원이면 되요', '3만 원이면 돼요'],
    ['-3.5도면 되요', '-3.5 도면 돼요'],
    ['3.5킬로와 2kg이면 되요', '3.5 킬로와 2 kg이면 돼요'],
  ];
  const source = pairs.map(([text], index) => ({ start: index, end: index + 0.9, text }));
  const result = await processSegmentsWithTiming(source, 'ko', async () => pairs.map(([, after]) => after).join('\n'));

  assert.deepEqual(result.segments, source.map((segment, index) => ({ ...segment, text: pairs[index][1] })));
});

test('reverts only the unsafe numeric line and keeps neighbouring corrections and metadata', async () => {
  const source = [
    { start: 0.1, end: 0.6, text: '3.5초면 되요', speaker: 0, timingSource: 'word' },
    { start: 0.9, end: 1.4, text: '나물을 묻혀서', speaker: 1, timingSource: 'word' },
    { start: 1.8, end: 2.3, text: '내일 할 거에요', speaker: 1, timingSource: 'word' },
  ];
  const original = structuredClone(source);
  let calls = 0;
  const result = await processSegmentsWithTiming(source, 'ko', async () => {
    calls += 1;
    return '35초면 돼요\n나물을 무쳐서\n내일 할 거예요';
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.segments, [source[0], { ...source[1], text: '나물을 무쳐서' }, { ...source[2], text: '내일 할 거예요' }]);
  assert.deepEqual(source, original);
});

test('a corrected word prefix cannot replace an independently repeated utterance', async () => {
  const pairs = [
    ['무 무 묻혀서 반찬을 만들었어', '무 무쳐서 반찬을 만들었어'],
    ['나 나 나왓어', '나 나왔어'],
    ['말 말 말햇어', '말 말했어'],
  ];
  const source = pairs.map(([text], index) => ({ start: index, end: index + 0.8, text }));
  const result = await processSegmentsWithTiming(source, 'ko', async () => pairs.map(([, after]) => after).join('\n'));
  assert.deepEqual(result.segments, source);
});

test('preserved repeats allow spelling corrections that introduce the same character inside another word', async () => {
  const pairs = [
    ['무 무 묻혀서 반찬을 만들었어', '무 무 무쳐서 반찬을 만들었어'],
    ['무무 묻혀서 반찬을 만들었어', '무 무 무쳐서 반찬을 만들었어'],
    ['네 네 내일 할 거에요', '네네 내일 할 거예요'],
    ['네 그거요 네 그거요 조아요', '네그거요 네그거요 좋아요'],
    ['하하하라고 말햇어', '하하하라고 말했어'],
  ];
  const source = pairs.map(([text], index) => ({ start: index, end: index + 0.8, text }));
  const result = await processSegmentsWithTiming(source, 'ko', async () => pairs.map(([, after]) => after).join('\n'));
  assert.deepEqual(result.segments, source.map((segment, index) => ({ ...segment, text: pairs[index][1] })));
});

test('repetition changes cannot hide behind spelling corrections or move across unchanged words', async () => {
  const pairs = [
    ['네 네 그래서 나갓어', '네 네 네 그래서 나갔어'],
    ['네 네 그래서 나갓어', '네 네 그래서 나갔어 네'],
    ['네 네 먼저 나갓어', '먼저 네 네 나갔어'],
    ['오늘 네 네 먼저 나갓어', '오늘 먼저 네 네 나갔어'],
    ['네 네 먼저 어 어 나갓어', '어 어 먼저 네 네 나갔어'],
    ['네 네 먼저 네 네 나갓어', '네 먼저 네 네 네 나갔어'],
    ['네 그거요 네 그거요 조아요', '네 그거요 좋아요'],
    ['하하하라고 말햇어', '하하라고 말했어'],
  ];
  const source = pairs.map(([text], index) => ({ start: index, end: index + 0.8, text }));
  const result = await processSegmentsWithTiming(source, 'ko', async () => pairs.map(([, after]) => after).join('\n'));
  assert.deepEqual(result.segments, source);
});

test('joined, spaced, and punctuated repetitions preserve their count alongside other corrections', async () => {
  for (const unit of ['네', '음', '좋아', '네그거요']) {
    for (const count of [2, 3, 4]) {
      const repeated = Array(count).fill(unit);
      const original = `${repeated.join('')} 그래서 나갓어`;
      const candidate = `${repeated.join(', ')} 그래서 나갔어`;
      const source = [{ start: 0.125, end: 2.875, text: original }];
      const result = await processSegmentsWithTiming(source, 'ko', async () => candidate);
      assert.equal(result.segments[0].text, candidate, `${unit}/${count}`);
      for (const wrongCount of [count - 1, count + 1]) {
        const wrong = `${Array(wrongCount).fill(unit).join(' ')} 그래서 나갔어`;
        const rejected = await processSegmentsWithTiming(source, 'ko', async () => wrong);
        assert.deepEqual(rejected.segments, source, `${unit}/${count} -> ${wrongCount}`);
      }
    }
  }
});

test('only a changed repetition line is restored and all source timing metadata stays immutable', async () => {
  const source = [
    { start: 2.125, end: 2.875, text: '말 말 말햇어', speaker: 0, sourceWords: [{ word: '말', start: 2.2, end: 2.3 }] },
    { start: 3.125, end: 3.875, text: '내일 할 거에요', timingSource: 'word' },
  ];
  const before = structuredClone(source);
  const result = await processSegmentsWithTiming(source, 'ko', async () => '말 말했어\n내일 할 거예요');
  assert.deepEqual(result.segments, [source[0], { ...source[1], text: '내일 할 거예요' }]);
  assert.deepEqual(source, before);
});

test('long repeated phrases retain their full speech while a neighbouring spelling correction applies', async () => {
  const repeated = '네 그거요 '.repeat(1_000);
  const original = `${repeated}그래서 나갓어`;
  const candidate = `${repeated}그래서 나갔어`;
  const source = [{ start: 1.125, end: 101.875, text: original }];
  const result = await processSegmentsWithTiming(source, 'ko', async () => candidate);
  assert.deepEqual(result.segments, [{ ...source[0], text: candidate }]);
});
