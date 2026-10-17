import assert from 'node:assert/strict';
import test from 'node:test';
import { generateASS, generateSRT, SUBTITLE_MAX_CHARS } from '../src/services/subtitle.js';

function seconds(value) {
  const [hours, minutes, rest] = value.replace(',', '.').split(':').map(Number);
  return hours * 3600 + minutes * 60 + rest;
}

function readCues(format, segments, options = {}) {
  if (format === 'srt') {
    return generateSRT(segments, null, options).split('\n\n').slice(1).filter(Boolean).map((block) => {
      const [, range, text] = block.split('\n');
      const [start, end] = range.split(' --> ').map(seconds);
      return { start, end, text };
    });
  }
  return generateASS(segments, options).split('\n').filter((line) => line.startsWith('Dialogue:'))
    .map((line) => {
      const fields = line.split(',');
      return { start: seconds(fields[1]), end: seconds(fields[2]), text: fields.slice(9).join(',') };
    });
}

function assertOrdinaryTimeline(cues) {
  for (let index = 0; index < cues.length; index += 1) {
    assert.ok(cues[index].end > cues[index].start, 'every dialogue has positive duration');
    assert.ok(cues[index].text.length <= SUBTITLE_MAX_CHARS, 'every dialogue respects the cap');
    if (index > 0) assert.ok(cues[index - 1].end <= cues[index].start, 'dialogue must not overlap');
  }
}

const front = '편안하게 생각이 흐르는 대로';
const back = '경험을 통해 떠올리면 됩니다';
const sentence = `${front} ${back}`;

test('ordinary Korean exports keep the final dependent predicate with its phrase', () => {
  const input = [{ start: 3, end: 9, text: sentence }];
  const before = structuredClone(input);
  for (const format of ['srt', 'ass']) {
    const cues = readCues(format, input);
    assert.deepEqual(cues.map((cue) => cue.text), [front, back]);
    assertOrdinaryTimeline(cues);
    assert.equal(cues[0].start, 3);
    assert.equal(cues.at(-1).end, 9);
  }
  assert.deepEqual(input, before);
});

test('a provider-separated dependent tail can be repartitioned without losing text', () => {
  const input = [
    { start: 3, end: 8.2, text: sentence.replace(/ 됩니다$/, '') },
    { start: 8.2, end: 9, text: '됩니다' },
  ];
  for (const format of ['srt', 'ass']) {
    const cues = readCues(format, input);
    assert.deepEqual(cues.map((cue) => cue.text), [front, back]);
    assertOrdinaryTimeline(cues);
    assert.equal(cues[0].start, 3);
    assert.equal(cues.at(-1).end, 9);
  }
});

test('dependent-tail repair uses the existing ordinary 0.3-second gap boundary', () => {
  for (const gap of [0.3, 0.301]) {
    const input = [
      { start: 3, end: 8, text: sentence.replace(/ 됩니다$/, '') },
      { start: 8 + gap, end: 9, text: '됩니다' },
    ];
    const cues = readCues('srt', input);
    assertOrdinaryTimeline(cues);
    if (gap === 0.3) assert.deepEqual(cues.map((cue) => cue.text), [front, back]);
    else {
      assert.equal(cues.at(-1).text, '됩니다');
      assert.equal(cues.at(-2).end, 8.301);
      assert.equal(cues.at(-1).start, 8.301);
    }
  }
});

test('an independent sentence or a longer pause never becomes a dependent tail', () => {
  for (const previous of ['설명을 먼저 들으면.', '설명을 모두 마쳤습니다']) {
    const cues = readCues('srt', [
      { start: 3, end: 4, text: previous },
      { start: 4.2, end: 5, text: '됩니다' },
    ]);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].end, 4.2);
    assert.equal(cues[1].start, 4.2);
    assert.equal(cues[1].text, '됩니다');
  }
});

test('provider word-aligned segments are not joined by the ordinary tail repair', () => {
  const input = [
    { start: 3, end: 8, text: sentence.replace(/ 됩니다$/, ''), sourceWords: [] },
    { start: 8, end: 9, text: '됩니다', sourceWords: [] },
  ];
  const before = structuredClone(input);
  const cues = readCues('srt', input);
  assert.equal(cues.at(-1).text, '됩니다');
  assert.equal(cues.at(-1).start, 8);
  assert.deepEqual(input, before);
});

test('same-start ordinary source segments retain input order in a single dialogue', () => {
  const input = [
    { start: 3, end: 6, text: '먼저 적은 문장' },
    { start: 3, end: 4, text: '다음에 적은 응답' },
  ];
  const before = structuredClone(input);
  for (const format of ['srt', 'ass']) {
    const cues = readCues(format, input);
    assert.deepEqual(cues, [{ start: 3, end: 6, text: '먼저 적은 문장 다음에 적은 응답' }]);
    assertOrdinaryTimeline(cues);
  }
  assert.deepEqual(input, before);
});

test('long same-start ordinary sources are grouped before splitting and stop at the next source', () => {
  const first = '먼저 작성한 안내 문장을 모두 차근차근 읽어봅니다';
  const second = '다음에 적힌 설명도 빠짐없이 함께 살펴봅니다';
  const input = [
    { start: 3, end: 7, text: first },
    { start: 3, end: 4, text: second },
    { start: 5, end: 8, text: '새로운 구간에서 설명합니다' },
  ];
  for (const format of ['srt', 'ass']) {
    const cues = readCues(format, input);
    assertOrdinaryTimeline(cues);
    assert.equal(cues.slice(0, -1).map((cue) => cue.text).join(' '), `${first} ${second}`);
    assert.equal(cues.at(-2).end, 5);
    assert.equal(cues.at(-1).start, 5);
    assert.equal(cues.at(-1).text, input[2].text);
  }
});

test('ordinary source overlap is resolved before a long sentence is split', () => {
  const first = '먼저 작성한 안내 문장을 모두 차근차근 읽으며 새로운 항목도 함께 확인해 봅니다';
  const input = [
    { start: 3, end: 9, text: first },
    { start: 5, end: 8, text: '다음 안내를 확인합니다' },
  ];
  for (const format of ['srt', 'ass']) {
    const cues = readCues(format, input);
    assertOrdinaryTimeline(cues);
    assert.equal(cues.slice(0, -1).map((cue) => cue.text).join(' '), first);
    assert.equal(cues.at(-2).end, 5);
    assert.equal(cues.at(-1).start, 5);
  }
});

test('blank and zero-length ordinary sources cannot shorten valid speech', () => {
  const cues = readCues('srt', [
    { start: 3, end: 6, text: '온전하게 남아 있어야 하는 안내' },
    { start: 4, end: 5, text: '  ' },
    { start: 5, end: 5, text: '길이 없는 안내' },
    { start: 8, end: 9, text: '무음 뒤의 다음 안내' },
  ]);
  assert.equal(cues[0].end, 6);
  assert.equal(cues[1].start, 8);
  assertOrdinaryTimeline(cues);
});

test('ordinary tail repair never crosses a speaker boundary or changes simultaneous speaker cues', () => {
  const input = [
    { start: 3, end: 8, text: '안내된 내용을 차분히 확인하면', speaker: 0 },
    { start: 8, end: 9, text: '됩니다', speaker: 1 },
    { start: 10, end: 11, text: '첫 응답', speaker: 0 },
    { start: 10, end: 12, text: '둘째 응답', speaker: 1 },
  ];
  const cues = readCues('srt', input);
  assert.equal(cues[1].text, '됩니다');
  assert.equal(cues[1].start, 8);
  assert.deepEqual(cues.slice(2).map((cue) => [cue.start, cue.end, cue.text]), [
    [10, 11, '첫 응답'], [10, 12, '둘째 응답'],
  ]);
});

test('fractional-frame seconds remain absolute milliseconds without frame-rate rescaling', () => {
  const frameSeconds = 1001 / 30000;
  const boundary = 3639 * frameSeconds;
  const input = [
    { start: 120, end: boundary, text: '앞쪽 자막' },
    { start: boundary, end: 5226 * frameSeconds, text: '뒤쪽 자막' },
  ];
  const srt = generateSRT(input);
  assert.match(srt, /00:02:00,000 --> 00:02:01,421/);
  assert.match(srt, /00:02:01,422 --> 00:02:54,374/);
  assertOrdinaryTimeline(readCues('srt', input));
});

test('ordinary exports hold only positive gaps through the inclusive one-second boundary', () => {
  for (const offset of [0, 180, 1_234_567 * 1001 / 30000]) {
    for (const gap of [0, 0.999, 1, 1.001, 2]) {
      const input = [
        { start: offset + 2.5, end: offset + 3, text: 'First reply' },
        { start: offset + 3 + gap, end: offset + 5 + gap, text: 'Next reply' },
      ];
      const before = structuredClone(input);
      for (const format of ['srt', 'ass']) {
        const scale = format === 'srt' ? 1000 : 100;
        const round = value => Math.round(value * scale) / scale;
        const cues = readCues(format, input);
        if (gap > 0 && gap <= 1) assert.equal(cues[0].end, cues[1].start, `${format} offset=${offset} gap=${gap}`);
        else assert.ok(Math.abs(cues[0].end - round(input[0].end)) < 1e-9);
        assert.ok(cues[1].start >= input[1].start - 1e-9);
        assert.ok(cues[1].start < input[1].start + 1 / scale + 1e-9);
        assert.ok(Math.abs(cues[1].end - round(input[1].end)) < 1e-9, 'last cue retains its end');
        assertOrdinaryTimeline(cues);
      }
      assert.deepEqual(input, before);
    }
  }
});

test('continuity adjusts only the last fragment before silence and has an explicit export opt-out', () => {
  const input = [
    { start: 3, end: 8, text: '먼저 작성한 안내 문장을 차근차근 읽으며 마지막 항목까지 빠짐없이 모두 확인해 봅니다' },
    { start: 8.75, end: 10, text: '다음 안내' },
  ];
  const before = structuredClone(input);
  for (const format of ['srt', 'ass']) {
    const original = readCues(format, input, { holdShortGaps: false });
    const held = readCues(format, input);
    assert.deepEqual(readCues(format, input, { holdShortGaps: 0 }), held);
    assert.deepEqual(readCues(format, input, { holdShortGaps: 'false' }), held);
    assert.ok(original.length > 2);
    assert.deepEqual(held.slice(0, -2), original.slice(0, -2));
    assert.deepEqual(held.map(cue => [cue.start, cue.text]), original.map(cue => [cue.start, cue.text]));
    assert.equal(original.at(-2).end, 8);
    assert.equal(held.at(-2).end, 8.75);
    assert.deepEqual(held.at(-1), original.at(-1));
    assertOrdinaryTimeline(held);
  }
  assert.deepEqual(input, before);
});

test('compact Korean word cues keep source times while exported ends hold between phrases', () => {
  const input = [{
    start: 10, end: 12, text: '네 다음', timingSource: 'word',
    wordAlignedCues: [[10.1, 10.2, '네'], [11.1, 11.4, '다음']],
    sourceWords: [{ word: '네', start: 10.1, end: 10.2 }, { word: '다음', start: 11.1, end: 11.4 }],
  }, { start: 12, end: 12.2, text: '확인', timingSource: 'word' }];
  const before = structuredClone(input);
  for (const format of ['srt', 'ass']) {
    assert.deepEqual(readCues(format, input), [
      { start: 10.1, end: 11.1, text: '네' },
      { start: 11.1, end: 12, text: '다음' },
      { start: 12, end: 12.2, text: '확인' },
    ]);
    assert.deepEqual(readCues(format, input, { holdShortGaps: false }).map(cue => cue.end), [10.2, 11.4, 12.2]);
  }
  assert.deepEqual(input, before);
});

test('speaker zero and mixed labelled inputs disable continuity for the complete export', () => {
  const cases = [
    [{ start: 3, end: 3.2, text: '응답', speaker: 0 }, { start: 4, end: 5, text: '안내', speaker: 0 }],
    [{ start: 3, end: 3.2, text: '응답' }, { start: 4, end: 4.2, text: '안내', speaker: 0 }, { start: 5, end: 6, text: '마지막' }],
    [{ start: 3, end: 3.2, text: '응답', speaker: 'provider-a' }, { start: 4, end: 5, text: '안내', speaker: 'provider-b' }],
  ];
  for (const input of cases) {
    const before = structuredClone(input);
    for (const format of ['srt', 'ass']) {
      assert.deepEqual(readCues(format, input), readCues(format, input, { holdShortGaps: false }));
      assert.equal(readCues(format, input)[0].end, 3.2);
    }
    assert.deepEqual(input, before);
  }
  for (const speaker of [undefined, null, '']) {
    assert.equal(readCues('srt', [{ start: 3, end: 3.2, text: '응답', speaker }, { start: 4, end: 5, text: '안내', speaker }])[0].end, 4);
  }
});

test('unsorted and equal-start sources use existing normalization before display continuity', () => {
  const input = [
    { start: 5, end: 6, text: '다음 안내' },
    { start: 3, end: 3.8, text: '첫 응답' },
    { start: 3, end: 4, text: '함께 응답' },
    { start: 4.2, end: 4.8, text: '  ' },
    { start: 4.4, end: 4.4, text: '길이 없음' },
  ];
  const before = structuredClone(input);
  for (const format of ['srt', 'ass']) {
    assert.deepEqual(readCues(format, input), [
      { start: 3, end: 5, text: '첫 응답 함께 응답' },
      { start: 5, end: 6, text: '다음 안내' },
    ]);
    const overlapping = [{ start: 3, end: 7, text: '앞 안내' }, { start: 5, end: 6, text: '뒤 안내' }];
    assert.deepEqual(readCues(format, overlapping), readCues(format, overlapping, { holdShortGaps: false }));
  }
  assert.deepEqual(input, before);
});

test('the two-second start marker stays separate from ordinary dialogue continuity', () => {
  const input = [{ start: 0, end: 0.2, text: '첫 응답' }, { start: 1, end: 1.5, text: '다음 응답' }];
  const srt = generateSRT(input);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\n/);
  assert.equal(srt.split('0~2초 자막 시작 구간입니다!').length - 1, 1);
  assert.deepEqual(readCues('srt', input), [{ start: 0, end: 1, text: '첫 응답' }, { start: 1, end: 1.5, text: '다음 응답' }]);
  assert.deepEqual(readCues('ass', input), readCues('srt', input));
  assert.doesNotMatch(generateASS(input), /0~2초 자막 시작 구간입니다!/);
});
