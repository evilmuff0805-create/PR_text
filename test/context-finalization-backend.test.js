import assert from 'node:assert/strict';
import test from 'node:test';
import { processTranscriptionSegments, refineKoreanSegmentsWithWordTimings } from '../src/services/transcription-processing.js';
import { planCueWindowCorrection, finalizeTranscriptionContext, CONTEXT_FINALIZATION_LIMITS } from '../src/services/context-finalization.js';
import { alignCorrectedKoreanSegmentWithWordTimings } from '../src/services/korean-word-timing.js';
import { getBoundFixedCuePlan, normalizeFixedCuePlan, restoreFixedCuePlan, getBoundCorrectionStatus } from '../src/services/fixed-cue-plan.js';
import { buildSubtitleCues, generateSRT, generateTXT } from '../src/services/subtitle.js';
import { validateSubtitleSegments } from '../src/services/subtitle-payload.js';

function timed(text, start = 1, end = 4, { padding = 0 } = {}) {
  const words = text.split(' '), length = (end - start) / words.length;
  return { text, start: start - padding, end: end + padding,
    sourceWords: words.map((word, index) => ({ word, start: start + index * length, end: start + (index + 1) * length })) };
}
const fixed = (text, start, end) => ({ text, start, end, timingSource: 'speech_window',
  fixedCuePlan: { version: 1, binding: { text, start, end }, cues: [[start, end, text]] } });

test('an ambiguous word spelling can change one proven cue without using the padded source range', async () => {
  const original = timed('무지를 천천히 확인했어요', 1, 4, { padding: 1 });
  const corrected = { ...original, text: '무늬를 천천히 확인했어요' };
  assert.equal(alignCorrectedKoreanSegmentWithWordTimings(original, corrected).correctionRetained, false);
  const result = await processTranscriptionSegments([original], 'ko', { correct: async () => corrected.text });
  assert.equal(result.segments[0].text, corrected.text);
  assert.equal(result.segments[0].start, 1);
  assert.equal(result.segments[0].end, 4);
  assert.equal(result.segments[0].timingSource, 'speech_window');
  assert.equal(getBoundCorrectionStatus(result.segments[0]), 'cue_applied');
  assert.ok(getBoundFixedCuePlan(result.segments[0]));
  assert.equal(result.segments[0].wordAlignedCues, undefined);
  const restored = restoreFixedCuePlan(JSON.parse(JSON.stringify(result.segments[0])));
  assert.equal(restored.text, original.text);
  assert.equal(restored.start, 1);
  assert.equal(restored.end, 4);
  assert.equal(restored.timingSource, 'speech_window');
  assert.equal(restored.wordAlignedCues, undefined);
  assert.equal(getBoundCorrectionStatus(restored), 'restored');
});

test('existing unambiguous spelling stays on the original strict word alignment path', async () => {
  const original = timed('오늘 날씨가 조아요');
  const result = await processTranscriptionSegments([original], 'ko', { correct: async () => '오늘 날씨가 좋아요' });
  assert.equal(result.segments[0].text, '오늘 날씨가 좋아요');
  assert.equal(result.segments[0].timingSource, 'word');
  assert.equal(result.segments[0].fixedCuePlan, undefined);
  assert.equal(result.contextFinalization.cueCorrectionsApplied, 0);
});

test('edits spanning two original cues and number or tone changes remain unapproved', () => {
  const original = timed('무지를 확인하고 사진을 남겼어요', 1, 4);
  original.sourceWords[2].start += .4;
  original.sourceWords[2].end += .4;
  original.sourceWords[3].start += .4;
  original.sourceWords[3].end += .4;
  original.end += .4;
  assert.equal(planCueWindowCorrection(original, { ...original, text: '무늬를 확인하고 사전을 남겼어요' }).accepted, false);
  const numbered = timed('무지를 세 번 3개 확인했어요');
  assert.equal(planCueWindowCorrection(numbered, { ...numbered, text: '무늬를 세 번 4개 확인했어요' }).accepted, false);
  const formal = timed('무지를 천천히 확인합니다');
  assert.equal(planCueWindowCorrection(formal, { ...formal, text: '무늬를 천천히 확인해요' }).accepted, false);
});

test('unknown cross-source continuity is restored after correction without altering correction input', async () => {
  const sources = [timed('지금은 서류를 정리하고', 1, 2), timed('아니 그건요', 2, 2.5), timed('다른 방법으로 볼게요', 2.5, 4)];
  const before = refineKoreanSegmentsWithWordTimings(sources, { originalSegments: sources });
  assert.equal(before.length, 2);
  const requests = [];
  const result = await processTranscriptionSegments(sources, 'ko', { correct: async (text, language, context) => {
    requests.push({ text, language, context }); return text;
  } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, sources.map(row => row.text).join('\n'));
  assert.equal(result.segments.length, 3);
  assert.deepEqual(result.segments.map(row => [row.start, row.end]), [[1, 2], [2, 2.5], [2.5, 4]]);
  assert.equal(result.contextFinalization.sourceBoundariesRestored, 1);
  assert.equal(buildSubtitleCues(result.segments).length, 3);
  assert.equal(generateTXT(result.segments), sources.map(row => row.text).join(' '));
});

test('a continuation inside one ASR source and a genuine short reply keep all source text and times', async () => {
  const original = timed('서류를 정리하고 남은 일을 확인하는 거예요', 1, 5);
  const reply = timed('네', 6, 6.1);
  const baseline = refineKoreanSegmentsWithWordTimings([original, reply], { originalSegments: [original, reply] });
  const result = await processTranscriptionSegments([original, reply], 'ko', { correct: async text => text });
  assert.deepEqual(result.segments, baseline.map(({ sourceWords, ...row }) => row));
  assert.equal(result.segments.at(-1).end - result.segments.at(-1).start < .11, true);
});

test('grammar output is never overwritten with a stale basic correction candidate', () => {
  const original = timed('무지를 천천히 확인했어요');
  const corrected = { ...original, text: '무늬를 천천히 확인했어요' };
  const trace = {};
  const base = refineKoreanSegmentsWithWordTimings([corrected], { originalSegments: [original], trace });
  const grammar = [{ ...base[0], text: '표면의 무늬를 확인했어요', grammarPolish: { status: 'applied' },
    subtitleReview: { ...base[0].subtitleReview, candidateText: corrected.text, textStatus: 'candidate' } }];
  const result = finalizeTranscriptionContext({ sourceSegments: [original], correctionSourceSegments: [original],
    correctedSegments: [corrected], baseSegments: base, segments: grammar, trace, language: 'ko' });
  assert.equal(result.segments[0].text, grammar[0].text);
  assert.equal(result.segments[0].fixedCuePlan, undefined);
  assert.equal(getBoundCorrectionStatus(result.segments[0]), 'held');
  assert.equal(result.segments[0].subtitleReview.candidateText, undefined);
  assert.equal(result.segments[0].subtitleReview.textStatus, undefined);
});

test('fixed plans preserve equal starts and reject an original snapshot with other cue times', () => {
  const first = fixed('앞쪽 합성 문장', 1, 2), second = fixed('겹친 합성 문장', 1, 3);
  const cues = buildSubtitleCues([first, second], { holdShortGaps: false });
  assert.deepEqual(cues.map(cue => [cue.start, cue.end]), [[1, 2], [1, 3]]);
  assert.equal(normalizeFixedCuePlan({ ...first.fixedCuePlan,
    original: { text: first.text, start: 0, end: 2, cues: [[0, 2, first.text]] } }), undefined);
  assert.equal(getBoundFixedCuePlan({ ...first, text: first.text + ' 수정' }), undefined);
  assert.equal(getBoundCorrectionStatus({ ...first, speaker: 0,
    subtitleReview: { correctionStatus: 'cue_applied', correctionBinding: { text: first.text, start: 1, end: 2 } } }), undefined);
});

test('a compact baseline retains thousands of verified internal boundaries when a later source merge is undone', async () => {
  const words = Array.from({ length: 5_000 }, (_, index) => ({ word: '가', start: index * .5, end: index * .5 + .1 }));
  const long = { text: words.map(word => word.word).join(' '), start: 0, end: 2500, sourceWords: words };
  const sources = [long, timed('마지막 자료를 확인하고', 2501, 2502), timed('아니 그렇군요', 2502, 2503)];
  const result = await processTranscriptionSegments(sources, 'ko', { correct: async text => text });
  assert.ok(result.segments.length <= 5_000);
  assert.equal(result.contextFinalization.limited, false);
  const cues = buildSubtitleCues(result.segments, { holdShortGaps: false });
  assert.equal(cues.length, 5_002);
  assert.deepEqual([cues[0].start, cues[0].end], [0, .1]);
  assert.deepEqual([cues[4999].start, cues[4999].end], [2499.5, 2499.6]);
  assert.match(generateSRT(result.segments, null, { holdShortGaps: false }), /마지막 자료를 확인하고/u);
});

test('cue fallback preserves independent negation while ordinary words and quoted markers remain eligible', () => {
  for (const [before, after] of [
    ['무지를 안 확인했어요', '무늬를 다 확인했어요'],
    ['무지를 못 확인했어요', '무늬를 또 확인했어요'],
    ['무지를 확인했어요', '무늬를 안 확인했어요'],
    ['무지를 안 확인했어요', '무늬를 못 확인했어요'],
    ['무지가 없어요', '무늬가 있어요'],
    ['무지를 확인하지 않았어요', '무늬를 확인하고 있었어요'],
  ]) {
    const source = timed(before);
    assert.equal(planCueWindowCorrection(source, { ...source, text: after }).accepted, false, before);
  }
  for (const [before, after] of [
    ['무지를 안 확인했어요', '무늬를 안 확인했어요'],
    ['무지를 못 확인했어요', '무늬를 못 확인했어요'],
    ['안내문의 무지를 확인했어요', '안내문의 무늬를 확인했어요'],
    ['연못가의 무지를 확인했어요', '연못가의 무늬를 확인했어요'],
    ['글자 “안”의 무지를 확인했어요', '글자 “안”의 무늬를 확인했어요'],
  ]) {
    const source = timed(before);
    assert.equal(planCueWindowCorrection(source, { ...source, text: after }).accepted, true, before);
  }
});

test('cue fallback requires local phonetic spelling evidence rather than equal length or a sentence edit ratio', async () => {
  for (const [before, after] of [
    ['잠시 편안하게 기다려요', '잠시 차분하게 기다려요'],
    ['자료를 조금 살펴봤어요', '자료를 아주 살펴봤어요'],
    ['자료를 모두 버렸어요', '자료를 모두 살렸어요'],
    ['자료를 먹었어요', '자료를 찍었어요'],
    ['무지를 천천히 확인했어요', '무늬를 꼼꼼히 확인했어요'],
  ]) {
    const source = timed(before);
    assert.equal(planCueWindowCorrection(source, { ...source, text: after }).accepted, false, before);
    const result = await processTranscriptionSegments([source], 'ko', { correct: async () => after });
    assert.equal(result.segments[0].text, before);
    assert.equal(result.contextFinalization.cueCorrectionsApplied, 0);
  }
  const source = timed('무지를 천천히 확인했어요');
  const accepted = planCueWindowCorrection(source, { ...source, text: '무늬를 천천히 확인했어요' });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.cues.map(cue => [cue.start, cue.end]), [[source.start, source.end]]);
});

test('missing or duplicate original source ownership holds a cue candidate', () => {
  const original = timed('무지를 천천히 확인했어요');
  const corrected = { ...original, text: '무늬를 천천히 확인했어요' };
  const trace = {};
  const base = refineKoreanSegmentsWithWordTimings([corrected], { originalSegments: [original], trace });
  for (const sources of [[], [original, structuredClone(original)]]) {
    const result = finalizeTranscriptionContext({ sourceSegments: sources, correctionSourceSegments: [original],
      correctedSegments: [corrected], baseSegments: base, segments: base, trace, language: 'ko' });
    assert.equal(result.segments[0].text, original.text);
    assert.equal(result.segments[0].fixedCuePlan, undefined);
    assert.equal(result.summary.cueCorrectionsApplied, 0);
    assert.equal(getBoundCorrectionStatus(result.segments[0]), 'held');
    assert.ok(result.segments[0].subtitleReview.issues.some(issue => issue.reason === 'source_ownership_ambiguous'));
  }
});

test('grammar ownership cannot be inferred across equal-start competing source windows', () => {
  const first = timed('무지를 천천히 확인했어요'), second = timed('별도의 합성 안내예요');
  const corrected = [{ ...first, text: '무늬를 천천히 확인했어요' }, second];
  const trace = {};
  const base = refineKoreanSegmentsWithWordTimings(corrected, { originalSegments: [first, second], trace });
  const grammar = base.map(row => ({ ...row }));
  const result = finalizeTranscriptionContext({ sourceSegments: [first, second], correctionSourceSegments: [first, second],
    correctedSegments: corrected, baseSegments: base, segments: grammar, trace, language: 'ko' });
  assert.equal(result.segments, grammar);
  assert.equal(result.summary.limited, true);
  assert.equal(result.summary.cueCorrectionsApplied, 0);
});

test('restoring initially merged source windows records unassigned corrections without cloning stale candidates', () => {
  const raw = [{ text: '네', start: 5, end: 5.4 }, { text: '문서를 살펴바요', start: 5.6, end: 7 }];
  const merged = { text: raw.map(row => row.text).join(' '), start: 5, end: 7 };
  const corrected = { ...merged, text: '네 문서를 살펴봐요' };
  const trace = {};
  const base = refineKoreanSegmentsWithWordTimings([corrected], { originalSegments: [merged], trace });
  for (const current of [base, [{ ...base[0], text: '네 문서를 먼저 살펴봐요', grammarPolish: { status: 'applied' },
    subtitleReview: { version: 1, candidateText: '이전 합성 후보예요', textStatus: 'candidate' } }]]) {
    const result = finalizeTranscriptionContext({ sourceSegments: raw, correctionSourceSegments: [merged],
      correctedSegments: [corrected], baseSegments: base, segments: current, trace, language: 'ko' });
    assert.deepEqual(result.segments.map(({ text, start, end }) => ({ text, start, end })), raw);
    assert.equal(result.summary.heldCandidates, 1);
    for (const row of result.segments) {
      assert.equal(getBoundCorrectionStatus(row), 'held');
      assert.equal(row.subtitleReview.candidateText, undefined);
      assert.equal(row.subtitleReview.textStatus, undefined);
      assert.ok(row.subtitleReview.issues.some(issue => issue.reason === 'split_source_correction_unassigned'));
    }
    if (current !== base) assert.equal(result.summary.grammarWithheld, 1);
  }
});

test('real grammar processing reports final applied and withheld counts without changing consumed call usage', async t => {
  process.env.OPENAI_API_KEY = 'context-finalization-mock-not-a-real-key';
  const { Completions } = await import('openai/resources/chat/completions');
  const verificationBodies = [];
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External requests are forbidden in this regression'); });
  t.mock.method(Completions.prototype, 'create', async request => {
    const input = JSON.parse(request.messages[1].content);
    verificationBodies.push(input);
    return { choices: [{ message: { content: JSON.stringify({ accepted: input.sourceGroups.map(() => true) }) } }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } };
  });
  for (const partial of [false, true]) {
    const sources = [timed('지금은 서류를 정리하고', 1, 2), timed('아니 그건요', 2, 2.5)];
    if (partial) sources.push(timed('자료를 좀 보고 싶어서 하는 거예요', 4, 7));
    let rewriteInput;
    const result = await processTranscriptionSegments(sources, 'ko', { correct: async text => text,
      polishMode: 'grammar', polishLines: async groups => {
        rewriteInput = groups;
        return { groups: groups.map(group => group.map(text => text.replace('정리하고', '정리하며')
          .replace('자료를 좀 보고 싶어서 하는 거예요', '자료를 좀 보고 싶어서예요'))),
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };
      } });
    assert.deepEqual(rewriteInput[0], [sources[0].text + ' ' + sources[1].text]);
    assert.deepEqual(verificationBodies.at(-1).sourceGroups, rewriteInput);
    assert.equal(result.grammarPolish.metrics.calls, 2);
    assert.equal(result.grammarPolish.metrics.usage.totalTokens, 12);
    assert.equal(result.grammarPolish.applied, partial ? 1 : 0);
    assert.equal(result.grammarPolish.summary.statuses.applied || 0, partial ? 1 : 0);
    assert.equal(result.grammarPolish.summary.statuses.boundary_withheld, 2);
    assert.equal(result.grammarPolish.skipped, 2);
    assert.deepEqual(result.segments.slice(0, 2).map(row => row.text), sources.slice(0, 2).map(row => row.text));
    assert.ok(result.segments.slice(0, 2).every(row => row.grammarPolish.status === 'boundary_withheld'));
    if (partial) assert.equal(result.segments[2].grammarPolish.status, 'applied');
  }
  assert.equal(verificationBodies.length, 2);
});

test('compaction after restoring a source boundary retains applied text and its exact original cue plan', () => {
  const first = timed('무지를 천천히 확인했어요');
  const fillers = Array.from({ length: 4_998 }, (_, index) => timed('합성 자료를 확인해요', 10 + index * 2, 11 + index * 2));
  const sources = [first, ...fillers, timed('마지막 자료를 확인하고', 10_010, 10_011), timed('아니 그렇군요', 10_011, 10_012)];
  const corrected = sources.map((row, index) => index ? row : { ...row, text: '무늬를 천천히 확인했어요' });
  const trace = {};
  const base = refineKoreanSegmentsWithWordTimings(corrected, { originalSegments: sources, trace });
  assert.equal(base.length, 5_000);
  const result = finalizeTranscriptionContext({ sourceSegments: sources, correctionSourceSegments: sources,
    correctedSegments: corrected, baseSegments: base, segments: base, trace, language: 'ko' });
  assert.equal(result.summary.limited, false);
  assert.equal(result.summary.cueCorrectionsApplied, 1);
  assert.equal(result.summary.sourceBoundariesRestored, 1);
  assert.equal(result.segments.length, 5_000);
  assert.equal(buildSubtitleCues(result.segments, { holdShortGaps: false }).length, 5_001);
  const applied = result.segments[0];
  assert.equal(getBoundCorrectionStatus(applied), 'cue_applied');
  assert.equal(getBoundFixedCuePlan(applied).original.text, first.text);
  const restored = restoreFixedCuePlan(applied);
  assert.equal(restored.text, first.text);
  assert.deepEqual([restored.start, restored.end], [first.start, first.end]);
  assert.equal(getBoundCorrectionStatus(restored), 'restored');

  const rawTail = [{ text: '네', start: 10_010, end: 10_010.4 }, { text: '문서를 살펴바요', start: 10_010.6, end: 10_012 }];
  const rawWithInitialMerge = [first, ...fillers, ...rawTail];
  const merged = { text: rawTail.map(row => row.text).join(' '), start: rawTail[0].start, end: rawTail[1].end };
  const correctionSources = [first, ...fillers, merged];
  const changed = correctionSources.map((row, index) => index === 0 ? { ...row, text: '무늬를 천천히 확인했어요' }
    : index === correctionSources.length - 1 ? { ...row, text: '네 문서를 살펴봐요' } : row);
  const secondTrace = {};
  const secondBase = refineKoreanSegmentsWithWordTimings(changed, { originalSegments: correctionSources, trace: secondTrace });
  const secondResult = finalizeTranscriptionContext({ sourceSegments: rawWithInitialMerge, correctionSourceSegments: correctionSources,
    correctedSegments: changed, baseSegments: secondBase, segments: secondBase, trace: secondTrace, language: 'ko' });
  assert.equal(secondResult.segments.length, 5_000);
  assert.equal(secondResult.summary.heldCandidates, 1);
  const heldTail = secondResult.segments.at(-1);
  assert.equal(getBoundCorrectionStatus(heldTail), 'held');
  assert.equal(heldTail.subtitleReview.candidateText, undefined);
  assert.deepEqual(getBoundFixedCuePlan(heldTail).cues, rawTail.map(row => [row.start, row.end, row.text]));
});

test('JSON and added metadata limits preserve a large valid baseline and clear all unapplied counters', () => {
  assert.equal(CONTEXT_FINALIZATION_LIMITS.maxJsonBytes, 49 * 1024 * 1024);
  const original = timed('무지를 천천히 확인했어요');
  const corrected = { ...original, text: '무늬를 천천히 확인했어요' };
  const trace = {};
  const base = refineKoreanSegmentsWithWordTimings([corrected], { originalSegments: [original], trace });
  base[0].legacyMemo = '이전 보존 데이터 '.repeat(30_000);
  assert.equal(validateSubtitleSegments(base), null);
  const baselineBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const args = { sourceSegments: [original], correctionSourceSegments: [original], correctedSegments: [corrected],
    baseSegments: base, segments: base, trace, language: 'ko' };
  for (const limits of [{ maxJsonBytes: baselineBytes - 1 }, { maxAddedJsonBytes: 1 }]) {
    const result = finalizeTranscriptionContext({ ...args, limits });
    assert.equal(result.segments, base);
    assert.deepEqual(result.summary, { cueCorrectionsApplied: 0, sourceBoundariesRestored: 0, heldCandidates: 0,
      grammarWithheld: 0, limited: true });
    assert.equal(result.segments[0].legacyMemo, base[0].legacyMemo);
    assert.equal(validateSubtitleSegments(result.segments), null);
  }
});
