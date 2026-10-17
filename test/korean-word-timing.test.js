import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { alignCorrectedKoreanSegmentWithWordTimings, alignKoreanSegmentWithWordTimings } from '../src/services/korean-word-timing.js';
import { splitKoreanSubtitleText } from '../src/services/korean-subtitle.js';
import { generateSRT } from '../src/services/subtitle.js';

function sourceWithWords(text, tokens = text.split(' ')) {
  return {
    start: 0,
    end: tokens.length + 1,
    text,
    sourceWords: tokens.map((word, index) => ({ word, start: index + 0.1, end: index + 0.9 })),
  };
}

function assertPreserved(source, result, maxChars = 28) {
  assert.equal(result.aligned, true, result.reason);
  assert.equal(
    result.segments.map(({ text }) => text).join('').replace(/\s/gu, ''),
    source.text.replace(/\s/gu, ''),
  );
  for (const segment of result.segments) {
    assert.ok(segment.text.length > 0 && segment.text.length <= maxChars);
    assert.equal(/[\r\n\t]/u.test(segment.text), false);
    assert.ok(source.sourceWords.some((word) => word.start === segment.start));
    assert.ok(source.sourceWords.some((word) => word.end === segment.end));
    assert.ok(segment.end > segment.start);
  }
}

function assertFallback(source, options) {
  const result = alignKoreanSegmentWithWordTimings(source, options);
  assert.equal(result.aligned, false);
  assert.equal(result.segments.length, 1);
  assert.strictEqual(result.segments[0], source);
  assert.equal(typeof result.reason, 'string');
}

test('uses first and last spoken word edges without retaining source padding', () => {
  const source = {
    start: 3,
    end: 8,
    text: '자료를 확인해 주세요.',
    sourceWords: [
      { word: '자료를', start: 3.427, end: 3.8 },
      { word: '확인해', start: 3.9, end: 4.3 },
      { word: '주세요', start: 4.42, end: 4.781 },
    ],
  };
  assert.deepEqual(alignKoreanSegmentWithWordTimings(source), {
    aligned: true,
    segments: [{ start: 3.427, end: 4.781, text: source.text }],
  });
});

test('keeps the existing semantic plan and anchors each part to its actual words', () => {
  const source = sourceWithWords('오늘 받은 내용을 다시 확인하고 실수하지 않아야 합니다');
  const result = alignKoreanSegmentWithWordTimings(source);
  assert.deepEqual(result.segments.map(({ text }) => text), splitKoreanSubtitleText(source.text));
  assert.deepEqual(result.segments, [
    { start: 0.1, end: 4.9, text: '오늘 받은 내용을 다시 확인하고' },
    { start: 5.1, end: 7.9, text: '실수하지 않아야 합니다' },
  ]);
  assertPreserved(source, result);
});

test('splits pauses beyond 0.3 seconds without extending either cue into silence', () => {
  for (const gap of [0.3, 0.301, 1]) {
    const source = {
      start: 0,
      end: 5,
      text: '자료를 확인하면 됩니다',
      sourceWords: [
        { word: '자료를', start: 0, end: 0.1 },
        { word: '확인하면', start: 0.1 + gap, end: 1.5 },
        { word: '됩니다', start: 1.6, end: 1.7 },
      ],
    };
    const result = alignKoreanSegmentWithWordTimings(source);
    assertPreserved(source, result);
    if (gap === 0.3) assert.deepEqual(result.segments, [{ start: 0, end: 1.7, text: source.text }]);
    else assert.deepEqual(result.segments, [
      { start: 0, end: 0.1, text: '자료를' },
      { start: 0.1 + gap, end: 1.7, text: '확인하면 됩니다' },
    ]);
  }
});

test('never pads a short utterance to a minimum display duration', () => {
  const source = {
    start: 0,
    end: 2,
    text: '네!',
    sourceWords: [{ word: '네', start: 0.05, end: 0.16 }],
  };
  assert.deepEqual(alignKoreanSegmentWithWordTimings(source).segments, [
    { start: 0.05, end: 0.16, text: '네!' },
  ]);
});

test('matches API subwords, changed spacing and punctuation, mixed numbers and English', () => {
  const source = sourceWithWords('\t결과는\nAPI 3.5에서 다시 확인합니다! ', [
    '결', '과는', 'API', '3.5', '에서', '다시확인', '합니다',
  ]);
  const result = alignKoreanSegmentWithWordTimings(source);
  assertPreserved(source, result);
  assert.equal(result.segments.map(({ text }) => text).join(' '), '결과는 API 3.5에서 다시 확인합니다!');
});

test('matches NFC without rewriting the source Unicode representation', () => {
  const source = sourceWithWords('자료를 확인해요'.normalize('NFD'), ['자료를', '확인해요']);
  const result = alignKoreanSegmentWithWordTimings(source);
  assertPreserved(source, result);
  assert.equal(result.segments[0].text, source.text);
  assertFallback({ ...source, text: '자료를 확신해요'.normalize('NFD') });
});

test('moves a semantic cut to safe timed boundaries when a token spans multiple eojeol', () => {
  const source = sourceWithWords('오늘 받은 내용을 다시 확인하고 실수하지 않아야 합니다', [
    '오늘 받은', '내용을 다시', '확인하고 실수하지', '않아야 합니다',
  ]);
  const result = alignKoreanSegmentWithWordTimings(source);
  assertPreserved(source, result);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments.map(({ start, end }) => ({ start, end })), [
    { start: 0.1, end: 1.9 },
    { start: 2.1, end: 3.9 },
  ]);
  assert.equal(result.segments.some(({ text }) => /확인하고$/u.test(text)), false);
});

test('unspaced text can split only on actual API token edges', () => {
  const source = sourceWithWords('가'.repeat(60), ['가'.repeat(20), '가'.repeat(20), '가'.repeat(20)]);
  const result = alignKoreanSegmentWithWordTimings(source);
  assertPreserved(source, result);
  assert.deepEqual(result.segments.map(({ text }) => text.length), [20, 20, 20]);
  assert.deepEqual(result.segments.map(({ start, end }) => ({ start, end })), [
    { start: 0.1, end: 0.9 },
    { start: 1.1, end: 1.9 },
    { start: 2.1, end: 2.9 },
  ]);
});

test('a pause inside an eojeol uses the actual subword edge without inventing characters', () => {
  const source = {
    start: 0,
    end: 3,
    text: '확인합니다',
    sourceWords: [
      { word: '확인', start: 0.2, end: 0.4 },
      { word: '합니다', start: 1, end: 1.2 },
    ],
  };
  const result = alignKoreanSegmentWithWordTimings(source);
  assertPreserved(source, result);
  assert.deepEqual(result.segments, [
    { start: 0.2, end: 0.4, text: '확인' },
    { start: 1, end: 1.2, text: '합니다' },
  ]);
});

test('falls back if keeping an atomic timed token would exceed the one-line cap', () => {
  assertFallback(sourceWithWords('가'.repeat(29), ['가'.repeat(29)]));
  assertFallback(sourceWithWords('오늘 받은 내용을 다시 확인하고 실수하지 않아야 합니다', [
    '오늘 받은 내용을 다시 확인하고 실수하지 않아야 합니다',
  ]));
  assertFallback(sourceWithWords('짧은 표현입니다', ['짧은 표현입니다']), { maxChars: 5 });
});

test('does not accept spelling changes, missing words, reordering, or changed repeats', () => {
  const source = sourceWithWords('다시 다시 자료를 확인합니다');
  for (const text of [
    '다시 자료를 확인합니다',
    '다시 다시 다시 자료를 확인합니다',
    '다시 다시 자료를 확신합니다',
    '자료를 다시 다시 확인합니다',
    '다시 다시 자료를 확인합니다 추가',
  ]) assertFallback({ ...source, text });
  assertFallback({ ...source, sourceWords: source.sourceWords.slice(1) });
  assertFallback({ ...source, sourceWords: [...source.sourceWords].reverse() });
});

test('rejects malformed, overlapping, unordered, and out-of-source word times', () => {
  const source = sourceWithWords('자료를 확인합니다');
  const first = source.sourceWords[0];
  for (const replacement of [
    null,
    { ...first, start: null },
    { ...first, end: null },
    { ...first, start: '0.1' },
    { ...first, start: NaN },
    { ...first, end: Infinity },
    { ...first, start: -0.1 },
    { ...first, end: first.start },
    { ...first, start: 0, end: 0 },
    { ...first, end: source.end + 0.1 },
    { ...first, end: source.sourceWords[1].start + 0.001 },
    { ...first, word: null },
    { ...first, word: '...' },
  ]) assertFallback({ ...source, sourceWords: [replacement, source.sourceWords[1]] });
  assertFallback({ ...source, sourceWords: [source.sourceWords[1], first] });
  assertFallback({ ...source, sourceWords: [] });
  assertFallback({ ...source, sourceWords: null });
});

test('accepts touching word edges and strict numeric zero starts', () => {
  const source = {
    start: 0,
    end: 1,
    text: '자료를 확인해요',
    sourceWords: [
      { word: '자료를', start: 0, end: 0.2 },
      { word: '확인해요', start: 0.2, end: 0.4 },
    ],
  };
  assertPreserved(source, alignKoreanSegmentWithWordTimings(source));
  assertFallback({ ...source, start: '0' });
  assertFallback({ ...source, end: 0 });
  assertFallback({ ...source, start: null });
});

test('preserves exact fallback references and never mutates frozen inputs', () => {
  for (const source of [null, undefined, 0, {}, { text: 'English only', start: 0, end: 1 }]) {
    assertFallback(source);
  }
  const source = sourceWithWords('필요한 자료를 확인해 주세요');
  for (const word of source.sourceWords) Object.freeze(word);
  Object.freeze(source.sourceWords);
  Object.freeze(source);
  const before = JSON.stringify(source);
  assertPreserved(source, alignKoreanSegmentWithWordTimings(source));
  assertFallback(source, { maxChars: 0 });
  assertFallback(source, { maxPauseSeconds: -1 });
  assert.equal(JSON.stringify(source), before);
});

test('custom pause and character limits still use provider word edges', () => {
  const source = sourceWithWords('필요한 자료를 확인하고 결과를 전달해 주세요');
  const result = alignKoreanSegmentWithWordTimings(source, { maxChars: 12, maxPauseSeconds: 0.1 });
  assertPreserved(source, result, 12);
  assert.equal(result.segments.length, source.sourceWords.length);
});

test('a mandatory pause at an internal decimal or English dot falls back without losing that dot', () => {
  for (const [text, tokens, intact] of [
    ['자료를 3.5초 확인합니다', ['자료를', '3.', '5초', '확인합니다'], '3.5초'],
    ['자료를 U.S.A에서 확인합니다', ['자료를', 'U.', 'S.A에서', '확인합니다'], 'U.S.A에서'],
    ['자료를 example.com에서 확인합니다', ['자료를', 'example.', 'com에서', '확인합니다'], 'example.com에서'],
  ]) {
    const source = sourceWithWords(text, tokens);
    for (let index = 2; index < source.sourceWords.length; index += 1) {
      source.sourceWords[index].start += 1;
      source.sourceWords[index].end += 1;
    }
    source.end += 1;
    const result = alignKoreanSegmentWithWordTimings(source);
    assertFallback(source);
    assert.ok(generateSRT(result.segments).includes(intact));
  }
});

test('internal-dot API subwords remain aligned together when no pause forces a split', () => {
  for (const [text, tokens, intact] of [
    ['자료를 3.5초 확인합니다', ['자료를', '3.', '5초', '확인합니다'], '3.5초'],
    ['자료를 U.S.A에서 확인합니다', ['자료를', 'U.', 'S.A에서', '확인합니다'], 'U.S.A에서'],
    ['자료를 example.com에서 확인합니다', ['자료를', 'example.', 'com에서', '확인합니다'], 'example.com에서'],
  ]) {
    const source = sourceWithWords(text, tokens);
    const result = alignKoreanSegmentWithWordTimings(source);
    assertPreserved(source, result);
    assert.equal(result.segments.length, 1);
    assert.ok(generateSRT(result.segments).includes(intact));
  }
});

test('character-cap planning avoids internal-dot edges and chooses another actual timed edge', () => {
  for (const [text, tokens, intact] of [
    ['필요한 자료를 모두 준비하고 3.5초 확인한 다음 결과를 알려 주세요',
      ['필요한 자료를 모두 준비하고 3.', '5초 확인한', '다음 결과를 알려 주세요'], '3.5초'],
    ['필요한 자료를 준비하고 U.S.A에서 확인한 다음 결과를 알려 주세요',
      ['필요한 자료를 준비하고 U.', 'S.A에서 확인한', '다음 결과를 알려 주세요'], 'U.S.A에서'],
    ['자료를 준비하고 example.com에서 확인한 결과를 알려 주세요',
      ['자료를 준비하고 example.', 'com에서 확인한', '결과를 알려 주세요'], 'example.com에서'],
  ]) {
    const source = sourceWithWords(text, tokens);
    const result = alignKoreanSegmentWithWordTimings(source);
    assertPreserved(source, result);
    assert.ok(result.segments.length > 1);
    assert.ok(result.segments.some((segment) => segment.text.includes(intact)));
    assert.ok(generateSRT(result.segments.map((segment) => ({ ...segment, timingSource: 'word' }))).includes(intact));
  }
});

test('falls back when the only cap-compliant API boundary would expose an internal dot', () => {
  const left = 'a'.repeat(16);
  const right = 'b'.repeat(16);
  const source = sourceWithWords(`자료 ${left}.${right} 확인`, ['자료', `${left}.`, right, '확인']);
  assertFallback(source);
});

test('aligns a 10,000-character input without repeatedly planning every suffix', () => {
  const text = '자료 확인 '.repeat(1_666) + '확인합니다';
  const source = sourceWithWords(text);
  const startedAt = performance.now();
  const result = alignKoreanSegmentWithWordTimings(source);
  const elapsedMs = performance.now() - startedAt;
  assertPreserved(source, result);
  assert.ok(elapsedMs < 5_000, `10,000-character alignment took ${elapsedMs.toFixed(1)}ms`);
});

test('maps minimal spelling changes onto unique original word edges without mutating provider words', () => {
  for (const [before, after] of [
    ['나물을 묻혀서', '나물을 무쳐서'],
    ['몇일 걸려요', '며칠 걸려요'],
    ['설겆이할게요', '설거지할게요'],
    ['안됬어', '안됐어'],
    ['내일 뵈어요', '내일 봬요'],
    ['내일 봬요', '내일 뵈어요'],
    ['3.5kg이면 되요', '3.5 kg이면 돼요'],
    ['네 네네 되요', '네 네네 돼요'],
    ['무 무 묻혀서', '무 무 무쳐서'],
  ]) {
    const source = sourceWithWords(before);
    for (const word of source.sourceWords) Object.freeze(word);
    Object.freeze(source.sourceWords);
    Object.freeze(source);
    const snapshot = structuredClone(source);
    const corrected = Object.freeze({ ...source, text: after });
    const result = alignCorrectedKoreanSegmentWithWordTimings(source, corrected);
    assert.equal(result.correctionRetained, true, before);
    assert.equal(result.text, after);
    assertPreserved({ ...source, text: after }, result);
    assert.deepEqual(source, snapshot);
    assert.equal(corrected.sourceWords, source.sourceWords);
  }
});

test('retains original timed cues for repeated-word insertions or deletions with ambiguous minimal paths', () => {
  for (const [before, after] of [
    ['가 가고 되요 확인했습니다', '가고 돼요 확인했습니다'],
    ['가고 되요 확인합니다', '가 가고 돼요 확인합니다'],
    ['편안하게 생각하면 됩니다', '차분하게 생각하면 됩니다'],
    ['학교에서 확인합니다', '학무에서 확인합니다'],
    ['학교에서 확인합니다', '학무무에서 확인합니다'],
    ['학교에서 확인합니다', '학무 확인합니다'],
    ['학교에서 내용을 확인합니다', '학무무에서 내용을 확인합니다'],
  ]) {
    const source = sourceWithWords(before);
    const expected = alignKoreanSegmentWithWordTimings(source);
    const result = alignCorrectedKoreanSegmentWithWordTimings(source, { ...source, text: after });
    assert.equal(result.aligned, true);
    assert.equal(result.correctionRetained, false);
    assert.equal(result.reason, 'ambiguous-correction-boundary');
    assert.deepEqual(result.segments, expected.segments);
    assert.equal(result.text, before);
    assert.ok(result.segments[0].start > source.start);
  }
});

test('normalizes NFD only for mapping while preserving corrected Unicode and timed edges', () => {
  const before = '나물을 묻혀서'.normalize('NFD');
  const after = '나물을 무쳐서'.normalize('NFD');
  const source = sourceWithWords(before);
  const result = alignCorrectedKoreanSegmentWithWordTimings(source, { ...source, text: after });
  assert.equal(result.correctionRetained, true);
  assert.equal(result.text, after);
  assertPreserved({ ...source, text: after }, result);
  assert.equal(source.text, before);
  assert.equal(source.sourceWords[1].word, '묻혀서'.normalize('NFD'));
});

test('corrected decimal and English-dot subwords stay together at real timed boundaries', () => {
  for (const [value, fragments] of [
    ['3.5kg', ['3.', '5kg']],
    ['U.S.A', ['U.', 'S.', 'A']],
    ['example.com', ['example.', 'com']],
  ]) {
    const prefix = '가나다라마바사아자차카타파하가나다라마바';
    const before = `${prefix} ${value} 되요`;
    const source = sourceWithWords(before, [prefix, ...fragments, '되요']);
    const result = alignCorrectedKoreanSegmentWithWordTimings(source, { ...source, text: before.replace('되요', '돼요') });
    assert.equal(result.correctionRetained, true, value);
    assert.ok(result.segments.some((cue) => cue.text.includes(value)));
    assertPreserved({ ...source, text: before.replace('되요', '돼요') }, result);
    assert.ok(generateSRT(result.segments).includes(value));
  }
});

test('a longer corrected atomic word restores original timed text instead of proportional splitting', () => {
  const before = `${'가'.repeat(26)}봬요`;
  const source = sourceWithWords(before, [before]);
  const result = alignCorrectedKoreanSegmentWithWordTimings(source, { ...source, text: `${'가'.repeat(26)}뵈어요` });
  assert.equal(result.correctionRetained, false);
  assert.equal(result.reason, 'no-safe-boundary');
  assertPreserved(source, result);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].start, source.sourceWords[0].start);
});

test('missing or invalid original words never become claimed correction-aligned times', () => {
  for (const patch of [
    { sourceWords: [] },
    { sourceWords: [{ word: '되요', start: 0.1, end: 0.1 }] },
    { sourceWords: [{ word: '다른말', start: 0.1, end: 0.9 }] },
  ]) {
    const source = { ...sourceWithWords('되요'), ...patch };
    const corrected = { ...source, text: '돼요' };
    const result = alignCorrectedKoreanSegmentWithWordTimings(source, corrected);
    assert.equal(result.aligned, false);
    assert.equal(result.segments[0], corrected);
    assert.equal(result.segments[0].start, source.start);
  }
});

test('a verified digital-silence prefix limits starts without modifying source or word timestamps', () => {
  const source = { start: 0, end: 4, text: '드릴께요', audioStartFloor: 2, sourceWords: [{ word: '드릴께요', start: 1.62, end: 2.4 }] };
  const snapshot = structuredClone(source);
  const result = alignCorrectedKoreanSegmentWithWordTimings(source, { ...source, text: '드릴게요' });
  assert.equal(result.aligned, true);
  assert.equal(result.correctionRetained, true);
  assert.deepEqual(result.segments, [{ start: 2, end: 2.4, text: '드릴게요' }]);
  assert.deepEqual(source, snapshot);
});

test('word cues wholly before the verified prefix floor retain every word in a source-range fallback', () => {
  const source = {
    start: 0, end: 4, text: '네 설명합니다', audioStartFloor: 2,
    sourceWords: [{ word: '네', start: 1, end: 1.2 }, { word: '설명합니다', start: 2.2, end: 3 }],
  };
  const result = alignKoreanSegmentWithWordTimings(source);
  assert.equal(result.aligned, false);
  assert.equal(result.reason, 'audio-floor-outside-word-range');
  assert.equal(result.segments.length, 1);
  assert.deepEqual(result.segments[0], { ...source, start: 2, timingSource: 'audio-range' });
  assert.equal(source.start, 0);
  assert.equal(source.sourceWords[0].start, 1);
});

test('invalid audio floors do not fabricate new timings', () => {
  for (const floor of [null, '', '2', false, NaN, Infinity, -1, 4, 5]) {
    const source = { start: 0, end: 4, text: '자료를 확인합니다', audioStartFloor: floor, sourceWords: [] };
    const result = alignKoreanSegmentWithWordTimings(source);
    assert.equal(result.aligned, false);
    assert.equal(result.segments[0], source);
    assert.equal(result.segments[0].start, 0);
  }
});

test('bounded edit alignment handles 10,000 characters and 10,000 words without quadratic storage', () => {
  const text = '가나다라마바사아자차'.repeat(1000);
  assert.equal(text.length, 10_000);
  const source = {
    start: 0, end: 30, text,
    sourceWords: Array.from(text, (word, index) => ({ word, start: 2 + index * 0.002, end: 2.001 + index * 0.002 })),
  };
  const corrected = { ...source, text: `${text.slice(0, 5000)}까${text.slice(5001)}` };
  const result = alignCorrectedKoreanSegmentWithWordTimings(source, corrected);
  assert.equal(result.correctionRetained, true);
  assertPreserved(corrected, result);
  assert.equal(result.segments[0].start, 2);
  const atomicText = text.slice(0, 9_936);
  const expandedText = `${atomicText.slice(0, 5000)}${'하'.repeat(64)}${atomicText.slice(5000)}`;
  const atomic = { start: 0, end: 30, text: atomicText, sourceWords: [{ word: atomicText, start: 2, end: 22 }] };
  const expanded = alignCorrectedKoreanSegmentWithWordTimings(atomic, { ...atomic, text: expandedText }, { maxChars: 10_000 });
  assert.equal(expanded.correctionRetained, true);
  assert.deepEqual(expanded.segments, [{ start: 2, end: 22, text: expandedText }]);
});
