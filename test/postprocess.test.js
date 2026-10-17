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
  assert.deepEqual(result.timings.usage, usage);
  assert.equal(result.timings.estimatedCostUsd, 0.0004);
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
