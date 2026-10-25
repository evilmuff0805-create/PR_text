import assert from 'node:assert/strict';
import test from 'node:test';
import { planTranscriptionBoundaryWindows, recheckTranscriptionBoundaries,
  TRANSCRIPTION_BOUNDARY_LIMITS } from '../src/services/transcription-boundaries.js';
import { refineKoreanSegmentsWithWordTimings } from '../src/services/transcription-processing.js';
import { buildSubtitleCues } from '../src/services/subtitle.js';

const dialogue = '차분하게 준비해 주세요';
const scene = () => [
  { start: 7, end: 8, text: '앞서 말했어요' },
  { start: 10, end: 12, text: dialogue, sourceWords: [
    { word: '차분하게', start: 10, end: 11.2 },
    { word: '준비해', start: 11.2, end: 11.7 },
    { word: '주세요', start: 11.7, end: 12 },
  ] },
  { start: 14, end: 15, text: '다음 이야기예요' },
];
const contexts = () => [
  { start: 8, end: 16, indices: [1] },
  { start: 9, end: 17, indices: [1] },
];
const measured = (start = 10.6, end = 11.9) => [
  { word: '차분하게', start, end: start + .4 },
  { word: '준비해', start: start + .4, end: end - .3 },
  { word: '주세요', start: end - .3, end },
];
function provider(words, window, fields = {}) {
  return { model: 'whisper-1', language: 'korean', text: words.map((word) => word.word).join(' '),
    words: words.map((word) => ({ ...word, start: word.start - window.start, end: word.end - window.start })), ...fields };
}
function options(extra = {}) {
  return { language: 'ko', durationSeconds: 30, reviewWindows: contexts(),
    transcribeRange: async (window) => provider(measured(), window), ...extra };
}

test('boundary planning reviews one signal group in distinct bounded contexts without changing sources', () => {
  const source = scene();
  const frozen = structuredClone(source);
  const windows = planTranscriptionBoundaryWindows(source, { language: 'korean', durationSeconds: 30 });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.indices), [[1], [1]]);
  assert.notDeepEqual(windows[0], windows[1]);
  assert.ok(windows.every((window) => window.start <= 10 && window.end >= 12 && window.end - window.start <= 20));
  assert.deepEqual(source, frozen);
  assert.deepEqual(TRANSCRIPTION_BOUNDARY_LIMITS,
    { maxRequests: 3, maxWindowSeconds: 20, maxTotalSeconds: 60, consistencyToleranceSeconds: .12 });
});

test('explicit indices reach a selected group beyond earlier risks and are not fixed to a customer time', () => {
  const source = Array.from({ length: 12 }, (_, index) => ({ ...scene()[1],
    start: index * 30 + 10, end: index * 30 + 12,
    sourceWords: scene()[1].sourceWords.map((word) => ({ ...word, start: word.start + index * 30, end: word.end + index * 30 })),
  }));
  const windows = planTranscriptionBoundaryWindows(source, { language: 'ko', durationSeconds: 400, indices: [10] });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.indices), [[10], [10]]);
  assert.ok(windows.every((window) => window.start <= source[10].start && window.end >= source[10].end));
});

test('agreement is a candidate by default and preserves original word evidence', async () => {
  const source = scene();
  const frozen = structuredClone(source);
  let calls = 0;
  const result = await recheckTranscriptionBoundaries(source, options({ transcribeRange: async (window) => {
    calls += 1;
    return provider(measured(calls === 1 ? 10.6 : 10.64, calls === 1 ? 11.9 : 11.94), window);
  } }));
  assert.equal(calls, 2);
  assert.deepEqual(source, frozen);
  assert.equal(result.segments[1].text, dialogue);
  assert.equal(result.segments[1].start, 10);
  assert.equal(result.segments[1].end, 12);
  assert.deepEqual(result.segments[1].sourceWords, frozen[1].sourceWords);
  const candidate = result.candidates[0];
  assert.equal(candidate.status, 'consistent_estimate');
  assert.equal(candidate.applied, false);
  assert.equal(candidate.proposal.start, 10.64);
  assert.equal(candidate.proposal.end, 11.94);
  assert.deepEqual(candidate.original, { start: 10, end: 12, sourceWords: frozen[1].sourceWords });
  assert.equal(candidate.evidence.length, 2);
  assert.equal(candidate.timingCandidate.matchingText, dialogue);
  assert.equal(result.segments[1].subtitleReview.timingStatus, 'unverified');
  assert.deepEqual(result.scope.reviewedIndices, [1]);
  assert.equal(result.scope.coverage, 'selected_group');
});

test('explicit application uses a complete representative sequence, including shorter utterances', async () => {
  const source = scene();
  const frozen = structuredClone(source);
  let call = 0;
  const result = await recheckTranscriptionBoundaries(source, options({ applyConsistentEstimates: true,
    transcribeRange: async (window) => provider(measured(++call === 1 ? 10.6 : 10.64, call === 1 ? 11.9 : 11.88), window),
  }));
  const active = result.segments[1];
  assert.equal(active.start, 10.64);
  assert.equal(active.end, 11.88);
  assert.equal(active.sourceWords[0].start, active.start);
  assert.equal(active.sourceWords.at(-1).end, active.end);
  assert.equal(active.text, dialogue);
  assert.equal(result.candidates[0].applied, true);
  assert.deepEqual(source, frozen);
  assert.deepEqual(result.segments[0], frozen[0]);
  assert.deepEqual(result.segments[2], frozen[2]);
  const aligned = refineKoreanSegmentsWithWordTimings([active]);
  assert.equal(aligned[0].start, active.start);
  assert.equal(aligned.at(-1).end, active.end);
});

test('display holding stays at export and does not replace the measured speech end', async () => {
  const source = scene();
  source[2].start = 12.9;
  const result = await recheckTranscriptionBoundaries(source, options({ applyConsistentEstimates: true }));
  const active = result.segments[1];
  assert.equal(active.end, 11.9);
  const cues = buildSubtitleCues([active, result.segments[2]]);
  assert.equal(cues[0].end, 12.9);
  assert.equal(active.end, 11.9);
  assert.equal(buildSubtitleCues([active, result.segments[2]], { holdShortGaps: false })[0].end, 11.9);
});

test('all requested contexts participate: a conflicting third decode cannot be ignored', async () => {
  let call = 0;
  const reviewWindows = [...contexts(), { start: 7, end: 15, indices: [1] }];
  const result = await recheckTranscriptionBoundaries(scene(), options({ reviewWindows, applyConsistentEstimates: true,
    transcribeRange: async (window) => provider(measured(++call === 3 ? 11.2 : 10.6, 11.95), window),
  }));
  assert.equal(result.candidates[0].reason, 'inconsistent_boundaries');
  assert.equal(result.candidates[0].status, 'unverified');
  assert.equal(result.candidates[0].timingCandidate.status, 'unverified');
  assert.equal(result.segments[1].start, 10);
  assert.equal(result.candidates[0].evidence.length, 3);
});

test('an unmatched or failed context prevents application even when other two agree', async () => {
  for (const fail of [false, true]) {
    let call = 0;
    const result = await recheckTranscriptionBoundaries(scene(), options({
      reviewWindows: [...contexts(), { start: 7, end: 15, indices: [1] }], applyConsistentEstimates: true,
      transcribeRange: async (window) => {
        if (++call === 3) {
          if (fail) throw new Error('synthetic provider error');
          return provider([{ word: '새로운 이야기예요', start: 10.6, end: 11.9 }], window);
        }
        return provider(measured(), window);
      },
    }));
    assert.equal(result.segments[1].start, 10);
    assert.equal(result.candidates[0].status, 'unverified');
    assert.ok(result.candidates[0].suggestion);
    assert.equal(result.candidates[0].timingCandidate.status, 'unverified');
    assert.equal(result.candidates[0].timingCandidate.startSpread, undefined);
    assert.equal(result.budget.requests, 3);
  }
});

test('the inclusive consistency boundary is numerical tolerance, not an automatic fixed delay', async () => {
  for (const spread of [.12, .12001]) {
    let call = 0;
    const result = await recheckTranscriptionBoundaries(scene(), options({ applyConsistentEstimates: true,
      transcribeRange: async (window) => provider(measured(10.5 + (++call === 2 ? spread : 0), 11.8), window),
    }));
    assert.equal(result.candidates[0].status, spread === .12 ? 'consistent_estimate' : 'unverified');
    assert.equal(result.segments[1].start, spread === .12 ? 10.62 : 10);
  }
});

test('invalid words, ambiguous repeated phrases, changed text, and skipped interjections remain unverified', async () => {
  const cases = [
    [{ word: dialogue, start: 10.5, end: 10.5 }],
    [{ word: '차분하게', start: 10.6, end: 11.2 }, { word: '준비해 주세요', start: 11.1, end: 11.9 }],
    [{ word: '차분하게', start: 11, end: 11.2 }, { word: '준비해 주세요', start: 10.6, end: 10.9 }],
    [{ word: '차분하게 준비해', start: 10.6, end: 11.9 }],
    [{ word: dialogue, start: 10.1, end: 10.7 }, { word: dialogue, start: 10.8, end: 11.9 }],
    [{ word: '새로운 말로 바꿔 주세요', start: 10.6, end: 11.9 }],
    [{ word: '어', start: 10.1, end: 10.3 }, ...measured()],
  ];
  for (const words of cases) {
    const result = await recheckTranscriptionBoundaries(scene(), options({ applyConsistentEstimates: true,
      transcribeRange: async (window) => provider(words, window),
    }));
    assert.equal(result.segments[1].start, 10);
    assert.equal(result.candidates[0].status, 'unverified');
    assert.equal(result.candidates[0].timingCandidate, undefined);
  }
});

test('number signs and decimal points, and every spoken repeat, must identify the same dialogue', async () => {
  for (const [original, changed] of [
    ['3.5 킬로를 준비해요', '35 킬로를 준비해요'],
    ['-5 도로 맞춰 주세요', '5 도로 맞춰 주세요'],
    ['다시 다시 확인해 주세요', '다시 확인해 주세요'],
  ]) {
    const source = scene();
    source[1].text = original;
    const result = await recheckTranscriptionBoundaries(source, options({ applyConsistentEstimates: true,
      transcribeRange: async (window) => provider([{ word: changed, start: 10.6, end: 11.9 }], window),
    }));
    assert.equal(result.segments[1].text, original);
    assert.equal(result.segments[1].start, 10);
    assert.equal(result.candidates[0].timingCandidate, undefined);
  }
});

test('unsupported languages, recognizers, response speakers and source speakers cannot apply estimates', async () => {
  for (const fields of [{ language: 'english' }, { model: 'another-recognizer' }, { speaker: 0 },
    { segments: [{ speaker: 0 }] }]) {
    const result = await recheckTranscriptionBoundaries(scene(), options({ applyConsistentEstimates: true,
      transcribeRange: async (window) => provider(measured(), window, fields),
    }));
    assert.equal(result.segments[1].start, 10);
    assert.equal(result.candidates[0].reason, 'unsupported_response');
  }
  for (const [source, language] of [[scene(), 'en'], [scene().map((cue) => ({ ...cue, speaker: 0 })), 'ko']]) {
    let calls = 0;
    const result = await recheckTranscriptionBoundaries(source, options({ language,
      transcribeRange: async () => { calls += 1; throw new Error('must not call'); },
    }));
    assert.equal(calls, 0);
    assert.deepEqual(result.segments, source);
    assert.equal(result.scope.coverage, 'none');
  }
});

test('unseen words in response text and response word speakers invalidate the window evidence', async () => {
  for (const fields of [{ text: `${dialogue} 새로운 응답` },
    { words: [{ word: dialogue, start: 2.6, end: 3.9, speaker: 0 }] }]) {
    const result = await recheckTranscriptionBoundaries(scene(), options({ applyConsistentEstimates: true,
      transcribeRange: async (window) => provider(measured(), window, fields),
    }));
    assert.equal(result.candidates[0].status, 'unverified');
    assert.equal(result.segments[1].start, 10);
  }
});

test('source-range caps, adjacent speech and the verified audio floor bound every candidate', async () => {
  for (const kind of ['range', 'neighbour', 'floor', 'compact', 'text-review']) {
    const source = scene();
    if (kind === 'neighbour') source[2].start = 11.8;
    if (kind === 'floor') source[1].audioStartFloor = 10.8;
    if (kind === 'compact') source[1].wordAlignedCues = [[10, 12, dialogue]];
    if (kind === 'text-review') source[1].subtitleReview = { version: 1, issues: [], candidateText: '다른 문구', textStatus: 'candidate' };
    const result = await recheckTranscriptionBoundaries(source, options({ applyConsistentEstimates: true,
      transcribeRange: async (window) => provider(kind === 'range' ? measured(12.1, 13.4) : measured(), window),
    }));
    assert.equal(result.segments[1].start, 10);
    assert.equal(result.candidates[0].status, 'unverified');
    assert.equal(result.candidates[0].timingCandidate, undefined);
  }
});

test('every matching context must respect the bounds even when the latest-start representative is safe', async () => {
  for (const kind of ['previous', 'next', 'range', 'floor']) {
    const source = scene();
    if (kind === 'previous') source[0].end = 10.62;
    if (kind === 'next') source[2].start = 11.92;
    if (kind === 'floor') source[1].audioStartFloor = 10.62;
    if (kind === 'range') source[0].end = 7.9;
    let call = 0;
    const result = await recheckTranscriptionBoundaries(source, options({ applyConsistentEstimates: true,
      ...(kind === 'range' ? { reviewWindows: [{ start: 6, end: 16, indices: [1] }, { start: 7, end: 17, indices: [1] }] } : {}),
      transcribeRange: async (window) => {
        call += 1;
        const start = kind === 'range' ? (call === 1 ? 7.99 : 8.05) : (call === 1 ? 10.6 : 10.64);
        const end = kind === 'range' ? 10.05 : (kind === 'next' && call === 1 ? 11.94 : 11.9);
        return provider(measured(start, end), window);
      },
    }));
    assert.equal(result.candidates[0].status, 'unverified');
    assert.equal(result.candidates[0].reason, kind === 'range' ? 'outside_source_range'
      : kind === 'floor' ? 'below_audio_start_floor' : 'neighbour_overlap');
    assert.equal(result.candidates[0].timingCandidate, undefined);
    assert.equal(result.segments[1].start, 10);
  }
});

test('the shared budget counts failed attempts, bounds custom windows and never mutates the allowance', async () => {
  const budget = { requests: 1, seconds: 20 };
  const frozen = structuredClone(budget);
  let calls = 0;
  const result = await recheckTranscriptionBoundaries(scene(), options({ budget,
    reviewWindows: [...contexts(), { start: 7, end: 15, indices: [1] }],
    transcribeRange: async () => { calls += 1; throw new Error('synthetic failure'); },
  }));
  assert.equal(calls, 2);
  assert.deepEqual(result.budget, { requests: 3, seconds: 36 });
  assert.deepEqual(budget, frozen);
  assert.equal(result.candidates[0].status, 'unverified');
  const atCap = await recheckTranscriptionBoundaries(scene(), options({ budget: result.budget,
    transcribeRange: async () => { throw new Error('must not reach provider'); },
  }));
  assert.equal(atCap.measurements.length, 0);
  for (const badBudget of [{ requests: 2, seconds: 0 }, { requests: 0, seconds: 53 },
    { requests: -1, seconds: 0 }, { requests: 0, seconds: NaN }]) {
    const skipped = await recheckTranscriptionBoundaries(scene(), options({ budget: badBudget,
      transcribeRange: async () => { throw new Error('must not reach provider'); },
    }));
    assert.equal(skipped.measurements.length, 0);
  }
  const bounded = await recheckTranscriptionBoundaries(scene(), options({ durationSeconds: 30,
    reviewWindows: [{ start: 0, end: 20, indices: [1] }, { start: .5, end: 20.5, indices: [1] },
      { start: 1, end: 21, indices: [1] }, { start: 2, end: 22, indices: [1] }],
  }));
  assert.deepEqual(bounded.budget, { requests: 3, seconds: 60 });
});

test('duplicate or invalid contexts cannot substitute for independent evidence, and brief replies are untouched', async () => {
  for (const reviewWindows of [[contexts()[0], contexts()[0]],
    [{ start: 0, end: 21, indices: [1] }, contexts()[0]],
    [{ start: 8, end: 16, indices: [1] }, { start: 8.01, end: 16.01, indices: [1] }]]) {
    const result = await recheckTranscriptionBoundaries(scene(), options({ reviewWindows,
      transcribeRange: async () => { throw new Error('must not reach provider'); },
    }));
    assert.equal(result.measurements.length, 0);
  }
  const source = [{ start: 10, end: 10.1, text: '네', sourceWords: [] }];
  const result = await recheckTranscriptionBoundaries(source, options({ reviewWindows: undefined,
    transcribeRange: async () => { throw new Error('must not reach provider'); },
  }));
  assert.deepEqual(result.segments, source);
  assert.equal(result.measurements.length, 0);
});

test('cancellation propagates before and during a provider request', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(recheckTranscriptionBoundaries(scene(), options({ signal: cancelled.signal })), { name: 'AbortError' });
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(recheckTranscriptionBoundaries(scene(), options({ signal: controller.signal,
    transcribeRange: async (window) => { calls += 1; controller.abort(); return provider(measured(), window); },
  })), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a new mismatch cannot retain an older timing-candidate agreement', async () => {
  const source = scene();
  source[1].subtitleReview = { version: 1, issues: [], timingStatus: 'unverified', timingCandidate: {
    sourceStart: 10, sourceEnd: 12, start: 10.6, end: 11.9, matchingText: dialogue, status: 'consistent_estimate',
  } };
  const frozen = structuredClone(source);
  const result = await recheckTranscriptionBoundaries(source, options({
    transcribeRange: async (window) => provider([{ word: '다른 이야기를 해요', start: 10.6, end: 11.9 }], window),
  }));
  assert.equal(result.segments[1].subtitleReview.timingCandidate, undefined);
  assert.deepEqual(source, frozen);
});
