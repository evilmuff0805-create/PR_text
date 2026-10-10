import assert from 'node:assert/strict';
import test from 'node:test';
import { generateASS, generateSRT, SUBTITLE_MAX_CHARS } from '../src/services/subtitle.js';

function seconds(value) {
  const [hours, minutes, rest] = value.replace(',', '.').split(':').map(Number);
  return hours * 3600 + minutes * 60 + rest;
}

function readCues(format, segments) {
  if (format === 'srt') {
    return generateSRT(segments).split('\n\n').slice(1).filter(Boolean).map((block) => {
      const [, range, text] = block.split('\n');
      const [start, end] = range.split(' --> ').map(seconds);
      return { start, end, text };
    });
  }
  return generateASS(segments).split('\n').filter((line) => line.startsWith('Dialogue:'))
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
      assert.equal(cues.at(-2).end, 8);
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
    assert.equal(cues[0].end, 4);
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
  assert.match(srt, /00:02:01,421 --> 00:02:54,374/);
  assertOrdinaryTimeline(readCues('srt', input));
});
