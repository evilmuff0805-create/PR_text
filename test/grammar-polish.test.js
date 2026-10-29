import test from 'node:test';
import assert from 'node:assert/strict';
import { polishKoreanSegments } from '../src/services/grammar-polish.js';
import { buildSubtitleCues, generateASS, generateSRT } from '../src/services/subtitle.js';
import { processTranscriptionSegments } from '../src/services/transcription-processing.js';

const cue = (text, start, end, extra = {}) => ({ start, end, text, ...extra });
const accepted = (sourceGroups) => ({ accepted: sourceGroups.map(() => true), model: 'mock-verifier', usage: { totalTokens: 5 } });

test('omitted and preserve modes have identical outputs and never invoke rewrite or verifier', async () => {
  const source = [{ start: 0, end: 0.5, text: '사과을 먹었다' }];
  let rewriteCalls = 0; let verifyCalls = 0;
  const options = { correct: async (text) => text,
    rewriteLines: async () => { rewriteCalls += 1; },
    verifyLines: async () => { verifyCalls += 1; } };
  const omitted = await processTranscriptionSegments(source, 'ko', options);
  const explicit = await processTranscriptionSegments(source, 'ko', { ...options, polishMode: 'preserve' });
  assert.deepEqual(omitted.segments, explicit.segments);
  assert.deepEqual(omitted.segments, explicit.segments);
  assert.equal(rewriteCalls, 0);
  assert.equal(verifyCalls, 0);
});

test('whole sentence context can rewrite mapped cues while retaining every original cue interval', async () => {
  const source = [
    cue('제가 이걸 하는 이유는', 1, 1.6, { timingSource: 'word', wordAlignedCues: [[1, 1.6, '제가 이걸 하는 이유는']] }),
    cue('시간을 좀 줄이고 싶어서 하는 거거든요.', 1.6, 2.7, { timingSource: 'word', wordAlignedCues: [[1.6, 2.7, '시간을 좀 줄이고 싶어서 하는 거거든요.']] }),
  ];
  let rewriteInput; let verifyInput;
  const result = await polishKoreanSegments(source, 'ko', {
    rewriteLines: async (groups) => {
      rewriteInput = groups;
      return { groups: [['제가 이걸 하는 이유는', '시간을 좀 줄이고 싶어서예요.']], model: 'mock-rewrite', usage: { totalTokens: 14 } };
    },
    verifyLines: async (originals, candidates) => {
      verifyInput = { originals, candidates };
      return accepted(originals);
    },
  });
  assert.deepEqual(rewriteInput, [['제가 이걸 하는 이유는', '시간을 좀 줄이고 싶어서 하는 거거든요']]);
  assert.deepEqual(verifyInput.originals, rewriteInput);
  assert.deepEqual(verifyInput.candidates, [['제가 이걸 하는 이유는', '시간을 좀 줄이고 싶어서예요.']]);
  assert.deepEqual(result.segments.map(({ text }) => text), ['제가 이걸 하는 이유는', '시간을 좀 줄이고 싶어서예요.']);
  assert.equal(result.applied, 1);
  assert.equal(result.segments[0].start, 1);
  assert.equal(result.segments[0].end, 1.6);
  assert.equal(result.segments[1].start, 1.6);
  assert.equal(result.segments[1].end, 2.7);
  assert.equal(result.segments[1].timingSource, 'speech_window');
  assert.equal(Object.hasOwn(result.segments[1], 'wordAlignedCues'), false);
  assert.equal(result.segments[1].grammarPolish.originalText, '시간을 좀 줄이고 싶어서 하는 거거든요');
  assert.deepEqual(buildSubtitleCues(result.segments, { holdShortGaps: false }).map(({ start, end }) => [start, end]), [[1, 1.6], [1.6, 2.7]]);
  assert.deepEqual(generateSRT(result.segments, null, { holdShortGaps: false }).split('\n').filter((line) => line.includes(' --> ')), ['00:00:01,000 --> 00:00:01,600', '00:00:01,600 --> 00:00:02,700']);
  assert.deepEqual(generateASS(result.segments, { holdShortGaps: false }).split('\n').filter((line) => /^Dialogue:/u.test(line)).map((line) => line.split(',').slice(1, 3).join(',')), ['0:00:01.00,0:00:01.60', '0:00:01.60,0:00:02.70']);
});

test('a meaning verifier rejection rolls back the entire cue window', async () => {
  const source = [cue('저는 원래 반대했는데', 0, 0.4), cue('이제 찬성합니다', 0.4, 0.8)];
  const result = await polishKoreanSegments(source, 'ko', {
    rewriteLines: async () => ({ groups: [['저는 원래 반대했지만', '이제 찬성합니다']], usage: { totalTokens: 10 } }),
    verifyLines: async () => ({ accepted: [false] }),
  });
  assert.deepEqual(result.segments.map(({ text }) => text), source.map(({ text }) => text));
  assert.equal(result.applied, 0);
  assert.equal(result.segments.length, source.length);
});

test('a Korean eojeol cannot move from one cue to another inside a sentence window', async () => {
  const source = [cue('시간을 줄이고 싶어서', 0, 0.5), cue('하는 거예요', 0.5, 1)];
  const result = await polishKoreanSegments(source, 'ko', {
    rewriteLines: async () => ({ groups: [['줄이고 싶어서', '시간을 줄이는 거예요']] }),
    verifyLines: async (originals) => accepted(originals),
  });
  assert.deepEqual(result.segments.map(({ text }) => text), source.map(({ text }) => text));
  assert.equal(result.applied, 0);
  assert.equal(result.summary.statuses.unsafe_candidate, 2);
});

test('moving a repeated eojeol is blocked even when the destination cue already contains it', async () => {
  const source = [cue('너를 너를', 0, 0.5), cue('너를 기다립니다', 0.5, 1)];
  const result = await polishKoreanSegments(source, 'ko', {
    rewriteLines: async () => ({ groups: [['너를', '너를 너를 기다립니다']] }),
    verifyLines: async (originals) => accepted(originals),
  });
  assert.deepEqual(result.segments.map(({ text }) => text), source.map(({ text }) => text));
  assert.equal(result.applied, 0);
  assert.equal(result.summary.statuses.unsafe_candidate, 2);
});

test('missing verifier fails closed; legacy polishLines injection cannot bypass it', async () => {
  const source = [cue('오늘은 집에서 쉽니다', 0, 0.4)];
  let calls = 0;
  const result = await polishKoreanSegments(source, 'ko', { polishLines: async () => { calls += 1; return ['오늘은 집에서 쉬어요']; } });
  assert.equal(calls, 0);
  assert.deepEqual(result.segments, source);
  assert.equal(result.unavailable, true);
});

test('candidate must keep each cue mapped, one line and within 28 characters', async () => {
  const cases = [
    { source: ['안 가요', '내일 갑니다'], candidate: ['가요', '내일 갑니다'] },
    { source: ['3.5 kg을', '넣습니다'], candidate: ['4 kg을', '넣습니다'] },
    { source: ['API는 정상', '작동합니다'], candidate: ['서비스는 정상', '작동합니다'] },
    { source: ['이 큐는', '여기에서 끝나야 해요'], candidate: ['이 큐는 다음에', '옮겨졌어요'] },
    { source: ['짧은 문장'], candidate: ['공백 없는 긴 무공백문자열인데서른글자를넘어갑니다'] },
    { source: ['한 줄 문장'], candidate: ['한 줄\n두 줄'] },
    { source: ['네 네 왔어요'], candidate: ['네 왔어요'] },
  ];
  for (const { source, candidate } of cases) {
    const segments = source.map((text, index) => cue(text, index * 0.5, index * 0.5 + 0.5));
    const result = await polishKoreanSegments(segments, 'ko', {
      rewriteLines: async () => ({ groups: [candidate] }),
      verifyLines: async (groups, candidates) => ({
        accepted: candidates.map(() => false),
      }),
    });
    assert.deepEqual(result.segments.map(({ text }) => text), source);
    assert.equal(result.applied, 0);
  }
});

test('clear formal endings cannot be rewritten as casual speech; same-level rewriting and other tones remain available', async () => {
  const run = (sourceText, candidateText) => polishKoreanSegments([cue(sourceText, 0, 1)], 'ko', {
    rewriteLines: async () => ({ groups: [[candidateText]] }),
    verifyLines: async (originals) => accepted(originals),
  });

  const formalToCasual = await run('쉽습니다.', '쉬워서예요');
  assert.equal(formalToCasual.applied, 0);
  assert.equal(formalToCasual.summary.statuses.unsafe_candidate, 1);
  assert.equal(formalToCasual.segments[0].text, '쉽습니다.');

  const formalToFormal = await run('쉽습니다.', '간단합니다.');
  assert.equal(formalToFormal.applied, 1);
  assert.equal(formalToFormal.segments[0].text, '간단합니다.');

  const politeToPolite = await run('쉬워요.', '간단해요');
  assert.equal(politeToPolite.applied, 1);
  const casualToCasual = await run('쉬워.', '간단해');
  assert.equal(casualToCasual.applied, 1);
});

test('ordinary positive gaps split context windows; diarized windows never cross a positive gap or speaker', async () => {
  const ordinary = [cue('첫 번째 문장입니다', 0, 0.4), cue('다음 문장입니다', 0.8, 1)];
  let ordinaryGroups;
  await polishKoreanSegments(ordinary, 'ko', {
    rewriteLines: async (groups) => { ordinaryGroups = groups; return { groups }; },
    verifyLines: async (groups) => accepted(groups),
  });
  assert.deepEqual(ordinaryGroups, [['첫 번째 문장입니다'], ['다음 문장입니다']]);

  const diarized = [
    cue('화자 하나입니다', 0, 0.4, { speaker: 'opaque-a' }),
    cue('화자 하나의 다음', 0.4, 0.8, { speaker: 'opaque-a' }),
    cue('화자 둘입니다', 0.8, 1.2, { speaker: 'opaque-b' }),
  ];
  let diarizedGroups;
  await polishKoreanSegments(diarized, 'ko', {
    rewriteLines: async (groups) => { diarizedGroups = groups; return { groups }; },
    verifyLines: async (groups) => accepted(groups),
  });
  assert.deepEqual(diarizedGroups, [['화자 하나입니다', '화자 하나의 다음'], ['화자 둘입니다']]);
});

test('batches six whole context groups as 6, 6, and 1 without splitting a 12-cue group', async () => {
  const source = [];
  for (let index = 0; index < 12; index += 1) source.push(cue(`연속 자막 ${index}입니다`, index * 0.5, index * 0.5 + 0.4));
  for (let index = 0; index < 12; index += 1) source.push(cue(`분리 자막 ${index}입니다`, 8 + index * 2, 8 + index * 2 + 0.4));
  const batchGroupLengths = [];
  await polishKoreanSegments(source, 'ko', {
    rewriteLines: async (groups) => {
      batchGroupLengths.push(groups.map((group) => group.length));
      return { groups };
    },
    verifyLines: async (originals) => accepted(originals),
  });
  assert.deepEqual(batchGroupLengths.map((batch) => batch.length), [6, 6, 1]);
  assert.deepEqual(batchGroupLengths[0], [12, 1, 1, 1, 1, 1]);
  assert.deepEqual(batchGroupLengths[1], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(batchGroupLengths[2], [1]);
});

test('a middle batch failure preserves earlier applied groups and leaves remaining groups original', async () => {
  const source = Array.from({ length: 13 }, (_, index) => cue(`자막 ${index}은 맞습니다`, index * 2, index * 2 + 0.4));
  let rewriteCalls = 0;
  const result = await polishKoreanSegments(source, 'ko', {
    rewriteLines: async (groups) => {
      rewriteCalls += 1;
      if (rewriteCalls === 2) throw new Error('synthetic middle batch failure');
      return { groups: groups.map((group) => group.map((line) => line.replace('맞습니다', '정상입니다'))) };
    },
    verifyLines: async (originals) => accepted(originals),
  });
  assert.equal(rewriteCalls, 2);
  assert.deepEqual(result.segments.slice(0, 6).map(({ text }) => text), source.slice(0, 6).map(({ text }) => text.replace('맞습니다', '정상입니다')));
  assert.deepEqual(result.segments.slice(6).map(({ text }) => text), source.slice(6).map(({ text }) => text));
  assert.equal(result.applied, 6);
  assert.equal(result.unavailable, true);
  assert.equal(result.summary.statuses.api_error, 7);
});

test('review candidates and limits are checked against source rows before cue materialization', async () => {
  let calls = 0;
  const review = [{ start: 0, end: 1, text: '검토 대기 문장입니다', subtitleReview: { candidateText: '검토 문장입니다' } }];
  const skipped = await polishKoreanSegments(review, 'ko', {
    rewriteLines: async (groups) => { calls += 1; return { groups }; },
    verifyLines: async (groups) => accepted(groups),
  });
  assert.equal(calls, 0);
  assert.deepEqual(skipped.segments, review);

  const limited = await polishKoreanSegments(Array.from({ length: 121 }, (_, index) => cue(`자막 ${index + 1}`, index, index + 0.4)), 'ko', {
    rewriteLines: async (groups) => { calls += 1; return { groups }; },
    verifyLines: async (groups) => accepted(groups),
  });
  assert.equal(limited.applied, 0);
  assert.equal(limited.limited, true);
  assert.equal(limited.segments.length, 121);
  assert.ok(calls > 0);
});

test('legacy compact results above 5000 materialized cues fail closed without expansion', async () => {
  let calls = 0;
  const result = await polishKoreanSegments([cue('보존할 입력', 0, 1)], 'ko', {
    buildCues: () => Array.from({ length: 5_001 }, (_, index) => cue('자막', index, index + 0.2)),
    rewriteLines: async (groups) => { calls += 1; return { groups }; },
    verifyLines: async (groups) => accepted(groups),
  });
  assert.equal(calls, 0);
  assert.equal(result.limited, true);
  assert.deepEqual(result.segments, [cue('보존할 입력', 0, 1)]);
  assert.deepEqual(result.summary.statuses, { limit: 5_001 });
});

test('cue materialization that changes the timeline fails closed before calling APIs', async () => {
  let buildCalls = 0;
  let apiCalls = 0;
  const source = [cue('보존할 원문', 0, 1)];
  const result = await polishKoreanSegments(source, 'ko', {
    buildCues: () => {
      buildCalls += 1;
      return [cue('보존할 원문', buildCalls === 1 ? 0 : 0.1, 1)];
    },
    rewriteLines: async (groups) => { apiCalls += 1; return { groups }; },
    verifyLines: async (groups) => { apiCalls += 1; return accepted(groups); },
  });
  assert.equal(buildCalls, 2);
  assert.equal(apiCalls, 0);
  assert.equal(result.unavailable, true);
  assert.equal(result.summary.statuses.timeline_fallback, 1);
  assert.deepEqual(result.segments, source);
});

test('restoring a rewritten word-timed cue returns the original SRT timeline; long and undefined cues stay unchanged', async () => {
  const wordTimed = [cue('정말 자연스럽지 않은 문장입니다', 1.25, 2.75, {
    timingSource: 'word', wordAlignedCues: [[1.25, 2.75, '정말 자연스럽지 않은 문장입니다']],
  })];
  const beforeSrtTimes = generateSRT(wordTimed, null, { holdShortGaps: false }).split('\n').filter((line) => line.includes(' --> '));
  const result = await polishKoreanSegments(wordTimed, 'ko', {
    rewriteLines: async (groups) => ({ groups: [['조금 더 자연스러운 문장입니다']] }),
    verifyLines: async (originals) => accepted(originals),
  });
  const changed = result.segments[0];
  assert.equal(changed.timingSource, 'speech_window');
  const restored = { ...changed, text: changed.grammarPolish.originalText,
    timingSource: changed.grammarPolish.originalTimingSource };
  delete restored.grammarPolish;
  const restoredTimes = generateSRT([restored], null, { holdShortGaps: false }).split('\n').filter((line) => line.includes(' --> '));
  assert.deepEqual(restoredTimes, beforeSrtTimes);

  let calls = 0;
  const longWithoutTimingSource = [cue('이 자막은 스물여덟 글자 제한을 넘으므로 기존 결과가 그대로 유지되어야 합니다', 3, 5)];
  const unchanged = await polishKoreanSegments(longWithoutTimingSource, 'ko', {
    rewriteLines: async (groups) => { calls += 1; return { groups }; },
    verifyLines: async (groups) => { calls += 1; return accepted(groups); },
  });
  assert.ok(calls > 0);
  assert.deepEqual(unchanged.segments, longWithoutTimingSource);
});

test('API error and timeout keep baseline cues; non-Korean is untouched', async () => {
  const source = [cue('오늘 정말 반가웠습니다', 0, 1)];
  const failed = await polishKoreanSegments(source, 'ko', {
    rewriteLines: async () => { throw new Error('mock error'); },
    verifyLines: async () => accepted([source.map((item) => item.text)]),
  });
  assert.deepEqual(failed.segments, source);
  assert.equal(failed.unavailable, true);

  let called = false;
  const english = await polishKoreanSegments([cue('Hello world', 0, 1)], 'en', {
    rewriteLines: async () => { called = true; }, verifyLines: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(english.segments[0].text, 'Hello world');
});
