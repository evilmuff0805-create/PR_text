import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASS_DEFAULT_FONT_SIZE,
  generateASS,
  generateSRT,
  generateTXT,
  MIN_CUE_SECONDS,
  SUBTITLE_MAX_CHARS,
} from '../src/services/subtitle.js';

const segments = [
  { start: 0, end: 1.25, text: '안녕하세요.', speaker: 0 },
  { start: 1.25, end: 2.5, text: '반갑습니다', speaker: 1 },
];

test('generates SRT and TXT with expected text handling', () => {
  const srt = generateSRT(segments, { 0: '#FFFFFF', 1: '#39FF14' });

  assert.match(srt, /00:00:00,000 --> 00:00:01,250/);
  assert.match(srt, /<font color="#39FF14">반갑습니다<\/font>/);
  assert.equal(generateTXT(segments), '안녕하세요 반갑습니다');
});

test('generates ASS with selected style and speaker styles', () => {
  const ass = generateASS(segments, {
    position: 'top',
    fontFamily: 'Noto Sans KR',
    fontColor: '#FFFF00',
    fontSize: 24,
  }, { 0: '#FFFFFF', 1: '#39FF14' });

  assert.match(ass, /Style: Default,Noto Sans KR,24,&H0000FFFF/);
  assert.match(ass, /Style: Speaker1,Noto Sans KR,24,&H0014FF39/);
  assert.match(ass, /,8,60,60,50,1/);
  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:01.25,Speaker0/);
});

test('ASS declares a 1080p canvas so font size is not scaled up by the player', () => {
  // PlayResX/Y가 없으면 libass가 384x288을 가정해 1080p에서 글자가 약 3.75배가 된다.
  const ass = generateASS(segments);

  assert.match(ass, /^PlayResX: 1920$/m);
  assert.match(ass, /^PlayResY: 1080$/m);
  assert.match(ass, /^ScaledBorderAndShadow: yes$/m);
  assert.match(ass, /^WrapStyle: 2$/m);
  assert.match(ass, new RegExp(`Style: Default,Pretendard,${ASS_DEFAULT_FONT_SIZE},`));
});

test('SRT and ASS normalize edited whitespace into one visual line', () => {
  const input = [{ start: 0, end: 1, text: '앞줄\r\n뒷줄\t마지막 {b1}' }];
  const srt = generateSRT(input);
  const ass = generateASS(input);

  const srtBlock = srt.split('\n');
  assert.equal(srtBlock.length, 3);
  assert.equal(srtBlock[2], '앞줄 뒷줄 마지막 {b1}');
  const dialogue = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogue.length, 1);
  assert.match(dialogue[0], /앞줄 뒷줄 마지막 \(b1\)/);
  assert.doesNotMatch(dialogue[0], /\\N/);
  assert.doesNotMatch(dialogue[0], /[{}]/);
});

test('keeps periods that carry meaning and drops sentence-ending ones', () => {
  const kept = [
    { start: 0, end: 1, text: '녹화는 3.5초 뒤에 시작합니다.' },
    { start: 1, end: 2, text: 'www.naver.com 으로 접속하세요.' },
  ];

  // 숫자·영문 사이 마침표는 의미가 있으므로 남고, 문장 끝 마침표만 사라진다.
  assert.equal(generateTXT(kept), '녹화는 3.5초 뒤에 시작합니다 www.naver.com 으로 접속하세요');
});

function parseSrtTime(value) {
  const [hours, minutes, secondsAndMs] = value.split(':');
  const [seconds, milliseconds] = secondsAndMs.split(',');
  return (((Number(hours) * 60 + Number(minutes)) * 60) + Number(seconds)) * 1000
    + Number(milliseconds);
}

test('limits SRT and ASS display text to 28 characters', () => {
  const text = `${'가'.repeat(SUBTITLE_MAX_CHARS)}다 ${'나'.repeat(80)}`;
  const longSegment = [{ start: 2, end: 14, text, speaker: 0 }];

  const srt = generateSRT(longSegment);
  const srtBlocks = srt.split('\n\n');
  const srtTexts = srtBlocks.map((block) => block.split('\n').slice(2).join('\n'));
  assert.ok(srtTexts.length > 1);
  assert.ok(srtTexts.every((line) => line.length <= SUBTITLE_MAX_CHARS));

  const ass = generateASS(longSegment);
  const assTexts = ass.split('\n')
    .filter((line) => line.startsWith('Dialogue:'))
    .map((line) => line.slice(line.lastIndexOf(',,') + 2));
  assert.deepEqual(assTexts, srtTexts);
  assert.ok(assTexts.every((line) => line.length <= SUBTITLE_MAX_CHARS));
});

test('keeps Korean words intact when selecting a subtitle line boundary', () => {
  const sentence = '안녕하세요 오늘은 다른 옷을 입고 오셨네요, 너무 예뻐요!';
  const srt = generateSRT([{ start: 0, end: 8, text: sentence }]);
  const lines = srt.split('\n\n').map((block) => block.split('\n').slice(2).join('\n'));

  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.length <= SUBTITLE_MAX_CHARS));
  assert.equal(lines.join(' '), sentence);
  assert.equal(lines.some((line, index) => (
    line.endsWith('다') && lines[index + 1]?.startsWith('른')
  )), false);
  assert.equal(lines.some((line, index) => (
    line.endsWith('예') && lines[index + 1]?.startsWith('뻐요')
  )), false);
});

test('preserves the original timeline when long subtitle text is split', () => {
  const longSegment = [{
    start: 3.25,
    end: 15.75,
    text: '긴 자막 분할 테스트 문장입니다 '.repeat(30),
  }];

  const blocks = generateSRT(longSegment).split('\n\n');
  const ranges = blocks.map((block) => {
    const [, timing] = block.split('\n');
    const [start, end] = timing.split(' --> ').map(parseSrtTime);
    return { start, end };
  });

  assert.ok(blocks.length > 11);
  assert.equal(ranges[0].start, 3250);
  assert.equal(ranges.at(-1).end, 15750);
  for (let index = 1; index < ranges.length; index++) {
    assert.equal(ranges[index - 1].end, ranges[index].start);
    assert.ok(ranges[index].end >= ranges[index].start);
  }
});

test('carries rounded subtitle timestamps into the next second', () => {
  const boundarySegment = [{
    start: 59.9996,
    end: 60.9996,
    text: '반올림 경계 자막',
  }];

  const srt = generateSRT(boundarySegment);
  assert.match(srt, /00:01:00,000 --> 00:01:01,000/);
  assert.doesNotMatch(srt, /,1000/);

  const ass = generateASS(boundarySegment);
  assert.match(ass, /Dialogue: 0,0:01:00\.00,0:01:01\.00/);
  assert.doesNotMatch(ass, /\.100(?:,|$)/m);
});

test('short cues are stretched to a readable minimum when the gap allows', () => {
  // "네!"가 0.2초짜리 자막이 되던 경우. 뒤에 빈 시간이 있으면 최소 길이까지 늘린다.
  const srt = generateSRT([
    { start: 0, end: 0.2, text: '네!' },
    { start: 5, end: 6.5, text: '그렇게 하겠습니다' },
  ]);
  const [first] = srt.split('\n\n').map((block) => {
    const [start, end] = block.split('\n')[1].split(' --> ').map(parseSrtTime);
    return { start, end };
  });

  assert.equal(first.start, 0);
  assert.equal(first.end, MIN_CUE_SECONDS * 1000);
});

test('a short cue never grows into the next one', () => {
  const srt = generateSRT([
    { start: 0, end: 0.2, text: '네!' },
    { start: 0.4, end: 2, text: '바로 이어지는 말' },
  ]);
  const ranges = srt.split('\n\n').map((block) => {
    const [start, end] = block.split('\n')[1].split(' --> ').map(parseSrtTime);
    return { start, end };
  });

  assert.equal(ranges[0].end, 400);
  assert.ok(ranges[0].end <= ranges[1].start);
});

test('overlapping speaker cues are trimmed so players do not desync', () => {
  // 다화자 동시 발화에서 diarize 결과가 겹친 구간을 주는 경우.
  const srt = generateSRT([
    { start: 0, end: 4, text: '먼저 말한 사람', speaker: 0 },
    { start: 2, end: 6, text: '끼어든 사람', speaker: 1 },
  ]);
  const ranges = srt.split('\n\n').map((block) => {
    const [start, end] = block.split('\n')[1].split(' --> ').map(parseSrtTime);
    return { start, end };
  });

  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index - 1].end <= ranges[index].start, '자막 큐가 겹치면 안 된다');
  }
});

test('empty cues never reach the file', () => {
  const srt = generateSRT([
    { start: 0, end: 1, text: '' },
    { start: 1, end: 2, text: '남는 자막' },
  ]);

  assert.equal(srt.split('\n\n').length, 1);
  assert.match(srt, /남는 자막/);
});
