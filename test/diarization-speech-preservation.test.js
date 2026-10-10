import assert from 'node:assert/strict';
import test from 'node:test';
import { processSegmentsWithTiming } from '../src/services/postprocess.js';
import { filterSilentSegments, mergeShortSegments } from '../src/services/transcription-processing.js';
import { generateASS, generateSRT } from '../src/services/subtitle.js';

function dialogue(srt) {
  return srt.split('\n\n').slice(1).map((block) => block.split('\n'));
}

function assDialogue(ass) {
  return ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
}

const conversation = [
  { start: 3, end: 4, text: '이것 맞아요?', speaker: 0 },
  { start: 4, end: 4.3, text: '네 그거요', speaker: 1 },
  { start: 4.3, end: 6, text: '네네네 그거 맞습니다', speaker: 2 },
];

test('three speakers keep separate cues through filtering, correction and both exports', async () => {
  const original = structuredClone(conversation);
  const source = mergeShortSegments(filterSilentSegments(conversation));
  const corrected = await processSegmentsWithTiming(source, 'ko', async (text) => text);
  const colors = { 0: '#FFFFFF', 1: '#39FF14', 2: '#FFE600' };

  assert.deepEqual(corrected.segments, original);
  const srtLines = dialogue(generateSRT(corrected.segments, colors));
  assert.equal(srtLines.length, 3);
  assert.deepEqual(srtLines.map((line) => line[2].replace(/<[^>]+>/g, '')), original.map((segment) => segment.text));
  const assLines = assDialogue(generateASS(corrected.segments, {}, colors));
  assert.equal(assLines.length, 3);
  assLines.forEach((line, index) => assert.ok(line.includes(`,Speaker${index},`)));
  assert.deepEqual(conversation, original);
});

test('same-start speaker cues retain every response and their positive source spans', () => {
  for (const ends of [[5, 5, 5], [4, 5, 6]]) {
    const source = conversation.map((segment, index) => ({ ...segment, start: 3, end: ends[index] }));
    const original = structuredClone(source);
    const colors = { 0: '#FFFFFF', 1: '#39FF14', 2: '#FFE600' };
    const srtLines = dialogue(generateSRT(source, colors));
    assert.equal(srtLines.length, 3);
    source.forEach((segment, index) => {
      assert.ok(srtLines.some((line) => line[1] === `00:00:03,000 --> 00:00:0${ends[index]},000`
        && line[2].includes(segment.text)));
    });
    const assLines = assDialogue(generateASS(source, {}, colors));
    assert.equal(assLines.length, 3);
    source.forEach((segment, index) => assert.ok(assLines.some((line) => line.includes(`,Speaker${index},`)
      && line.includes(`0:00:03.00,0:00:0${ends[index]}.00`) && line.endsWith(segment.text))));
    assert.deepEqual(source, original);
  }
});

test('a short reply at a long subtitle split boundary remains a separate speaker cue', () => {
  const source = [
    { start: 1, end: 9, text: '가'.repeat(56), speaker: 0 },
    { start: 5, end: 5.2, text: '네 그거요', speaker: 1 },
  ];
  const colors = { 0: '#FFFFFF', 1: '#39FF14' };
  const srtLines = dialogue(generateSRT(source, colors));
  assert.equal(srtLines.length, 3);
  assert.ok(srtLines.some((line) => line[1] === '00:00:05,000 --> 00:00:05,200'
    && line[2] === '<font color="#39FF14">네 그거요</font>'));
  const assLines = assDialogue(generateASS(source, {}, colors));
  assert.equal(assLines.length, 3);
  assert.ok(assLines.some((line) => line.includes('0:00:05.00,0:00:05.20,Speaker1,')
    && line.endsWith('네 그거요')));
});

test('same-start speaker groups still stop at the next distinct speech start without filling silence', () => {
  const source = [
    { start: 3, end: 4, text: '네', speaker: 0 },
    { start: 3, end: 8, text: '이어지는 설명', speaker: 1 },
    { start: 5, end: 6, text: '다음 응답', speaker: 2 },
  ];
  const srtLines = dialogue(generateSRT(source));
  assert.deepEqual(srtLines.map((line) => line[1]), [
    '00:00:03,000 --> 00:00:04,000',
    '00:00:03,000 --> 00:00:05,000',
    '00:00:05,000 --> 00:00:06,000',
  ]);
  assert.deepEqual(srtLines.map((line) => line[2]), source.map((segment) => segment.text));
});

test('an empty or zero-length cue cannot erase a simultaneous spoken response', () => {
  const source = [
    { start: 3, end: 4, text: '네', speaker: 0 },
    { start: 3, end: 3, text: '길이 없음', speaker: 1 },
    { start: 3.2, end: 4, text: ' ', speaker: 2 },
  ];
  assert.deepEqual(dialogue(generateSRT(source)), [['2', '00:00:03,000 --> 00:00:04,000', '네']]);
  assert.match(generateASS(source), /0:00:03\.00,0:00:04\.00.*,,네$/m);
});

test('a blank correction line retains the original response and speaker boundaries', async () => {
  const result = await processSegmentsWithTiming(conversation, 'ko', async () => '이것 맞아요?\n \t \n네네네 그거 맞습니다');
  assert.deepEqual(result.segments, conversation);
  assert.equal(dialogue(generateSRT(result.segments)).length, 3);
  assert.equal(assDialogue(generateASS(result.segments)).length, 3);
});

test('correction cannot delete an acknowledgement or compress repeated speech', async () => {
  const result = await processSegmentsWithTiming(conversation, 'ko', async () => '이것 맞아요?\n그거요\n네 그거 맞습니다');
  assert.deepEqual(result.segments, conversation);
});

test('correction cannot expand a response by inserting additional repeated words', async () => {
  const result = await processSegmentsWithTiming(conversation, 'ko', async () => '이것 맞아요?\n네 네 그거요\n네네네 그거 맞습니다');
  assert.deepEqual(result.segments, conversation);
});

test('spelling correction cannot conceal a change in repeated syllables or phrases', async () => {
  for (const [text, correction] of [
    ['네네네 그래서 나갓어', '네 그래서 나갔어'],
    ['네 그거요 네 그거요 조아요', '네 그거요 좋아요'],
    ['네네네 그래서 나갓어', '네네네네 그래서 나갔어'],
  ]) {
    const source = [{ start: 3, end: 5, text, speaker: 1 }];
    const result = await processSegmentsWithTiming(source, 'ko', async () => correction);
    assert.deepEqual(result.segments, source);
  }
});

test('spelling corrections outside unchanged repetitions still apply', async () => {
  const source = [{ start: 3, end: 5, text: '네네네 그래서 나갓어', speaker: 1 }];
  const result = await processSegmentsWithTiming(source, 'ko', async () => '네 네 네 그래서 나갔어');
  assert.deepEqual(result.segments, [{ ...source[0], text: '네 네 네 그래서 나갔어' }]);
});

test('legitimate Korean spelling and spacing corrections still apply independently', async () => {
  const source = [
    { start: 1, end: 2, text: '오늘날씨가 조아요', speaker: 0 },
    { start: 2, end: 3, text: '그래서 나갓어', speaker: 1 },
  ];
  const result = await processSegmentsWithTiming(source, 'ko', async () => '오늘 날씨가 좋아요\n그래서 나갔어');
  assert.deepEqual(result.segments, source.map((segment, index) => ({
    ...segment, text: ['오늘 날씨가 좋아요', '그래서 나갔어'][index],
  })));
});
