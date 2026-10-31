import assert from 'node:assert/strict';
import test from 'node:test';
import { stat, writeFile } from 'node:fs/promises';
import { analyzeExactSilenceRanges, annotateLocalTranscriptReview, LOCAL_TRANSCRIPT_LIMITS } from '../src/services/local-transcript-review.js';
import { alignKoreanSegmentWithWordTimings } from '../src/services/korean-word-timing.js';
import { processTranscriptionSegments } from '../src/services/transcription-processing.js';
import { buildSubtitleCues, generateSRT, generateTXT } from '../src/services/subtitle.js';
import { isLocallyExcluded } from '../src/services/subtitle-review.js';
import { validateSubtitleSegments } from '../src/services/subtitle-payload.js';
import { createBatchSrtArchive } from '../src/services/batch-archive.js';

function wave(seconds = 20, sampleRate = 1_000) {
  const frames = Math.ceil(seconds * sampleRate);
  const result = Buffer.alloc(44 + frames * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(frames * 2, 40);
  return result;
}
const row = (text, start, end, extra = {}) => ({ text, start, end, ...extra });
const risk = { avg_logprob: -.8, no_speech_prob: .95 };
const decide = (source, status = 'user') => ({ ...source, subtitleReview: { version: 1, issues: [],
  localExclusion: { version: 1, status, reason: status === 'automatic' ? 'exact_zero_with_provider_risk' : 'user_selection',
    binding: { text: source.text, start: source.start, end: source.end } } } });
const content = segments => segments.map(({ text, start, end }) => ({ text, start, end }));

test('local review leaves correction request bodies, chunk contexts and usage unchanged', async () => {
  const source = Array.from({ length: 35 }, (_, index) => row(`합성 검증 문장 ${index}입니다`, 1 + index * 2, 2 + index * 2,
    index === 0 ? risk : {}));
  const run = async audioBuffer => {
    const requests = [];
    const result = await processTranscriptionSegments(source, 'ko', { audioBuffer, originalname: 'synthetic.wav',
      correct: async (text, language, context) => {
        requests.push({ text, language, context });
        return { text, model: 'mock-existing-correction', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
      } });
    return { requests, result };
  };
  const before = await run(undefined);
  const after = await run(wave(75));
  assert.equal(before.requests.length, 2);
  assert.deepEqual(after.requests, before.requests);
  assert.deepEqual(after.result.correctionTimings.usage, before.result.correctionTimings.usage);
  assert.deepEqual(content(after.result.segments), content(before.result.segments));
  assert.equal(after.result.localTranscriptReview.automaticExcluded, 1);
  assert.equal(before.result.localTranscriptReview.automaticExcluded, 0);
});

test('a word-aligned child cannot turn an unchecked remainder of its source into silence evidence', async () => {
  const text = '숲길을 따라서 천천히 걸으며 따뜻한 바람을 느끼고 주변의 풍경을 살펴보았습니다';
  const tokens = text.split(' ');
  const source = row(text, 1, 5, { ...risk, sourceWords: tokens.map((word, index) => ({ word,
    start: 1 + index * 4 / tokens.length, end: 1 + (index + 1) * 4 / tokens.length })) });
  const aligned = alignKoreanSegmentWithWordTimings(source);
  assert.equal(aligned.aligned, true);
  assert.ok(aligned.segments.length > 1);
  let measured;
  const result = await annotateLocalTranscriptReview(aligned.segments, { sourceSegments: [source], language: 'ko',
    analyzeAudio: async (buffer, { ranges }) => {
      measured = ranges;
      return { measurements: ranges.map(range => ({ ...range, status: 'signal_present' })) };
    } });
  assert.deepEqual(measured, [{ start: .75, end: 5.25 }]);
  assert.equal(result.summary.automaticExcluded, 0);
  assert.equal(result.summary.reviewCandidates, aligned.segments.length);
});

test('a spelling change is not sufficient to borrow another raw row confidence', async () => {
  const originals = [1, 4, 7].map(start => row('이렇게 진행하면 되요', start, start + 1, risk));
  const corrected = originals.map(source => ({ ...source, text: '이렇게 진행하면 돼요' }));
  const result = await annotateLocalTranscriptReview(corrected, { sourceSegments: originals, language: 'ko', buffer: wave(10) });
  assert.equal(result.summary.groups, 1);
  assert.equal(result.summary.automaticExcluded, 0);
  assert.equal(result.summary.reviewCandidates, 3);
  assert.ok(result.segments.every(segment => segment.subtitleReview.localExclusion.audioStatus === 'unavailable'));
});

test('manual decisions on a shared cue require all owners and never hide the other row', () => {
  const originals = [row('앞쪽 대사입니다', 1, 2), row('같이 시작한 대사입니다', 1, 3), row('남겨 둔 대사입니다', 4, 5)];
  assert.throws(() => generateSRT([decide(originals[0]), ...originals.slice(1)]), error => (
    error.status === 400 && error.code === 'LOCAL_EXCLUSION_CONFLICT' && JSON.stringify(error.connectedRows) === '[1,2]'
  ));
  const excluded = [decide(originals[0]), decide(originals[1]), originals[2]];
  assert.equal(generateTXT(excluded), originals[2].text);
  assert.equal(buildSubtitleCues(excluded).length, 1);
  assert.throws(() => generateSRT([decide(originals[0], 'automatic'), decide(originals[1]), originals[2]]), /제외 충돌/u);
  assert.deepEqual(originals, [row('앞쪽 대사입니다', 1, 2), row('같이 시작한 대사입니다', 1, 3), row('남겨 둔 대사입니다', 4, 5)]);
});

test('audio window limits fail soft and never turn unchecked ranges into exclusions', async () => {
  const ranges = Array.from({ length: LOCAL_TRANSCRIPT_LIMITS.maxWindows + 1 }, (_, index) => ({ start: 1 + index, end: 1.5 + index }));
  const result = await analyzeExactSilenceRanges(wave(), { ranges });
  assert.equal(result.measurements.filter(item => item.status === 'exact_zero').length, LOCAL_TRANSCRIPT_LIMITS.maxWindows);
  assert.equal(result.measurements.at(-1).status, 'unavailable');
  const oversized = Buffer.alloc(LOCAL_TRANSCRIPT_LIMITS.maxAudioBytes + 1);
  const limited = await analyzeExactSilenceRanges(oversized, { ranges: ranges.slice(0, 1) });
  assert.equal(limited.measurements[0].status, 'unavailable');
});

test('failed and skipped windows are reported separately from completed audio measurements', async () => {
  const source = [1, 4, 7].map(start => row('검토할 합성 대사입니다', start, start + 1, risk));
  const partial = await annotateLocalTranscriptReview(source, { sourceSegments: source, language: 'ko',
    analyzeAudio: async (buffer, { ranges }) => ({ measurements: ranges.map((range, index) => ({ ...range,
      status: ['exact_zero', 'signal_present', 'unavailable'][index] })) }) });
  assert.equal(partial.summary.analyzedWindows, 2);
  assert.equal(partial.summary.unavailableWindows, 1);
  assert.equal(partial.summary.automaticExcluded, 1);
  const failed = await annotateLocalTranscriptReview(source, { sourceSegments: source, language: 'ko',
    analyzeAudio: async () => { throw new Error('synthetic analysis failure'); } });
  assert.equal(failed.summary.analyzedWindows, 0);
  assert.equal(failed.summary.unavailableWindows, 3);
  assert.equal(failed.summary.automaticExcluded, 0);
});

test('partial MP3 outputs are removed before the next failed decode window starts', async () => {
  const outputs = [];
  const missing = async path => {
    try { await stat(path); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  };
  const result = await analyzeExactSilenceRanges(Buffer.from('synthetic-mp3-fixture'), {
    originalname: 'synthetic.mp3', ranges: [{ start: 1, end: 1.5 }, { start: 2, end: 2.5 }],
    runProcess: async (command, args) => {
      if (command === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_name: 'mp3',
        sample_fmt: 'fltp', sample_rate: '1000', channels: 2 }], format: { duration: '20' } }) };
      assert.equal(command, 'ffmpeg');
      for (const prior of outputs) assert.equal(await missing(prior), true, 'previous partial output must be gone before the next window');
      const output = args.at(-1);
      outputs.push(output);
      await writeFile(output, Buffer.alloc(4096));
      throw new Error('synthetic decoder failed after writing a partial file');
    },
  });
  assert.equal(outputs.length, 2);
  assert.ok(result.measurements.every(measurement => measurement.status === 'unavailable' && measurement.reason === 'decode_failed'));
  for (const output of outputs) assert.equal(await missing(output), true);
});

test('restored and stale decisions are not silently renewed by local analysis', async () => {
  const original = row('합성 검토 문장입니다', 1, 2, risk);
  for (const source of [decide(original, 'restored'), { ...decide(original), text: `${original.text}!` }]) {
    let calls = 0;
    const result = await annotateLocalTranscriptReview([source], { sourceSegments: [original], language: 'ko',
      analyzeAudio: async () => { calls += 1; throw new Error('must not recheck'); } });
    assert.deepEqual(result.segments, [source]);
    assert.equal(isLocallyExcluded(result.segments[0]), false);
    assert.equal(calls, 0);
  }
});

test('bound exclusion metadata is bounded at persistence and ownership stays internal', () => {
  const source = decide(row('영구 보존할 합성 원문입니다', 1, 2));
  assert.equal(validateSubtitleSegments([source]), null);
  const invalid = structuredClone(source);
  invalid.subtitleReview.localExclusion.binding.text = '가'.repeat(10_001);
  assert.match(validateSubtitleSegments([invalid]), /제외 정보/u);
  const restored = { ...source, subtitleReview: { ...source.subtitleReview,
    localExclusion: { ...source.subtitleReview.localExclusion, status: 'restored' } } };
  assert.ok(buildSubtitleCues([restored]).every(cue => Object.getOwnPropertySymbols(cue).length === 0));
});

test('batch instructions distinguish excluded captions from genuinely empty recognition and permit restoration', () => {
  const source = row('묶음 검증용 합성 원문입니다', 1, 2);
  const items = [
    { label: '제외 결과', status: 'completed', segments: [decide(source)] },
    { label: '빈 전사', status: 'completed', segments: [] },
    { label: '복원 결과', status: 'completed', segments: [decide(source, 'restored')] },
  ];
  const original = structuredClone(items);
  const archive = createBatchSrtArchive({ items });
  const files = new Map();
  for (let cursor = 0; archive.buffer.readUInt32LE(cursor) === 0x04034b50;) {
    const size = archive.buffer.readUInt32LE(cursor + 18);
    const nameLength = archive.buffer.readUInt16LE(cursor + 26);
    const extraLength = archive.buffer.readUInt16LE(cursor + 28);
    const name = archive.buffer.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
    const start = cursor + 30 + nameLength + extraLength;
    files.set(name, archive.buffer.subarray(start, start + size).toString('utf8'));
    cursor = start + size;
  }
  assert.deepEqual(archive.entries, ['03_복원 결과.srt', '사용안내.txt']);
  assert.equal(archive.completedCount, 3);
  assert.equal(archive.includedSrtCount, 1);
  const instructions = files.get('사용안내.txt');
  assert.match(instructions, /01\. 제외 결과: 제외 후 남은 자막 없음 · 제외 복원 가능 \(SRT 제외\)/u);
  assert.match(instructions, /02\. 빈 전사: 인식된 대사 없음 · 검토 필요 \(SRT 제외\)/u);
  assert.match(instructions, /제외 후 남은 자막이 없는 완료 건도 SRT를 제외/u);
  assert.match(instructions, /새로 변환할 필요 없이 편집 화면에서 제외를 복원/u);
  assert.equal(files.get('03_복원 결과.srt'), generateSRT([source], null, { holdShortGaps: false }));
  assert.deepEqual(items, original);
});
