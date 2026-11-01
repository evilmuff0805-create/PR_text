import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, stat } from 'node:fs/promises';
import { analyzeLocalStartRanges, annotateLocalStartEvidence } from '../src/services/local-audio-start.js';
import { createLocalAudioAnalysisBudget, analyzeExactSilenceRanges, LOCAL_TRANSCRIPT_LIMITS } from '../src/services/local-transcript-review.js';
import { normalizeLocalStartEvidence, getBoundLocalStartEvidence, setLocalStartEvidenceStatus } from '../src/services/local-start-evidence.js';
import { buildSubtitleCues, generateSRT, generateASS } from '../src/services/subtitle.js';
import { validateSubtitleSegments } from '../src/services/subtitle-payload.js';
import { processTranscriptionSegments } from '../src/services/transcription-processing.js';

function wave({ rate = 1000, channels = 2, bits = 16, floating = false, seconds = 6, frames = Math.round(rate * seconds), sample = () => 0 } = {}) {
  const bytes = bits / 8, align = channels * bytes;
  const buffer = Buffer.alloc(44 + frames * align);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(floating ? 3 : 1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * align, 28); buffer.writeUInt16LE(align, 32); buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * align, 40);
  for (let frame = 0; frame < frames; frame += 1) for (let channel = 0; channel < channels; channel += 1) {
    const offset = 44 + frame * align + channel * bytes, value = sample(frame, channel);
    if (floating) bits === 32 ? buffer.writeFloatLE(value, offset) : buffer.writeDoubleLE(value, offset);
    else if (bits === 8) buffer[offset] = value + 128;
    else buffer.writeIntLE(value, offset, bytes);
  }
  return buffer;
}
const row = (text = '합성 시작 검증 문장', start = 1, end = 3) => ({ text, start, end });
const evidence = (source, cues = [[source.start, source.end, source.text, 2]]) => ({ ...source,
  subtitleReview: { version: 1, issues: [], localStart: { version: 1, status: 'automatic', binding: { ...source }, cues,
    sampleRate: 1000, channels: 2, method: 'native_wav' } } });
const content = values => values.map(({ text, start, end, sourceWords, wordAlignedCues, fixedCuePlan }) => ({ text, start, end, sourceWords, wordAlignedCues, fixedCuePlan }));

test('local starts preserve native precision and every channel while finding only the zero prefix', async () => {
  for (const format of [{ bits: 8, value: 1 }, { bits: 16, value: 1 }, { bits: 24, value: 1 }, { bits: 32, value: 1 },
    { bits: 32, floating: true, value: 1e-40 }, { bits: 64, floating: true, value: 1e-300 }]) {
    const audio = wave({ ...format, sample: (frame, channel) => frame >= 2000 && channel === 1 ? format.value : 0 });
    const result = await analyzeLocalStartRanges(audio, { ranges: [{ start: 1.4, end: 3 }] });
    assert.equal(result.measurements[0].minimumStart, 2);
    const withSignalAtStart = wave({ ...format, sample: (_frame, channel) => channel === 1 ? format.value : 0 });
    assert.equal((await analyzeLocalStartRanges(withSignalAtStart, { ranges: [{ start: 1.4, end: 3 }] })).measurements[0].status, 'unchanged');
  }
  const opposite = wave({ bits: 32, floating: true, sample: (_frame, channel) => channel ? -.001 : .001 });
  assert.equal((await analyzeLocalStartRanges(opposite, { ranges: [{ start: 1, end: 3 }] })).measurements[0].status, 'unchanged');
});

test('whole-zero, zero until the cue end, invalid and unsupported input never move or delete a cue', async () => {
  for (const audio of [wave(), wave({ sample: frame => frame >= 3000 ? 1 : 0 }), wave().subarray(0, 50), Buffer.from('not-a-wave')]) {
    const result = await analyzeLocalStartRanges(audio, { originalname: 'synthetic.wav', ranges: [{ start: 1, end: 3 }] });
    assert.notEqual(result.measurements[0].status, 'verified');
  }
  const invalid = wave({ floating: true, bits: 64, sample: frame => frame === 1500 ? NaN : 0 });
  assert.equal((await analyzeLocalStartRanges(invalid, { ranges: [{ start: 1, end: 3 }] })).measurements[0].reason, 'invalid_samples');
});

test('a final cue receives a reversible start while row, words, end, fixed plan and input remain exact', async () => {
  const source = { ...row(), timingSource: 'speech_window', sourceWords: [{ word: '합성', start: 1, end: 3 }] };
  source.fixedCuePlan = { version: 1, binding: { text: source.text, start: 1, end: 3 }, cues: [[1, 3, source.text]] };
  const before = structuredClone(source);
  const result = await annotateLocalStartEvidence([source], { language: 'ko', buffer: wave({ sample: frame => frame >= 2000 ? 1 : 0 }) });
  assert.deepEqual(source, before);
  assert.deepEqual(content(result.segments), content([source]));
  assert.equal(result.summary.automaticCues, 1);
  assert.equal(buildSubtitleCues(result.segments, { holdShortGaps: false })[0].start, 2);
  assert.match(generateSRT(result.segments), /00:00:02,000 --> 00:00:03,000/u);
  const restored = setLocalStartEvidenceStatus(result.segments[0], 'restored');
  assert.equal(buildSubtitleCues([restored])[0].start, 1);
  assert.deepEqual(content([restored]), content([source]));
  assert.equal(buildSubtitleCues([setLocalStartEvidenceStatus(restored, 'automatic')])[0].start, 2);
  assert.equal(validateSubtitleSegments(JSON.parse(JSON.stringify(result.segments))), null);
});

test('a later compact cue floor cannot clamp the parent start or an earlier internal cue', () => {
  const source = { text: '합성 앞 문장 합성 뒤 문장', start: 1, end: 5, timingSource: 'word',
    wordAlignedCues: [[1, 2, '합성 앞 문장'], [3, 5, '합성 뒤 문장']] };
  const proved = evidence(source, [[3, 5, '합성 뒤 문장', 4]]);
  assert.deepEqual(buildSubtitleCues([proved], { holdShortGaps: false }).map(({ start, end }) => [start, end]), [[1, 2], [4, 5]]);
  assert.equal(proved.start, 1);
});

test('stale text/time, a changed final split, speaker paths and manual ranges receive no new or borrowed proof', async () => {
  const original = evidence(row());
  for (const changed of [{ ...original, text: `${original.text}!` }, { ...original, start: 1.0000001 }, { ...original, end: 2.9 }, { ...original, speaker: 0 }]) {
    assert.equal(getBoundLocalStartEvidence(changed), undefined);
    assert.equal(buildSubtitleCues([changed], { holdShortGaps: false })[0].start, changed.start);
  }
  const clipped = [original, row('뒤 합성 문장', 2.5, 4)];
  assert.equal(buildSubtitleCues(clipped, { holdShortGaps: false })[0].start, 1);
  for (const language of ['en', 'unknown']) {
    const result = await annotateLocalStartEvidence([row()], { language, buffer: wave() });
    assert.deepEqual(result.segments, [row()]);
  }
  const manual = { ...row(), timingSource: 'manual' };
  const result = await annotateLocalStartEvidence([manual], { language: 'ko', buffer: wave({ sample: frame => frame >= 2000 ? 1 : 0 }) });
  assert.deepEqual(result.segments, [manual]);
});

test('shared owners are never partially altered and restored choices never trigger another analysis', async () => {
  const input = [row('합성 동시 첫 문장', 1, 3), row('합성 동시 둘째 문장', 1, 4)];
  let calls = 0;
  const analyzeAudio = async () => { calls += 1; throw Error('must not analyze'); };
  assert.deepEqual((await annotateLocalStartEvidence(input, { language: 'ko', buffer: wave(), analyzeAudio })).segments, input);
  const restored = setLocalStartEvidenceStatus(evidence(row()), 'restored');
  assert.deepEqual((await annotateLocalStartEvidence([restored], { language: 'ko', buffer: wave(), analyzeAudio })).segments, [restored]);
  assert.equal(calls, 0);
});

test('competing fixed cues with equal starts preserve order and ends for every mixed evidence or restoration state', async () => {
  const fixed = (text, end) => ({ text, start: 0, end, timingSource: 'speech_window',
    fixedCuePlan: { version: 1, binding: { text, start: 0, end }, cues: [[0, end, text]] } });
  const first = fixed('첫 합성 대사입니다', 1), second = fixed('다른 합성 대사입니다', 2);
  const prove = source => evidence(source, [[0, source.end, source.text, .2]]);
  const unavailable = { ...second, subtitleReview: { version: 1, issues: [], localStart: {
    version: 1, status: 'unavailable', binding: { text: second.text, start: 0, end: 2 }, cues: [], reason: 'analysis_limit',
  } } };
  const states = [
    [prove(first), second],
    [prove(first), setLocalStartEvidenceStatus(prove(second), 'restored')],
    [prove(first), unavailable],
    [prove(first), prove(second)],
    [setLocalStartEvidenceStatus(prove(first), 'restored'), prove(second)],
  ];
  const expected = buildSubtitleCues([first, second], { holdShortGaps: false });
  for (const values of states) {
    const before = structuredClone(values);
    const cues = buildSubtitleCues(values, { holdShortGaps: false });
    assert.deepEqual(cues, expected);
    assert.deepEqual(cues.map(({ start, end }) => [start, end]), [[0, 1], [0, 2]]);
    assert.deepEqual(values, before);
  }
  let calls = 0;
  const result = await annotateLocalStartEvidence([first, second], { buffer: wave(), language: 'ko',
    analyzeAudio: async () => { calls += 1; throw Error('equal starts must not be analyzed'); } });
  assert.strictEqual(result.segments[0], first);
  assert.strictEqual(result.segments[1], second);
  assert.equal(result.summary.automaticCues, 0);
  assert.equal(calls, 0);
});

test('hold continuity is computed from the corrected start and no-hold batch exports retain the speech end', () => {
  const first = row('앞 합성 문장', 0, 1), second = evidence(row('뒤 합성 문장', 1.6, 3), [[1.6, 3, '뒤 합성 문장', 2.1]]);
  assert.equal(buildSubtitleCues([first, second])[0].end, 1);
  const within = evidence(row('뒤 합성 문장', 1.6, 3), [[1.6, 3, '뒤 합성 문장', 2]]);
  assert.equal(buildSubtitleCues([first, within])[0].end, 2);
  assert.equal(buildSubtitleCues([first, within], { holdShortGaps: false })[0].end, 1);
  const fractional = evidence(row(), [[1, 3, '합성 시작 검증 문장', 2.000020833333333]]);
  assert.match(generateSRT([fractional]), /00:00:02,001/u);
  assert.match(generateASS([fractional]), /0:00:02\.01/u);
});

test('the existing local review and start verifier share the unchanged window and byte budgets', async () => {
  const budget = createLocalAudioAnalysisBudget();
  const ranges = Array.from({ length: LOCAL_TRANSCRIPT_LIMITS.maxWindows }, (_, index) => ({ start: index, end: index + .1 }));
  await analyzeExactSilenceRanges(wave({ seconds: 20 }), { ranges, budget });
  assert.equal(budget.windows, 12);
  const result = await analyzeLocalStartRanges(wave({ sample: frame => frame >= 2000 ? 1 : 0 }), { ranges: [{ start: 1, end: 3 }], budget });
  assert.equal(result.measurements[0].reason, 'range_or_budget_limit');
  assert.equal(budget.windows, 12);
  for (const extras of [{ decodedBytes: LOCAL_TRANSCRIPT_LIMITS.maxDecodedBytes }, { totalSeconds: 60 }, { deadline: 0 }]) {
    const blocked = await analyzeLocalStartRanges(wave(), { ranges: [{ start: 1, end: 3 }], budget: { ...createLocalAudioAnalysisBudget(), ...extras } });
    assert.equal(blocked.measurements[0].status, 'unavailable');
  }
  assert.equal((await analyzeLocalStartRanges(wave(), { ranges: [{ start: 1, end: 3 }], signal: AbortSignal.abort() })).measurements[0].reason, 'aborted');
});

async function mp3Fixture({ short = false, signalAtStart = false } = {}) {
  const commands = [], outputs = [];
  const runProcess = async (command, args) => {
    commands.push({ command, args });
    if (command === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_name: 'mp3', sample_fmt: 'fltp',
      sample_rate: '1000', channels: 2, start_time: '.023' }], format: { duration: '6' } }) };
    if (args.at(-1) === '-') return { stderr: [0, 1].map(channel => `channel: ${channel} | silence_start: 0.5\nchannel: ${channel} | silence_end: 2`).join('\n') };
    const match = args[args.indexOf('-af') + 1].match(/start_sample=(\d+):end_sample=(\d+)/u);
    const first = Number(match[1]), last = Number(match[2]);
    outputs.push(args.at(-1));
    await writeFile(args.at(-1), wave({ floating: true, bits: 64, frames: last - first - Number(short),
      sample: (frame, channel) => channel === 1 && frame + first >= (signalAtStart ? 1400 : 2000) ? 1e-100 : 0 }));
    return { stderr: '' };
  };
  const result = await analyzeLocalStartRanges(Buffer.from('synthetic-mp3'), { originalname: 'synthetic.mp3', ranges: [{ start: 1.4, end: 3 }], runProcess });
  return { result, commands, outputs };
}

test('MP3 evidence uses decoded sample indices, verifies every output frame and never seeks or applies start_time', async () => {
  const { result, commands } = await mp3Fixture();
  assert.equal(result.measurements[0].minimumStart, 2);
  assert.equal(result.measurements[0].method, 'mp3_f64');
  assert.equal(result.windowAudits[0].firstFrame, 1150);
  assert.equal(result.windowAudits[0].lastFrame, 2250);
  assert.equal(result.windowAudits[0].expectedFrames, result.windowAudits[0].decodedFrames);
  assert.equal(result.windowAudits[0].origin, 'decoded_sample_zero');
  assert.equal(result.windowAudits[0].rangeMethod, 'atrim_sample_indices');
  assert.ok(commands.every(({ args }) => !args.includes('-ss') && !args.includes('-ar') && !args.includes('-ac')));
  assert.equal((await mp3Fixture({ signalAtStart: true })).result.measurements[0].status, 'unchanged');
});

test('incomplete MP3 frames yield no evidence and temporary partial windows are removed', async () => {
  const { result, outputs } = await mp3Fixture({ short: true });
  assert.equal(result.measurements[0].reason, 'decode_failed');
  assert.equal(result.windowAudits.length, 0);
  for (const output of outputs) await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('metadata rejects invalid/unbounded proof and status changes preserve all other fields', () => {
  const source = evidence(row());
  const good = source.subtitleReview.localStart;
  for (const bad of [{ ...good, cues: [[1, 3, source.text, 3]] }, { ...good, cues: [[1, 3, source.text, 1]] },
    { ...good, channels: 0 }, { ...good, sampleRate: Infinity }, { ...good, method: 'vad' },
    { ...good, cues: [[1, 3, '줄\n변경', 2]] }, { ...good, binding: { ...good.binding, text: '가'.repeat(10_001) } }]) {
    assert.equal(normalizeLocalStartEvidence(bad), undefined);
    assert.match(validateSubtitleSegments([{ ...source, subtitleReview: { ...source.subtitleReview, localStart: bad } }]), /시작 검증/u);
  }
  const restored = setLocalStartEvidenceStatus(source, 'restored');
  const expected = structuredClone(source); expected.subtitleReview.localStart.status = 'restored';
  assert.deepEqual(restored, expected);
  assert.equal(normalizeLocalStartEvidence({ ...good, status: 'unavailable', cues: [], reason: 'analysis_limit' }).status, 'unavailable');
});

test('unavailable rows are persisted truthfully and partial compact verification cannot apply a sibling alone', async () => {
  const original = row();
  const unavailable = await annotateLocalStartEvidence([original], { language: 'ko', buffer: Buffer.from('unsupported'), originalname: 'synthetic.aac' });
  assert.equal(unavailable.summary.automaticCues, 0);
  assert.equal(unavailable.summary.unavailableRows, 1);
  assert.equal(getBoundLocalStartEvidence(unavailable.segments[0]).reason, 'unsupported_audio');
  assert.deepEqual(content(unavailable.segments), content([original]));
  assert.equal(buildSubtitleCues(unavailable.segments)[0].start, 1);
  const compact = { text: '합성 앞 문장 합성 뒤 문장', start: 1, end: 5, timingSource: 'word',
    wordAlignedCues: [[1, 2, '합성 앞 문장'], [3, 5, '합성 뒤 문장']] };
  const partial = await annotateLocalStartEvidence([compact], { language: 'ko', buffer: wave(), analyzeAudio: async (_audio, { ranges }) => ({
    measurements: ranges.map((range, index) => ({ ...range, ...(index ? { status: 'unavailable', reason: 'decode_failed' }
      : { status: 'verified', minimumStart: 1.5, method: 'native_wav', channels: 2, sampleRate: 1000 }) })),
  }) });
  assert.equal(partial.summary.automaticCues, 0);
  assert.equal(partial.summary.unavailableRows, 1);
  assert.equal(getBoundLocalStartEvidence(partial.segments[0]).reason, 'partial_verification_unavailable');
  assert.deepEqual(buildSubtitleCues(partial.segments, { holdShortGaps: false }), buildSubtitleCues([compact], { holdShortGaps: false }));
  const mixedInvalid = wave({ floating: true, bits: 64, sample: (_frame, channel) => channel ? NaN : 0.001 });
  assert.equal((await analyzeLocalStartRanges(mixedInvalid, { ranges: [{ start: 1, end: 3 }] })).measurements[0].reason, 'invalid_samples');
});

test('full JSON, additional metadata and persistence overflow preserve the complete existing result and report zero application', async () => {
  const original = [row()];
  const annotate = limits => annotateLocalStartEvidence(original, { language: 'ko', buffer: wave({ sample: frame => frame >= 2000 ? 1 : 0 }), limits });
  for (const limits of [{ maxAddedJsonBytes: 0 }, { maxJsonBytes: Buffer.byteLength(JSON.stringify(original)) }]) {
    const result = await annotate(limits);
    assert.strictEqual(result.segments, original);
    assert.equal(result.summary.limited, true);
    assert.equal(result.summary.reason, 'metadata_limit');
    assert.equal(result.summary.automaticCues, 0);
    assert.equal(result.summary.automaticRows, 0);
    assert.equal(validateSubtitleSegments(result.segments), null);
  }
  const many = Array.from({ length: 5001 }, (_, index) => row('합성 한도 문장', index, index + .5));
  const result = await annotateLocalStartEvidence(many, { language: 'ko', buffer: wave(), analyzeAudio: async (_audio, { ranges }) => ({
    measurements: ranges.map(range => ({ ...range, status: 'unavailable', reason: 'analysis_limit' })),
  }) });
  assert.strictEqual(result.segments, many);
  assert.equal(result.summary.limited, true);
  assert.equal(result.summary.automaticCues, 0);
});

test('start analysis runs after existing correction and keeps its request order and usage intact', async () => {
  const source = [row()];
  const run = async enabled => {
    const calls = [];
    const result = await processTranscriptionSegments(source, 'ko', {
      correct: async (text, language, context) => { calls.push({ text, language, context }); return { text, usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }; },
      ...(enabled ? { audioBuffer: wave({ sample: frame => frame >= 2000 ? 1 : 0 }), analyzeLocalStartAudio: async (buffer, options) => {
        assert.equal(calls.length, 1); return analyzeLocalStartRanges(buffer, options);
      } } : {}),
    });
    return { calls, result };
  };
  const before = await run(false), after = await run(true);
  assert.deepEqual(after.calls, before.calls);
  assert.deepEqual(after.result.correctionTimings.usage, before.result.correctionTimings.usage);
  assert.deepEqual(content(after.result.segments), content(before.result.segments));
  assert.equal(after.result.localStartReview.automaticCues, 1);
});
