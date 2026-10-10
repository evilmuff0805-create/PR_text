import assert from 'node:assert/strict';
import test from 'node:test';
import {
  processTranscriptionSegments,
  refineKoreanSegmentsWithWordTimings,
} from '../src/services/transcription-processing.js';
import { mergeChunkSegments } from '../src/services/audio-chunks.js';
import { generateASS, generateSRT } from '../src/services/subtitle.js';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';
const { prepareDownloadPayload } = await import('../src/routes/download.js');

const front = '편안하게 생각이 흐르는 대로';
const back = '경험을 통해 떠올리면 됩니다';
const text = `${front} ${back}`;
const correct = async (value) => value;

function source() {
  return {
    start: 10, end: 20, text,
    sourceWords: [
      { word: '편안하게', start: 10.1, end: 10.8 },
      { word: '생각이', start: 10.85, end: 11.05 },
      { word: '흐르는', start: 11.1, end: 11.45 },
      { word: '대로', start: 11.5, end: 11.8 },
      { word: '경험을', start: 12, end: 12.2 },
      { word: '통해', start: 12.22, end: 12.4 },
      { word: '떠올리면', start: 12.5, end: 13.7 },
      { word: '됩니다', start: 13.75, end: 14 },
    ],
  };
}

test('Korean correction to exports uses semantic phrases and their actual word boundaries', async () => {
  const input = [source()];
  const before = structuredClone(input);
  const result = await processTranscriptionSegments(input, 'korean', { correct });
  assert.deepEqual(result.segments, [
    { start: 10.1, end: 11.8, text: front, timingSource: 'word' },
    { start: 12, end: 14, text: back, timingSource: 'word' },
  ]);
  assert.deepEqual(input, before);
  assert.match(generateSRT(result.segments), /00:00:10,100 --> 00:00:11,800/);
  assert.match(generateSRT(result.segments), /00:00:12,000 --> 00:00:14,000/);
  assert.match(generateASS(result.segments), /0:00:10\.10,0:00:11\.80/);
  assert.match(generateASS(result.segments), /0:00:12\.00,0:00:14\.00/);
  assert.ok(result.segments.every((segment) => !('sourceWords' in segment)));
});

test('word-timed Korean short responses do not merge or acquire a minimum display duration', async () => {
  const result = await processTranscriptionSegments([
    { start: 5, end: 5.4, text: '네', sourceWords: [{ word: '네', start: 5.1, end: 5.2 }] },
    { start: 5.6, end: 7, text: '설명을 이어갑니다', sourceWords: [
      { word: '설명을', start: 5.8, end: 6.3 },
      { word: '이어갑니다', start: 6.4, end: 6.8 },
    ] },
  ], 'ko', { correct });
  assert.deepEqual(result.segments, [
    { start: 5.1, end: 5.2, text: '네', timingSource: 'word' },
    { start: 5.8, end: 6.8, text: '설명을 이어갑니다', timingSource: 'word' },
  ]);
});

test('a provider-separated dependent predicate is joined only with complete adjacent word timings', async () => {
  for (const gap of [0.3, 0.301]) {
    const first = source();
    first.sourceWords.pop();
    first.text = text.replace(/ 됩니다$/, '');
    first.end = 13.7;
    const tail = {
      start: 13.7 + gap, end: 14.7 + gap, text: '됩니다',
      sourceWords: [{ word: '됩니다', start: 13.7 + gap, end: 14.2 + gap }],
    };
    const result = await processTranscriptionSegments([first, tail], 'ko', { correct });
    const last = result.segments.at(-1);
    assert.equal(last.end, tail.sourceWords[0].end);
    if (gap === 0.3) {
      assert.deepEqual(result.segments.map((segment) => segment.text), [front, back]);
      assert.equal(last.start, 12);
    } else {
      assert.equal(last.text, '됩니다');
      assert.equal(last.start, tail.start);
      assert.equal(result.segments.at(-2).end, 13.7);
    }
  }
});

test('changed speech after correction falls back without applying stale word times', async () => {
  const input = source();
  const corrected = text.replace('편안하게', '차분하게');
  const result = await processTranscriptionSegments([input], 'ko', { correct: async () => corrected });
  assert.deepEqual(result.segments, [{ start: 10, end: 20, text: corrected }]);
});

test('spacing correction can retain the same Korean speech and word times', async () => {
  const result = await processTranscriptionSegments([{
    start: 0, end: 4, text: '조용히창문을열어봐요', sourceWords: [
      { word: '조용히', start: 0, end: 0.5 },
      { word: '창문을', start: 0.6, end: 1 },
      { word: '열어봐요', start: 1.1, end: 1.5 },
    ],
  }], 'ko', { correct: async () => '조용히 창문을 열어 봐요' });
  assert.deepEqual(result.segments, [{
    start: 0, end: 1.5, text: '조용히 창문을 열어 봐요', timingSource: 'word',
  }]);
});

test('correction failure still aligns the preserved original speech offline', async () => {
  const result = await processTranscriptionSegments([source()], 'ko', {
    correct: async () => { throw new Error('synthetic correction unavailable'); },
  });
  assert.deepEqual(result.segments.map(({ start, end, text: value }) => ({ start, end, text: value })), [
    { start: 10.1, end: 11.8, text: front }, { start: 12, end: 14, text: back },
  ]);
});

test('untimed Korean sources retain the existing ordinary short-source fallback', async () => {
  const result = await processTranscriptionSegments([
    { start: 5, end: 5.4, text: '네' },
    { start: 5.6, end: 7, text: '설명을 이어갑니다' },
  ], 'ko', { correct });
  assert.deepEqual(result.segments, [{ start: 5, end: 7, text: '네 설명을 이어갑니다' }]);
});

test('diarized Korean sources retain provider windows even if word metadata exists', async () => {
  const input = { ...source(), speaker: 0 };
  const result = await processTranscriptionSegments([input], 'ko', { correct });
  const { sourceWords: ignored, ...expected } = input;
  assert.deepEqual(result.segments, [expected]);
});

test('automatic Korean inference aligns words after the existing language decision', async () => {
  const result = await processTranscriptionSegments([source()], 'unknown', { correct });
  assert.equal(result.correctionTimings.languageDecision, 'inferred_from_hangul_segments');
  assert.deepEqual(result.segments.map((segment) => [segment.start, segment.end]), [[10.1, 11.8], [12, 14]]);
});

test('Korean chunk-relative words reach exports with their offset applied once', async () => {
  const segments = mergeChunkSegments([{
    chunk: { ownedStart: 180, ownedEnd: 190, inputStart: 175 },
    response: {
      segments: [{ start: 5, end: 8, text: '조용히 기다려 주세요' }],
      words: [
        { word: '조용히', start: 5.1, end: 5.4 },
        { word: '기다려', start: 6, end: 6.3 },
        { word: '주세요', start: 6.4, end: 6.7 },
      ],
    },
  }]);
  const result = await processTranscriptionSegments(segments, 'ko', { correct });
  assert.deepEqual(result.segments, [
    { start: 180.1, end: 180.4, text: '조용히', timingSource: 'word' },
    { start: 181, end: 181.7, text: '기다려 주세요', timingSource: 'word' },
  ]);
  assert.match(generateSRT(result.segments), /00:03:00,100 --> 00:03:00,400/);
  assert.match(generateSRT(result.segments), /00:03:01,000 --> 00:03:01,700/);
});

test('word cue boundaries survive JSON, short text editing, and re-download preparation', () => {
  const original = [
    { start: 10.1, end: 11.8, text: '내용을 떠올리면', timingSource: 'word' },
    { start: 12, end: 12.2, text: '됩니다', timingSource: 'word' },
  ];
  const restored = JSON.parse(JSON.stringify(original)).map((segment, index) => ({
    ...segment, text: index === 0 ? '장면을 떠올리면' : segment.text,
  }));
  const prepared = prepareDownloadPayload({ segments: restored, format: 'srt' });
  assert.equal(prepared.error, null);
  assert.deepEqual(prepared.segments, restored);
  const srt = generateSRT(prepared.segments);
  assert.match(srt, /00:00:10,100 --> 00:00:11,800\n장면을 떠올리면/);
  assert.match(srt, /00:00:12,000 --> 00:00:12,200\n됩니다/);
  assert.equal(srt.split('\n\n').length, 3);
});

test('long Korean jobs retain exact cue times without exceeding the editor row limit', async () => {
  const input = Array.from({ length: 2_000 }, (_, index) => {
    const offset = index * 3;
    return {
      start: offset, end: offset + 2, text: '하나 둘 셋', sourceWords: [
        { word: '하나', start: offset + 0.1, end: offset + 0.2 },
        { word: '둘', start: offset + 0.6, end: offset + 0.7 },
        { word: '셋', start: offset + 1.1, end: offset + 1.2 },
      ],
    };
  });
  const result = await processTranscriptionSegments(input, 'ko', { correct });
  assert.equal(result.segments.length, 2_000);
  assert.ok(result.segments.every((segment) => segment.wordAlignedCues.length === 3));
  assert.ok(result.segments.every((segment) => !('sourceWords' in segment)));
  const stored = JSON.parse(JSON.stringify(result.segments));
  const prepared = prepareDownloadPayload({ segments: stored, format: 'srt' });
  assert.equal(prepared.error, null);
  const srt = generateSRT(prepared.segments);
  assert.equal(srt.split('\n\n').length, 6_001);
  assert.match(srt, /00:00:00,100 --> 00:00:00,200\n하나/);
  assert.match(srt, /00:00:00,600 --> 00:00:00,700\n둘/);
  assert.match(srt, /01:39:58,100 --> 01:39:58,200\n셋/);
});

test('stale or malformed compact cue metadata cannot override edited speech', () => {
  for (const wordAlignedCues of [
    [[10, 11, '다른 문장']],
    [[9, 11, '수정한 문장']],
    [[10, 11, '수정한 문장', 'unexpected']],
    [{ start: 10, end: 11, text: '수정한 문장' }],
    [null],
  ]) {
    const srt = generateSRT([{
      start: 10, end: 12, text: '수정한 문장', timingSource: 'word', wordAlignedCues,
    }]);
    assert.match(srt, /00:00:10,000 --> 00:00:12,000\n수정한 문장/);
  }
});

test('dependent-tail repair cannot create a compact row above the existing text limit', () => {
  const words = [...Array(4_997).fill('가'), '떠올리면'];
  const first = {
    start: 0, end: 20, text: words.join(' '),
    sourceWords: words.map((word, index) => ({
      word, start: index * 0.004, end: index * 0.004 + 0.002,
    })),
  };
  const tail = {
    start: 20, end: 21, text: '됩니다', sourceWords: [{ word: '됩니다', start: 20.1, end: 20.2 }],
  };
  const rest = Array.from({ length: 2_000 }, (_, index) => {
    const start = 30 + index * 3;
    return {
      start, end: start + 2, text: '하나 둘 셋', sourceWords: [
        { word: '하나', start: start + 0.1, end: start + 0.2 },
        { word: '둘', start: start + 0.6, end: start + 0.7 },
        { word: '셋', start: start + 1.1, end: start + 1.2 },
      ],
    };
  });
  const result = refineKoreanSegmentsWithWordTimings([first, tail, ...rest]);
  assert.equal(first.text.length, 9_998);
  assert.equal(result.length, 2_002);
  assert.equal(result[0].text, first.text);
  assert.equal(result[1].text, tail.text);
  assert.equal(prepareDownloadPayload({ segments: result, format: 'srt' }).error, null);
});

test('dependent-tail repair cannot add separators beyond the total download text limit', () => {
  const longText = `${'가'.repeat(1_993)}떠올리면`;
  const tokens = longText.match(/.{1,20}/gu);
  const input = Array.from({ length: 500 }, (_, index) => [
    {
      start: index, end: index + 0.15, text: longText,
      sourceWords: tokens.map((word, wordIndex) => ({
        word, start: index + wordIndex * 0.001, end: index + wordIndex * 0.001 + 0.0005,
      })),
    },
    { start: index + 0.18, end: index + 0.28, text: '됩니다', sourceWords: [
      { word: '됩니다', start: index + 0.2, end: index + 0.25 },
    ] },
  ]).flat();
  assert.equal(input.reduce((total, segment) => total + segment.text.length, 0), 1_000_000);
  const result = refineKoreanSegmentsWithWordTimings(input);
  assert.equal(result.length, 1_000);
  assert.equal(result.reduce((total, segment) => total + segment.text.length, 0), 1_000_000);
  assert.equal(prepareDownloadPayload({ segments: result, format: 'srt' }).error, null);
});
