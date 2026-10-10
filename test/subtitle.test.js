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

// Existing dialogue invariants still apply after the new standalone start cue.
function dialogueBlocks(srt) {
  return srt.split('\n\n').slice(1);
}

test('SRT starts with one large two-second marker even when speech starts later', () => {
  const input = [{ start: 8.5, end: 10, text: '무음 뒤 첫 대사', speaker: 1 }];
  const original = structuredClone(input);
  const blocks = generateSRT(input, { 1: '#39FF14' }).split('\n\n');

  assert.equal(blocks[0], '1\n00:00:00,000 --> 00:00:02,000\n<font size="48"><b>0~2초 자막 시작 구간입니다!</b></font>');
  assert.equal(blocks[1], '2\n00:00:08,500 --> 00:00:10,000\n<font color="#39FF14">무음 뒤 첫 대사</font>');
  assert.deepEqual(input, original);
});

test('SRT marker preserves speech before and across the two-second boundary', () => {
  const blocks = generateSRT([
    { start: 0, end: 0.5, text: '첫 대사' },
    { start: 1, end: 3, text: '2초에 걸친 대사' },
    { start: 5, end: 6, text: '다음 대사' },
  ]).split('\n\n');

  assert.equal(blocks.length, 4);
  assert.match(blocks[0], /00:00:00,000 --> 00:00:02,000/);
  assert.equal(blocks[1], '2\n00:00:00,000 --> 00:00:00,500\n첫 대사');
  assert.equal(blocks[2], '3\n00:00:01,000 --> 00:00:03,000\n2초에 걸친 대사');
  assert.equal(blocks[3], '4\n00:00:05,000 --> 00:00:06,000\n다음 대사');
});

test('SRT emits its start marker even without usable dialogue', () => {
  for (const input of [undefined, null, [], [{ start: 0, end: 1, text: ' ' }], [{ start: 0, end: 0, text: '길이 없음' }]]) {
    const blocks = generateSRT(input).split('\n\n');
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /^1\n00:00:00,000 --> 00:00:02,000\n/);
    assert.match(blocks[0], /0~2초 자막 시작 구간입니다!/);
  }
  assert.equal(generateTXT([]), '');
  assert.equal(generateASS([]), '');
});

test('the SRT start marker is not added to TXT or ASS exports', () => {
  assert.equal(generateTXT(segments), '안녕하세요 반갑습니다');
  const ass = generateASS(segments);
  assert.doesNotMatch(ass, /0~2초 자막 시작 구간입니다!/);
  assert.equal(ass.split('\n').filter((line) => line.startsWith('Dialogue:')).length, 2);
});

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

  const srtBlock = dialogueBlocks(srt)[0].split('\n');
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
  const srtBlocks = dialogueBlocks(srt);
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
  const lines = dialogueBlocks(srt).map((block) => block.split('\n').slice(2).join('\n'));

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

test('speaker-labelled Korean subtitles keep quoted questions with their predicates', () => {
  const cases = [
    ['아니 아빠한테도 전화는 드렸는데 그냥 뭐라고 그러셨더라?',
      ['아니 아빠한테도 전화는 드렸는데', '그냥 뭐라고 그러셨더라?']],
    ['파일을 받아서 설명해 드렸는데 어떻게 하라고 하셨더라?',
      ['파일을 받아서 설명해 드렸는데', '어떻게 하라고 하셨더라?']],
    ['아까 요청했던 내용을 전달했는데 왜 늦었다고 이야기하셨지?',
      ['아까 요청했던 내용을 전달했는데', '왜 늦었다고 이야기하셨지?']],
    ['지난 회의에서 이미 말씀드렸는데 이제는 뭘 하자고 제안하셨더라?',
      ['지난 회의에서 이미 말씀드렸는데', '이제는 뭘 하자고 제안하셨더라?']],
    ['아까 팀장님께 설명드렸는데 지금 뭘 했냐고 다시 물어보셨어요?',
      ['아까 팀장님께 설명드렸는데', '지금 뭘 했냐고 다시 물어보셨어요?']],
  ];

  for (const [text, expected] of cases) {
    const input = [{ start: 3.25, end: 12.75, text, speaker: 0 }];
    const original = structuredClone(input);
    const srtTexts = dialogueBlocks(generateSRT(input))
      .map((block) => block.split('\n').slice(2).join('\n'));
    const assTexts = generateASS(input).split('\n')
      .filter((line) => line.startsWith('Dialogue:'))
      .map((line) => line.slice(line.lastIndexOf(',,') + 2));

    assert.deepEqual(srtTexts, expected, text);
    assert.deepEqual(assTexts, expected, text);
    assert.equal(srtTexts.join(' '), text);
    assert.ok(srtTexts.every((line) => line.length <= SUBTITLE_MAX_CHARS));
    assert.deepEqual(input, original);
  }
});

test('speaker-labelled Korean subtitles preserve ordinary clauses and dependent phrases', () => {
  const cases = [
    ['회의 때 의견은 말씀드렸지만 어떤 식으로 정리해야 할까요?',
      ['회의 때 의견은 말씀드렸지만', '어떤 식으로 정리해야 할까요?']],
    ['자료는 모두 전달했는데 무슨 일을 해야 하는지 모르겠어요',
      ['자료는 모두 전달했는데', '무슨 일을 해야 하는지 모르겠어요']],
    ['새로운 일정에 대해서 이야기하고 어디서 만나기로 했는지 물었어요',
      ['새로운 일정에 대해서 이야기하고', '어디서 만나기로 했는지 물었어요']],
  ];

  for (const [text, expected] of cases) {
    const lines = dialogueBlocks(generateSRT([{ start: 3, end: 9, text, speaker: 1 }]))
      .map((block) => block.split('\n').slice(2).join('\n'));
    assert.deepEqual(lines, expected, text);
    assert.equal(lines.join(' '), text);
  }
});

test('a long Korean phrase keeps its adjective with its following noun when a shorter cut fits', () => {
  const text = '아주 오래도록 오랫동안 준비했던 매우 아름다운 사진들을 보여드릴게요';
  const lines = dialogueBlocks(generateSRT([{ start: 3, end: 9, text, speaker: 1 }]))
    .map((block) => block.split('\n').slice(2).join('\n'));

  assert.ok(lines.some((line) => line.includes('아름다운 사진들을')));
  assert.equal(lines.join(' '), text);
  assert.ok(lines.every((line) => line.length <= SUBTITLE_MAX_CHARS));
});

test('Korean clause splitting preserves the speaker and complete source time span in both exports', () => {
  const input = [{
    start: 3.25, end: 12.75, speaker: 2,
    text: '아니 아빠한테도 전화는 드렸는데 그냥 뭐라고 그러셨더라?',
  }];
  const colors = { 2: '#FFE600' };
  const blocks = dialogueBlocks(generateSRT(input, colors));
  const ranges = blocks.map((block) => {
    assert.match(block, /<font color="#FFE600">/);
    const [start, end] = block.split('\n')[1].split(' --> ').map(parseSrtTime);
    return { start, end };
  });

  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].start, 3250);
  assert.equal(ranges.at(-1).end, 12750);
  assert.equal(ranges[0].end, ranges[1].start);
  assert.ok(ranges.every(({ start, end }) => end > start));

  const assLines = generateASS(input, {}, colors).split('\n')
    .filter((line) => line.startsWith('Dialogue:'));
  assert.equal(assLines.length, 2);
  assert.match(assLines[0], /^Dialogue: 0,0:00:03\.25,/);
  assert.match(assLines[1], /^Dialogue: 0,[^,]+,0:00:12\.75,/);
  assert.ok(assLines.every((line) => line.includes(',Speaker2,')));
});

test('ordinary Korean now keeps dependent questions together while English stays unchanged', () => {
  const text = '아니 아빠한테도 전화는 드렸는데 그냥 뭐라고 그러셨더라?';
  for (const speaker of [undefined, null, '']) {
    const lines = dialogueBlocks(generateSRT([{ start: 3, end: 9, text, speaker }]))
      .map((block) => block.split('\n').slice(2).join('\n'));
    assert.deepEqual(lines, ['아니 아빠한테도 전화는 드렸는데', '그냥 뭐라고 그러셨더라?']);
  }

  const english = { start: 3, end: 9, text: 'We asked about the schedule and where we should meet later.' };
  assert.equal(generateSRT([{ ...english, speaker: 0 }]), generateSRT([english]));
  assert.equal(generateASS([{ ...english, speaker: 0 }]), generateASS([english]));
});

test('preserves the original timeline when long subtitle text is split', () => {
  const longSegment = [{
    start: 3.25,
    end: 15.75,
    text: '긴 자막 분할 테스트 문장입니다 '.repeat(30),
  }];

  const blocks = dialogueBlocks(generateSRT(longSegment));
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

test('short cues preserve their recorded end even when silence follows', () => {
  // 실제 발화가 끝난 뒤 무음 구간까지 자막을 연장하지 않는다.
  const srt = generateSRT([
    { start: 0, end: 0.2, text: '네!' },
    { start: 5, end: 6.5, text: '그렇게 하겠습니다' },
  ]);
  const [first] = dialogueBlocks(srt).map((block) => {
    const [start, end] = block.split('\n')[1].split(' --> ').map(parseSrtTime);
    return { start, end };
  });

  assert.equal(first.start, 0);
  assert.equal(first.end, 200);
});

test('a short cue never grows into the next one', () => {
  const srt = generateSRT([
    { start: 0, end: 0.2, text: '네!' },
    { start: 0.4, end: 2, text: '바로 이어지는 말' },
  ]);
  const ranges = dialogueBlocks(srt).map((block) => {
    const [start, end] = block.split('\n')[1].split(' --> ').map(parseSrtTime);
    return { start, end };
  });

  assert.equal(ranges[0].end, 200);
  assert.ok(ranges[0].end <= ranges[1].start);
});

test('overlapping speaker cues are trimmed so players do not desync', () => {
  // 다화자 동시 발화에서 diarize 결과가 겹친 구간을 주는 경우.
  const srt = generateSRT([
    { start: 0, end: 4, text: '먼저 말한 사람', speaker: 0 },
    { start: 2, end: 6, text: '끼어든 사람', speaker: 1 },
  ]);
  const ranges = dialogueBlocks(srt).map((block) => {
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

  assert.equal(dialogueBlocks(srt).length, 1);
  assert.match(srt, /남는 자막/);
});

test('same-start cues do not emit zero-duration SRT or ASS entries', () => {
  const input = [
    { start: 0, end: 1, text: '먼저 시작한 자막' },
    { start: 0, end: 2, text: '같이 시작한 자막' },
  ];
  assert.doesNotMatch(generateSRT(input), /00:00:00,000 --> 00:00:00,000/);
  assert.doesNotMatch(generateASS(input), /0:00:00\.00,0:00:00\.00/);
});
