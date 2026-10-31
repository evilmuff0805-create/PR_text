import assert from 'node:assert/strict';
import test from 'node:test';
import * as fixed from '../src/services/fixed-cue-plan.js';
import * as review from '../client/src/utils/subtitle-review.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import { buildSubtitleCues, generateSRT, generateASS, generateTXT } from '../src/services/subtitle.js';
import { validateSubtitleSegments } from '../src/services/subtitle-payload.js';
import { createBatchSrtArchive } from '../src/services/batch-archive.js';
import { planCueWindowCorrection, finalizeTranscriptionContext } from '../src/services/context-finalization.js';
import { alignCorrectedKoreanSegmentWithWordTimings } from '../src/services/korean-word-timing.js';
import { refineKoreanSegmentsWithWordTimings, processTranscriptionSegments } from '../src/services/transcription-processing.js';

// The independent acceptance contract was sealed before these tests ran.
// Only anonymous synthetic text belongs in repository tests.
const compact = rows => rows.map(({ text, start, end, speaker }) => ({ text, start, end, speaker }));
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; };
const binding = row => ({ text: row.text, start: row.start, end: row.end });
const fixture = () => {
  const current = { text: '가벼운 합성 문장입니다', start: 2, end: 4, timingSource: 'speech_window' };
  const original = { text: '가벼운 합성 문쟝입니다', start: 2, end: 4,
    cues: [[2, 2.4, '가벼운'], [3.2, 4, '합성 문쟝입니다']] };
  return { ...current, fixedCuePlan: { version: 1, binding: binding(current),
    cues: [[2, 2.4, '가벼운'], [3.2, 4, '합성 문장입니다']], original },
  subtitleReview: { version: 1, issues: [{ code: 'cue_window_correction_applied' }],
    originalText: original.text, originalTiming: { start: 2, end: 4 },
    correctionStatus: 'cue_applied', correctionBinding: binding(current) } };
};

test('independent context QA: fixed plans normalize data without mutating the bound source', () => {
  const source = fixture(), before = structuredClone(source);
  const normalized = fixed.normalizeFixedCuePlan(source.fixedCuePlan);
  assert.deepEqual(normalized, source.fixedCuePlan);
  assert.notEqual(normalized, source.fixedCuePlan);
  assert.notEqual(normalized.cues, source.fixedCuePlan.cues);
  assert.deepEqual(fixed.getBoundFixedCuePlan(source), source.fixedCuePlan);
  assert.equal(fixed.getBoundCorrectionStatus(source), 'cue_applied');
  assert.deepEqual(source, before);
});

test('independent context QA: nonnumeric, zero-length, overlapping, outside and mismatched plan parts fail closed', () => {
  const source = fixture(), plan = source.fixedCuePlan;
  const cases = [
    {}, { ...plan, version: 2 },
    { ...plan, binding: { ...plan.binding, start: '2' } },
    { ...plan, binding: { ...plan.binding, end: NaN } },
    { ...plan, cues: [[2, 2, '가벼운'], plan.cues[1]] },
    { ...plan, cues: [[2, 3.3, '가벼운'], plan.cues[1]] },
    { ...plan, cues: [[2.1, 2.4, '가벼운'], plan.cues[1]] },
    { ...plan, cues: [plan.cues[0], [3.2, 4.1, '합성 문장입니다']] },
    { ...plan, cues: [plan.cues[0], [3.2, 4, '다른 문장입니다']] },
    { ...plan, original: { ...plan.original, cues: [] } },
  ];
  for (const value of cases) assert.equal(fixed.normalizeFixedCuePlan(value), undefined);
  const text = '가'.repeat(29);
  assert.equal(fixed.normalizeFixedCuePlan({ version: 1, binding: { text, start: 0, end: 1 }, cues: [[0, 1, text]] }), undefined);
});

test('independent context QA: exact text and numeric binding prevent stale plans and false confirmation', () => {
  const source = fixture();
  for (const changed of [{ ...source, text: source.text.replace('가벼운', '새로운') },
    { ...source, start: source.start + 1e-12 }, { ...source, end: source.end - 1e-12 }]) {
    assert.equal(fixed.getBoundFixedCuePlan(changed), undefined);
    assert.equal(fixed.getBoundCorrectionStatus(changed), undefined);
    assert.equal(fixed.restoreFixedCuePlan(changed), changed);
  }
  for (const speaker of [0, 1, 'provider-a']) assert.equal(fixed.getBoundFixedCuePlan({ ...source, speaker }), undefined);
  assert.equal(source.timingSource, 'speech_window');
  assert.notEqual(source.timingSource, 'word');
  assert.notEqual(source.timingSource, 'manual');
});

test('independent context QA: restoration retains exact original cue windows and discards active stale word evidence', () => {
  const source = { ...fixture(), sourceWords: [{ word: 'stale', start: 2, end: 4 }],
    wordAlignedCues: [[2, 4, 'stale']] }, before = structuredClone(source);
  const restored = fixed.restoreFixedCuePlan(source);
  assert.equal(restored.text, source.fixedCuePlan.original.text);
  assert.deepEqual([restored.start, restored.end], [2, 4]);
  assert.deepEqual(fixed.getBoundFixedCuePlan(restored).cues, source.fixedCuePlan.original.cues);
  assert.equal(fixed.getBoundCorrectionStatus(restored), 'restored');
  assert.equal(restored.timingSource, 'speech_window');
  assert.equal(Object.hasOwn(restored, 'sourceWords'), false);
  assert.equal(Object.hasOwn(restored, 'wordAlignedCues'), false);
  assert.deepEqual(source, before);
});

test('independent context QA: fixed windows survive export without character-proportional redistribution', () => {
  const source = fixture();
  assert.deepEqual(compact(buildSubtitleCues([source], { holdShortGaps: false })), [
    { start: 2, end: 2.4, text: '가벼운', speaker: undefined },
    { start: 3.2, end: 4, text: '합성 문장입니다', speaker: undefined },
  ]);
  assert.match(generateSRT([source], null, { holdShortGaps: false }), /00:00:02,000 --> 00:00:02,400/);
  assert.match(generateSRT([source], null, { holdShortGaps: false }), /00:00:03,200 --> 00:00:04,000/);
  assert.match(generateASS([source], { holdShortGaps: false }), /0:00:02\.00,0:00:02\.40/);
  assert.equal(generateTXT([source]), source.text);
  assert.equal(buildSubtitleCues([source])[0].end, 3.2);
  assert.deepEqual(source.fixedCuePlan.cues, [[2, 2.4, '가벼운'], [3.2, 4, '합성 문장입니다']]);
});

test('independent context QA: stale fixed metadata never restores an old phrase on export', () => {
  const source = fixture(), edited = { ...source, text: '수동으로 바꾼 합성 문장입니다' };
  const result = generateSRT([edited], null, { holdShortGaps: false });
  assert.ok(result.includes(edited.text));
  assert.equal(result.includes(source.text), false);
  assert.equal(result.includes(source.fixedCuePlan.original.text), false);
});

test('independent context QA: manual text and time changes invalidate automatic fixed status and held candidates', () => {
  const source = fixture();
  const edited = review.editSubtitleText(source, '직접 수정한 합성 문장입니다');
  assert.equal(fixed.getBoundFixedCuePlan(edited), undefined);
  assert.equal(review.getSubtitleCorrectionStatus(edited), undefined);
  const timed = review.confirmSubtitleTiming(source, 2.1, 4);
  assert.equal(fixed.getBoundFixedCuePlan(timed), undefined);
  assert.equal(review.getSubtitleCorrectionStatus(timed), undefined);
  const held = { ...source, fixedCuePlan: undefined, subtitleReview: { ...source.subtitleReview,
    correctionStatus: 'held', candidateText: '보류된 자동 합성 후보', textStatus: 'candidate',
    issues: [{ code: 'finalization_candidate_held' }] } };
  const changed = review.editSubtitleText(held, '새 수동 합성 문장입니다');
  assert.equal(review.getSubtitleCorrectionStatus(changed), undefined);
  assert.equal(changed.subtitleReview?.candidateText, undefined);
});

test('independent context QA: owner/log-scoped drafts and JSON round trips retain the current fixed plan', () => {
  const original = fixture(), source = fixed.restoreFixedCuePlan(original), store = storage();
  assert.deepEqual(fixed.getBoundFixedCuePlan(JSON.parse(JSON.stringify(original))), original.fixedCuePlan);
  drafts.writeResultDraft(store, 'context-qa-owner', 4701, { segments: [original], fullTextDraft: original.text,
    baseText: source.text, baseSignature: review.subtitleEditSignature([source]) });
  const restored = drafts.readResultDraft(store, 'context-qa-owner', 4701, [source]);
  assert.ok(restored);
  assert.deepEqual(fixed.getBoundFixedCuePlan(restored.segments[0]), original.fixedCuePlan);
  assert.equal(drafts.readResultDraft(store, 'another-owner', 4701, [source]), null);
  assert.equal(drafts.readResultDraft(store, 'context-qa-owner', 4702, [source]), null);
});

test('independent context QA: more than 5000 fixed cues stay compact and preserve each recorded boundary', () => {
  const make = (offset, word) => {
    const cues = Array.from({ length: 3000 }, (_, index) => [offset + index * .02, offset + index * .02 + .01, word]);
    const text = cues.map(cue => cue[2]).join(' '), start = cues[0][0], end = cues.at(-1)[1];
    return { text, start, end, timingSource: 'speech_window', fixedCuePlan: { version: 1, binding: { text, start, end }, cues } };
  };
  const sources = [make(0, '가'), make(60, '나')], before = JSON.stringify(sources);
  assert.equal(validateSubtitleSegments(sources), null);
  const actual = buildSubtitleCues(sources, { holdShortGaps: false });
  assert.equal(actual.length, 6000);
  assert.deepEqual(actual.map(({ start, end, text }) => [start, end, text]), sources.flatMap(source => source.fixedCuePlan.cues));
  assert.equal(sources.length, 2);
  assert.equal(JSON.stringify(sources), before);
});

test('independent context QA: fixed cue gap holding still obeys an excluded interval barrier', () => {
  const source = fixture(), excluded = { text: '제외할 합성 구간', start: 4.1, end: 4.3 };
  excluded.subtitleReview = { version: 1, issues: [], localExclusion: { version: 1, status: 'user', reason: 'user_selection', binding: binding(excluded) } };
  const next = { text: '뒤의 정상 합성 대사', start: 4.6, end: 5 };
  const actual = buildSubtitleCues([source, excluded, next]);
  assert.equal(actual.length, 3);
  assert.equal(actual[0].end, 3.2);
  assert.equal(actual[1].end, 4);
  assert.equal(actual[2].start, 4.6);
  assert.equal(generateSRT([source, excluded, next]).includes(excluded.text), false);
});

test('independent context QA: ZIP uses fixed windows and batch policy without single short-gap holds', () => {
  const source = fixture();
  const archive = createBatchSrtArchive({ items: [{ status: 'completed', label: 'synthetic-context', segments: [source] }] });
  assert.equal(archive.includedSrtCount, 1);
  const size = archive.buffer.readUInt32LE(18), name = archive.buffer.readUInt16LE(26), extra = archive.buffer.readUInt16LE(28);
  const begin = 30 + name + extra, srt = archive.buffer.toString('utf8', begin, begin + size);
  assert.equal(srt, generateSRT([source], null, { holdShortGaps: false }));
  assert.match(srt, /00:00:02,000 --> 00:00:02,400/);
});

const timedSynthetic = (text, start = 1, end = 4) => {
  const words = text.split(' '), width = (end - start) / words.length;
  return { text, start, end, sourceWords: words.map((word, index) => ({ word,
    start: start + index * width, end: start + (index + 1) * width })) };
};
const runFinalizer = (source, corrected, { raw = [source], grammar } = {}) => {
  const trace = {}, base = refineKoreanSegmentsWithWordTimings([corrected], { originalSegments: [source], trace });
  const current = grammar ? grammar(base) : base;
  return finalizeTranscriptionContext({ sourceSegments: raw, correctionSourceSegments: [source],
    correctedSegments: [corrected], baseSegments: base, segments: current, trace, language: 'ko' });
};

test('independent context QA: a unique ambiguous spelling uses only its verified original cue window', () => {
  const source = timedSynthetic('무지를 천천히 확인했어요'), corrected = { ...source, text: '무늬를 천천히 확인했어요' };
  const before = structuredClone(source);
  assert.equal(alignCorrectedKoreanSegmentWithWordTimings(source, corrected).correctionRetained, false);
  const result = runFinalizer(source, corrected), row = result.segments[0];
  assert.equal(row.text, corrected.text);
  assert.equal(row.timingSource, 'speech_window');
  assert.deepEqual([row.start, row.end], [source.start, source.end]);
  assert.equal(fixed.getBoundCorrectionStatus(row), 'cue_applied');
  assert.deepEqual(fixed.getBoundFixedCuePlan(row).original.cues, [[1, 4, source.text]]);
  assert.equal(fixed.restoreFixedCuePlan(row).text, source.text);
  assert.deepEqual(source, before);
});

test('independent context QA: independent negative markers cannot be replaced while rescuing spelling', () => {
  for (const [text, candidate] of [
    ['무지를 안 확인했어요', '무늬를 다 확인했어요'],
    ['무지를 못 확인했어요', '무늬를 또 확인했어요'],
    ['무지를 안 확인했어요', '무늬를 잘 확인했어요'],
  ]) {
    const source = timedSynthetic(text), corrected = { ...source, text: candidate };
    assert.equal(alignCorrectedKoreanSegmentWithWordTimings(source, corrected).correctionRetained, false);
    assert.equal(planCueWindowCorrection(source, corrected).accepted, false);
    const result = runFinalizer(source, corrected);
    assert.equal(result.segments[0].text, text);
    assert.equal(result.summary.cueCorrectionsApplied, 0);
  }
});

test('independent context QA: missing or duplicate raw ownership never authorizes a correction', () => {
  const source = timedSynthetic('무지를 천천히 확인했어요'), corrected = { ...source, text: '무늬를 천천히 확인했어요' };
  for (const raw of [[], [source, structuredClone(source)]]) {
    const result = runFinalizer(source, corrected, { raw });
    assert.equal(result.segments[0].text, source.text);
    assert.equal(result.summary.cueCorrectionsApplied, 0);
    assert.equal(fixed.getBoundCorrectionStatus(result.segments[0]), 'held');
  }
});

test('independent context QA: numbers, repetitions, tone and multi-cue ownership remain guarded', () => {
  for (const [text, candidate] of [
    ['무지를 3개 확인했어요', '무늬를 4개 확인했어요'],
    ['아니 아니 무지를 봤어요', '아니 무늬를 봤어요'],
    ['무지를 천천히 확인합니다', '무늬를 천천히 확인해요'],
  ]) {
    const source = timedSynthetic(text);
    assert.equal(planCueWindowCorrection(source, { ...source, text: candidate }).accepted, false);
  }
  const source = timedSynthetic('무지를 확인하고 뒤쪽 자료를 보았어요', 1, 5);
  for (let index = 2; index < source.sourceWords.length; index++) {
    source.sourceWords[index].start += .5; source.sourceWords[index].end += .5;
  }
  source.end += .5;
  const single = planCueWindowCorrection(source, { ...source, text: '무늬를 확인하고 뒤쪽 자료를 보았어요' });
  assert.equal(single.accepted, true);
  assert.deepEqual(single.cues.map(c => [c.start, c.end]), single.originalCues.map(c => [c.start, c.end]));
  assert.equal(planCueWindowCorrection(source, { ...source, text: '무늬를 확인하고 뒤쪽 차료를 보았어요' }).accepted, false);
});

test('independent context QA: stale grammar text is retained and never overwritten by an older candidate', () => {
  const source = timedSynthetic('무지를 천천히 확인했어요'), corrected = { ...source, text: '무늬를 천천히 확인했어요' };
  const result = runFinalizer(source, corrected, { grammar: base => [{ ...base[0],
    text: '표면의 무늬를 확인했어요', grammarPolish: { status: 'applied' } }] });
  assert.equal(result.segments[0].text, '표면의 무늬를 확인했어요');
  assert.equal(result.segments[0].fixedCuePlan, undefined);
  assert.equal(fixed.getBoundCorrectionStatus(result.segments[0]), 'held');
  assert.equal(result.summary.cueCorrectionsApplied, 0);
  assert.notEqual(result.segments[0].subtitleReview?.candidateText, corrected.text);
});

test('independent context QA: equal-start competing grammar blocks fail closed without cross-block replacement', () => {
  const source = timedSynthetic('무지를 천천히 확인했어요'), other = timedSynthetic('동시에 남긴 합성 문장', 1, 4);
  const corrected = [{ ...source, text: '무늬를 천천히 확인했어요' }, other], trace = {};
  const base = refineKoreanSegmentsWithWordTimings(corrected, { originalSegments: [source, other], trace });
  const current = base.map(row => ({ ...row })), snapshot = structuredClone(current);
  const result = finalizeTranscriptionContext({ sourceSegments: [source, other], correctionSourceSegments: [source, other],
    correctedSegments: corrected, baseSegments: base, segments: current, trace, language: 'ko' });
  assert.deepEqual(result.segments, snapshot);
  assert.equal(result.summary.cueCorrectionsApplied, 0);
  assert.equal(result.summary.limited, true);
});

test('independent context QA: separate short turns survive while one-source continuations and short cues remain intact', async () => {
  const sources = [timedSynthetic('지금은 서류를 정리하고', 1, 2), timedSynthetic('아니 그건요', 2, 2.5),
    timedSynthetic('다른 방법으로 볼게요', 2.5, 4), timedSynthetic('네', 5, 5.1)];
  const captured = [];
  const result = await processTranscriptionSegments(sources, 'ko', { correct: async (text, language, context) => {
    captured.push({ text, language, context }); return text;
  } });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].text, sources.map(row => row.text).join('\n'));
  assert.deepEqual(result.segments.map(row => [row.start, row.end, row.text]), sources.map(row => [row.start, row.end, row.text]));
  assert.equal(result.contextFinalization.sourceBoundariesRestored, 1);
  const single = timedSynthetic('서류를 정리하고 남은 일을 확인하는 거예요', 7, 11);
  const prior = refineKoreanSegmentsWithWordTimings([single], { originalSegments: [single] });
  const next = await processTranscriptionSegments([single], 'ko', { correct: async text => text });
  assert.deepEqual(compact(next.segments), compact(prior));
  assert.ok(result.segments.at(-1).end - result.segments.at(-1).start < .11);
});

test('independent context QA: English and any speaker-labelled array bypass Korean finalization', () => {
  const source = timedSynthetic('무지를 천천히 확인했어요'), corrected = { ...source, text: '무늬를 천천히 확인했어요' };
  for (const [language, segments] of [['en', [source]], ['ko', [{ ...source, speaker: 0 }]], ['ko', [source, { ...source, speaker: 1 }]]]) {
    const result = finalizeTranscriptionContext({ sourceSegments: [source], correctionSourceSegments: [source],
      correctedSegments: [corrected], segments, language });
    assert.equal(result.segments, segments);
    assert.equal(result.summary.cueCorrectionsApplied, 0);
  }
});

test('independent context QA: confirming the same times keeps fixed internals and records a separate manual confirmation', () => {
  const source = fixture(), result = review.confirmSubtitleTiming(source, source.start, source.end);
  assert.deepEqual(fixed.getBoundFixedCuePlan(result), source.fixedCuePlan);
  assert.equal(result.timingSource, 'manual');
  assert.equal(review.getSubtitleTimingConfirmation(result)?.status, 'confirmed');
  assert.equal(review.getSubtitleCorrectionStatus(result), 'cue_applied');
  assert.deepEqual(buildSubtitleCues([result], { holdShortGaps: false }).map(c => [c.start, c.end]), [[2, 2.4], [3.2, 4]]);
});

test('independent context QA: repacking beyond 5000 rows retains applied restoration and exact compact binding', () => {
  const first = timedSynthetic('무지를 천천히 확인했어요', 0, 1);
  const normal = Array.from({ length: 4998 }, (_, index) => timedSynthetic('일반 합성 자료', 2 + index * 2, 3 + index * 2));
  const left = timedSynthetic('마지막 자료를 확인하고', 10000, 10001), right = timedSynthetic('아니 그렇군요', 10001, 10002);
  const sources = [first, ...normal, left, right], corrected = sources.map((row, index) => index ? row : { ...row, text: '무늬를 천천히 확인했어요' });
  const baseline = [first, ...normal, { text: left.text + ' ' + right.text, start: left.start, end: right.end, timingSource: 'word' }];
  const trace = { compact: false, blocks: sources.slice(0, -2).map((row, index) => ({ sourceStartIndex: index, sourceEndIndex: index, flatCount: 1 })) };
  trace.blocks.push({ sourceStartIndex: 4999, sourceEndIndex: 5000, flatCount: 1 });
  const result = finalizeTranscriptionContext({ sourceSegments: sources, correctionSourceSegments: sources,
    correctedSegments: corrected, baseSegments: baseline, segments: baseline, trace, language: 'ko' });
  assert.equal(result.segments.length, 5000);
  assert.equal(result.summary.cueCorrectionsApplied, 1);
  assert.equal(result.summary.sourceBoundariesRestored, 1);
  assert.equal(result.summary.limited, false);
  const applied = result.segments[0], compactTail = result.segments.at(-1);
  assert.equal(fixed.restoreFixedCuePlan(applied).text, first.text);
  assert.deepEqual(fixed.getBoundFixedCuePlan(compactTail).cues, [[10000, 10001, left.text], [10001, 10002, right.text]]);
  assert.equal(validateSubtitleSegments(result.segments), null);
});

test('independent context QA: global fixed metadata overflow returns the untouched baseline with zero applied counts', () => {
  const first = timedSynthetic('무지를 천천히 확인했어요', 0, 1);
  const large = Array.from({ length: 10 }, (_, group) => {
    const cues = Array.from({ length: 2500 }, (_, index) => [10 + group * 60 + index * .02, 10 + group * 60 + index * .02 + .01, '가']);
    const text = cues.map(cue => cue[2]).join(' '), start = cues[0][0], end = cues.at(-1)[1];
    return { text, start, end, timingSource: 'speech_window', fixedCuePlan: { version: 1, binding: { text, start, end }, cues,
      original: { text, start, end, cues } } };
  });
  const sources = [first, ...large.map(({ text, start, end }) => ({ text, start, end }))];
  const corrected = sources.map((row, index) => index ? row : { ...row, text: '무늬를 천천히 확인했어요' });
  const baseline = [first, ...large], snapshot = structuredClone(baseline);
  assert.equal(validateSubtitleSegments(baseline), null);
  const trace = { compact: true, blocks: sources.map((row, index) => ({ sourceStartIndex: index, sourceEndIndex: index, flatCount: 1 })) };
  const result = finalizeTranscriptionContext({ sourceSegments: sources, correctionSourceSegments: sources,
    correctedSegments: corrected, baseSegments: baseline, segments: baseline, trace, language: 'ko' });
  assert.equal(result.segments, baseline);
  assert.deepEqual(result.segments, snapshot);
  assert.deepEqual(result.summary, { cueCorrectionsApplied: 0, sourceBoundariesRestored: 0, heldCandidates: 0, grammarWithheld: 0, limited: true });
});

test('independent context QA: final JSON and added metadata limits fail closed before reporting applied work', () => {
  const source = timedSynthetic('무지를 천천히 확인했어요'), corrected = { ...source, text: '무늬를 천천히 확인했어요' };
  const trace = {}, base = refineKoreanSegmentsWithWordTimings([corrected], { originalSegments: [source], trace });
  const invoke = limits => finalizeTranscriptionContext({ sourceSegments: [source], correctionSourceSegments: [source],
    correctedSegments: [corrected], baseSegments: base, segments: base, trace, language: 'ko', limits });
  assert.equal(invoke().summary.cueCorrectionsApplied, 1);
  for (const limits of [{ maxJsonBytes: 0 }, { maxAddedJsonBytes: 0 }]) {
    const result = invoke(limits);
    assert.equal(result.segments, base);
    assert.deepEqual(result.summary, { cueCorrectionsApplied: 0, sourceBoundariesRestored: 0,
      heldCandidates: 0, grammarWithheld: 0, limited: true });
  }
});

test('independent context QA: equal-length synonyms and unrelated predicate stems are not spelling evidence', () => {
  for (const [text, candidate] of [
    ['잠시 편안하게 기다려요', '잠시 차분하게 기다려요'],
    ['자료를 조금 살펴봤어요', '자료를 아주 살펴봤어요'],
    ['자료를 모두 버렸어요', '자료를 모두 살렸어요'],
    ['간식을 조금 먹었어요', '간식을 조금 찍었어요'],
    ['무지를 천천히 확인했어요', '무늬를 꼼꼼히 확인했어요'],
  ]) {
    const source = timedSynthetic(text), corrected = { ...source, text: candidate };
    assert.equal(planCueWindowCorrection(source, corrected).accepted, false, `${text} -> ${candidate}`);
  }
});

test('independent context QA: equal-start fixed sources remain separate and overlap clamping preserves stored windows', () => {
  const make = (text, start, end) => ({ text, start, end, timingSource: 'speech_window',
    fixedCuePlan: { version: 1, binding: { text, start, end }, cues: [[start, end, text]] } });
  const equal = [make('첫 번째 합성 대사', 1, 2), make('두 번째 합성 대사', 1, 3)];
  assert.deepEqual(buildSubtitleCues(equal, { holdShortGaps: false }).map(row => [row.start, row.end, row.text]),
    equal.map(row => [row.start, row.end, row.text]));
  const overlap = [make('앞의 합성 대사', 4, 5.7), make('뒤의 합성 대사', 5.5, 6)], snapshot = structuredClone(overlap);
  assert.deepEqual(buildSubtitleCues(overlap, { holdShortGaps: false }).map(row => [row.start, row.end]), [[4, 5.5], [5.5, 6]]);
  assert.deepEqual(overlap, snapshot);
  assert.deepEqual(fixed.getBoundFixedCuePlan(overlap[0]).cues, [[4, 5.7, overlap[0].text]]);
});
