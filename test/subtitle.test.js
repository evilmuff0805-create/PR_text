import assert from 'node:assert/strict';
import test from 'node:test';
import { generateASS, generateSRT, generateTXT } from '../src/services/subtitle.js';

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
  assert.match(ass, /,8,10,10,10,1/);
  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:01.25,Speaker0/);
});
