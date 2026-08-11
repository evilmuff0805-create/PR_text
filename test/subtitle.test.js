import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASS_DEFAULT_FONT_SIZE,
  generateASS,
  generateSRT,
  generateTXT,
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
  assert.match(ass, new RegExp(`Style: Default,Pretendard,${ASS_DEFAULT_FONT_SIZE},`));
});

test('ASS text cannot break the Dialogue line with braces or newlines', () => {
  const ass = generateASS([
    { start: 0, end: 1, text: '앞줄\n뒷줄 {b1}' },
  ]);

  const dialogue = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogue.length, 1);
  assert.match(dialogue[0], /앞줄\\N뒷줄 \(b1\)/);
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
