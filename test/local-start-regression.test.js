import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, access } from 'node:fs/promises';
import * as evidence from '../src/services/local-start-evidence.js';
import * as clientReview from '../client/src/utils/subtitle-review.js';
import * as drafts from '../client/src/utils/result-drafts.js';
import { buildSubtitleCues, generateSRT, generateASS, generateTXT } from '../src/services/subtitle.js';
import { validateSubtitleSegments } from '../src/services/subtitle-payload.js';
import { createBatchSrtArchive } from '../src/services/batch-archive.js';
import { getBoundFixedCuePlan } from '../src/services/fixed-cue-plan.js';
import { analyzeLocalStartRanges, annotateLocalStartEvidence } from '../src/services/local-audio-start.js';
import { analyzeExactSilenceRanges, annotateLocalTranscriptReview, createLocalAudioAnalysisBudget } from '../src/services/local-transcript-review.js';

// Independent acceptance was sealed in a private QA manifest before execution.
// Repository fixtures are anonymous synthetic text and locally generated samples.
const binding = row => ({ text: row.text, start: row.start, end: row.end });
const row = (text = '합성 검증 문장입니다', start = 0, end = 1) => ({ text, start, end, timingSource: 'word' });
const proof = (source, { floor = source.start + (source.end - source.start) / 2,
  status = 'automatic', cues = [[source.start, source.end, source.text, floor]], ...extra } = {}) => ({
  ...source, subtitleReview: { ...source.subtitleReview, version: 1, issues: source.subtitleReview?.issues ?? [],
    localStart: { version: 1, status, binding: binding(source), cues, sampleRate: 1000, channels: 2, method: 'native_wav', ...extra } },
});
const triples = cues => cues.map(({ start, end, text }) => [start, end, text]);
const speech = sources => buildSubtitleCues(sources, { holdShortGaps: false });
const memory = () => { const store = new Map(); return { getItem: key => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }; };
function zipFirstSrt(buffer) {
  assert.equal(buffer.readUInt16LE(8), 0);
  const size = buffer.readUInt32LE(18), begin = 30 + buffer.readUInt16LE(26) + buffer.readUInt16LE(28);
  return buffer.toString('utf8', begin, begin + size);
}
function fixedSource() {
  const source = row('앞 합성 문장 뒤 합성 문장', 1, 4);
  source.timingSource = 'speech_window';
  source.fixedCuePlan = { version: 1, binding: binding(source),
    cues: [[1, 2, '앞 합성 문장'], [3, 4, '뒤 합성 문장']] };
  return source;
}

test('independent local-start QA: numeric zero, exact cue binding and server/client shared normalization agree', () => {
  const source = proof(row()), before = structuredClone(source);
  for (const api of [evidence, clientReview]) {
    const normalized = api.normalizeLocalStartEvidence(source.subtitleReview.localStart);
    assert.deepEqual(normalized, source.subtitleReview.localStart);
    assert.equal(normalized.binding.start, 0);
    assert.notEqual(normalized, source.subtitleReview.localStart);
    assert.notEqual(normalized.cues, source.subtitleReview.localStart.cues);
    assert.deepEqual(api.getBoundLocalStartEvidence(source), normalized);
  }
  assert.equal(evidence.getLocalStartCueMinimum(source, { start: 0, end: 1, text: source.text }), .5);
  for (const cue of [{ start: 1e-12, end: 1, text: source.text }, { start: 0, end: .999, text: source.text },
    { start: 0, end: 1, text: '다른 합성 문장입니다' }]) assert.equal(evidence.getLocalStartCueMinimum(source, cue), undefined);
  assert.deepEqual(source, before);
});

test('independent local-start QA: malformed versions, status, binding, proof ranges and sample metadata fail closed', () => {
  const valid = proof(row()).subtitleReview.localStart;
  const invalid = [null, {}, { ...valid, version: 2 }, { ...valid, status: 'confirmed' },
    { ...valid, binding: { ...valid.binding, start: '0' } }, { ...valid, binding: { ...valid.binding, start: -1 } },
    { ...valid, binding: { ...valid.binding, end: NaN } }, { ...valid, binding: { ...valid.binding, end: Infinity } },
    { ...valid, binding: { ...valid.binding, end: 0 } }, { ...valid, binding: { ...valid.binding, text: '' } },
    { ...valid, binding: { ...valid.binding, text: '가'.repeat(10001) } },
    ...[0, '1000', NaN, Infinity, 384001].map(sampleRate => ({ ...valid, sampleRate })),
    ...[0, '2', 1.5, 65, Infinity].map(channels => ({ ...valid, channels })),
    { ...valid, method: 'pcm16_downmix' }, { ...valid, cues: [] }, { ...valid, cues: [[0, 1, valid.binding.text]] },
    { ...valid, cues: [[0, 1, valid.binding.text, 0]] }, { ...valid, cues: [[0, 1, valid.binding.text, 1]] },
    { ...valid, cues: [[0, 1, valid.binding.text, NaN]] }, { ...valid, cues: [[0, 1, valid.binding.text, '.5']] },
    { ...valid, cues: [[-.1, 1, valid.binding.text, .5]] }, { ...valid, cues: [[0, 1.1, valid.binding.text, .5]] },
    { ...valid, cues: [[0, 1, '가'.repeat(29), .5]] }, { ...valid, cues: [[0, 1, '두 줄\n합성', .5]] },
    { ...valid, cues: [[0, .7, '첫 합성', .5], [.6, 1, '다음 합성', .8]] },
    { ...valid, reason: 'unsafe reason' },
  ];
  for (const value of invalid) assert.equal(evidence.normalizeLocalStartEvidence(value), undefined);
});

test('independent local-start QA: unavailable is inert and requires a bounded reason with no fabricated cue proof', () => {
  const source = row(), unavailable = proof(source, { status: 'unavailable', cues: [], reason: 'audio_unavailable' });
  assert.equal(evidence.getBoundLocalStartEvidence(unavailable).status, 'unavailable');
  assert.equal(evidence.getLocalStartCueMinimum(unavailable, source), undefined);
  assert.deepEqual(triples(speech([unavailable])), [[0, 1, source.text]]);
  const value = unavailable.subtitleReview.localStart;
  for (const invalid of [{ ...value, reason: undefined }, { ...value, reason: 'x'.repeat(97) },
    { ...value, cues: [[0, 1, source.text, .5]] }]) assert.equal(evidence.normalizeLocalStartEvidence(invalid), undefined);
  assert.equal(evidence.setLocalStartEvidenceStatus(unavailable, 'automatic'), unavailable);
});

test('independent local-start QA: text, submillisecond time and every speaker label invalidate stale binding', () => {
  const source = proof(row());
  for (const changed of [{ ...source, text: '편집한 합성 문장입니다' }, { ...source, start: 1e-12 },
    { ...source, end: 1 - 1e-12 }, ...[0, 1, 'speaker-a'].map(speaker => ({ ...source, speaker }))]) {
    assert.equal(evidence.getBoundLocalStartEvidence(changed), undefined);
    assert.equal(evidence.getLocalStartCueMinimum(changed, source), undefined);
    assert.equal(evidence.setLocalStartEvidenceStatus(changed, 'restored'), changed);
  }
});

test('independent local-start QA: automatic/restored toggle preserves raw text, words, fixed times and all other fields', () => {
  const base = fixedSource(), source = proof({ ...base, sourceWords: [{ word: '원단어', start: 1, end: 4 }] },
    { cues: [[3, 4, '뒤 합성 문장', 3.4]] });
  const before = structuredClone(source), restored = evidence.setLocalStartEvidenceStatus(source, 'restored');
  assert.equal(evidence.getBoundLocalStartEvidence(restored).status, 'restored');
  assert.deepEqual(restored.fixedCuePlan, source.fixedCuePlan);
  assert.deepEqual(restored.sourceWords, source.sourceWords);
  assert.deepEqual(binding(restored), binding(source));
  assert.equal(evidence.getLocalStartCueMinimum(restored, { start: 3, end: 4, text: '뒤 합성 문장' }), undefined);
  assert.deepEqual(evidence.setLocalStartEvidenceStatus(restored, 'automatic'), source);
  assert.equal(evidence.setLocalStartEvidenceStatus(source, 'automatic'), source);
  assert.equal(evidence.setLocalStartEvidenceStatus(source, 'confirmed'), source);
  assert.deepEqual(source, before);
});

test('independent local-start QA: final projection changes only the selected start and retains original row and speech end', () => {
  const source = proof(row(), { floor: .123456 }), before = structuredClone(source);
  assert.deepEqual(triples(speech([source])), [[.123456, 1, source.text]]);
  assert.deepEqual(triples(speech([evidence.setLocalStartEvidenceStatus(source, 'restored')])), [[0, 1, source.text]]);
  assert.equal(generateTXT([source]), source.text);
  assert.deepEqual(source, before);
});

test('independent local-start QA: SRT/ASS use upward starts, ZIP remains no-hold and JSON produces identical exports', () => {
  const sources = [proof(row(), { floor: .123456 }), row('뒤 합성 문장입니다', 1.4, 2)];
  assert.match(generateSRT(sources), /00:00:00,124 --> 00:00:01,400/u);
  assert.match(generateASS(sources), /0:00:00\.13,0:00:01\.40/u);
  const copy = JSON.parse(JSON.stringify(sources));
  assert.equal(validateSubtitleSegments(copy), null);
  assert.equal(generateSRT(copy), generateSRT(sources));
  assert.equal(generateASS(copy), generateASS(sources));
  assert.equal(generateTXT(copy), generateTXT(sources));
  const archive = createBatchSrtArchive({ items: [{ label: '합성 QA', status: 'completed', segments: copy }] });
  assert.equal(zipFirstSrt(archive.buffer), generateSRT(sources, null, { holdShortGaps: false }));
  assert.match(zipFirstSrt(archive.buffer), /00:00:00,124 --> 00:00:01,000/u);
});

test('independent local-start QA: fixed and compact internal cue starts retain exact plans instead of redistributing text', () => {
  const base = fixedSource(), source = proof(base, { cues: [[3, 4, '뒤 합성 문장', 3.4]] });
  const before = structuredClone(source);
  assert.deepEqual(triples(speech([source])), [[1, 2, '앞 합성 문장'], [3.4, 4, '뒤 합성 문장']]);
  assert.deepEqual(getBoundFixedCuePlan(source), source.fixedCuePlan);
  assert.deepEqual(source, before);
  const make = offset => {
    const cues = Array.from({ length: 3000 }, (_, index) => [offset + index * .02, offset + index * .02 + .01, '가']);
    const current = row(cues.map(cue => cue[2]).join(' '), cues[0][0], cues.at(-1)[1]);
    current.timingSource = 'speech_window';
    current.fixedCuePlan = { version: 1, binding: binding(current), cues };
    const selected = cues[1000];
    return proof(current, { cues: [[...selected, selected[0] + .005]] });
  };
  const compact = [make(0), make(70)], original = structuredClone(compact), actual = speech(compact);
  assert.equal(actual.length, 6000);
  assert.equal(actual[1000].start, original[0].fixedCuePlan.cues[1000][0] + .005);
  assert.equal(actual[4000].start, original[1].fixedCuePlan.cues[1000][0] + .005);
  assert.equal(validateSubtitleSegments(compact), null);
  assert.deepEqual(compact, original);
});

test('independent local-start QA: equal-start shared sources and overlap-clipped triples cannot borrow a proof', () => {
  const first = proof(row('첫 합성', 1, 2), { floor: 1.4 }), second = row('둘째 합성', 1, 3);
  assert.deepEqual(triples(speech([first, second])), triples(speech([row('첫 합성', 1, 2), second])));
  const prior = proof(row('앞 합성', 1, 3), { floor: 1.4 }), next = row('뒤 합성', 2, 4);
  assert.equal(speech([prior, next])[0].start, 1);
});

test('independent local-start QA: one-second display hold is recomputed after projection without changing speech ends', () => {
  for (const gap of [.999, 1, 1.001]) {
    const sources = [row('앞 합성', 1, 2), proof(row('뒤 합성', 2.2, 4), { floor: 2 + gap })];
    const actual = buildSubtitleCues(sources), raw = speech(sources);
    assert.equal(actual[0].end, gap <= 1 ? 2 + gap : 2);
    assert.equal(raw[0].end, 2);
    assert.equal(raw[1].start, 2 + gap);
    assert.equal(actual[1].end, 4);
  }
});

test('independent local-start QA: excluded intervals remain hold barriers after a later start moves', () => {
  const excluded = row('제외된 합성', 2.1, 2.2);
  excluded.subtitleReview = { version: 1, issues: [], localExclusion: { version: 1, status: 'user',
    reason: 'user_selection', binding: binding(excluded) } };
  const sources = [row('앞 합성', 1, 2), excluded, proof(row('뒤 합성', 2.4, 3.6), { floor: 2.8 })];
  assert.deepEqual(triples(buildSubtitleCues(sources)), [[1, 2, '앞 합성'], [2.8, 3.6, '뒤 합성']]);
});

test('independent local-start QA: content or time changes invalidate proof while same-range confirmation retains the separate restore choice', () => {
  const source = proof(row('수동 검증 합성', 1, 2), { floor: 1.4 });
  const edited = clientReview.editSubtitleText(source, '직접 편집한 합성');
  assert.equal(evidence.getBoundLocalStartEvidence(edited), undefined);
  assert.equal(speech([edited])[0].start, 1);
  const manual = clientReview.confirmSubtitleTiming(source, 1.1, 1.9);
  assert.equal(speech([manual])[0].start, 1.1);
  assert.equal(speech([manual])[0].end, 1.9);
  const sameRange = clientReview.confirmSubtitleTiming(source, 1, 2);
  assert.equal(evidence.getBoundLocalStartEvidence(sameRange).status, 'automatic');
  assert.equal(speech([sameRange])[0].start, 1.4);
  const restored = evidence.setLocalStartEvidenceStatus(sameRange, 'restored');
  assert.equal(speech([restored])[0].start, 1);
});

test('independent local-start QA: owner/log drafts preserve restoration and reject other jobs or changed evidence', () => {
  const original = proof(row()), restored = evidence.setLocalStartEvidenceStatus(original, 'restored'), store = memory();
  drafts.writeResultDraft(store, 'qa-owner', 9001, { segments: [restored], fullTextDraft: original.text,
    baseText: original.text, baseSignature: clientReview.subtitleEditSignature([original]) });
  const result = drafts.readResultDraft(store, 'qa-owner', 9001, [original]);
  assert.equal(evidence.getBoundLocalStartEvidence(result.segments[0]).status, 'restored');
  assert.equal(drafts.readResultDraft(store, 'other-owner', 9001, [original]), null);
  assert.equal(drafts.readResultDraft(store, 'qa-owner', 9002, [original]), null);
  const differentProof = proof(row(), { floor: .7 });
  assert.equal(drafts.readResultDraft(store, 'qa-owner', 9001, [differentProof]), null);
});

test('independent local-start QA: labelled, mixed-legacy and simultaneous speaker speech keep existing timing', () => {
  const labelled = proof({ ...row('화자 합성', 1, 2), speaker: 0 }, { floor: 1.5 });
  assert.equal(speech([labelled])[0].start, 1);
  const ordinary = proof(row('일반 합성', 1, 2), { floor: 1.5 });
  assert.equal(speech([ordinary, { ...row('화자 합성', 3, 4), speaker: 1 }])[0].start, 1);
  const simultaneous = [labelled, { ...labelled, speaker: 1, text: '동시 합성' }];
  assert.deepEqual(triples(speech(simultaneous)), [[1, 2, labelled.text], [1, 2, '동시 합성']]);
});

test('independent local-start QA: malformed persistence metadata is rejected without accepting a fabricated positive length', () => {
  const source = proof(row());
  for (const floor of [0, 1, 2, NaN, Infinity, '.5']) {
    const invalid = proof(row(), { cues: [[0, 1, source.text, floor]] });
    assert.notEqual(validateSubtitleSegments([invalid]), null);
    assert.deepEqual(triples(speech([invalid])), [[0, 1, source.text]]);
  }
});

function nativeWave({ channels = 2, rate = 1000, frames = 3000, bits = 16, floating = false, sample = () => 0 } = {}) {
  const bytes = bits / 8, payload = Buffer.alloc(frames * channels * bytes);
  for (let frame = 0; frame < frames; frame += 1) for (let channel = 0; channel < channels; channel += 1) {
    const offset = (frame * channels + channel) * bytes, value = sample(frame, channel);
    if (floating) bits === 32 ? payload.writeFloatLE(value, offset) : payload.writeDoubleLE(value, offset);
    else if (bits === 8) payload[offset] = value + 128;
    else payload.writeIntLE(value, offset, bytes);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + payload.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(floating ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytes, 28); header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bits, 34); header.write('data', 36); header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}
const verified = result => result.measurements.filter(item => item.status === 'verified');
const fakeMp3 = Buffer.from('ID3-anonymous-local-QA-no-recording');
function mp3Decoder({ channels = 2, rate = 1000, duration = 4, startTime = .025,
  sampleFormat = 'fltp', invalidOutput, failDecode = false, onCall, intervals = [[1, 2]], signalAt = 1800 } = {}) {
  const calls = [], outputs = [];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, options });
    onCall?.(command, args);
    if (command === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_name: 'mp3', sample_fmt: sampleFormat,
      sample_rate: String(rate), channels, start_time: String(startTime) }], format: { duration: String(duration) } }) };
    if (args.includes('null')) return { stdout: '', stderr: intervals.flatMap(([start, end]) => Array.from({ length: channels }, (_, channel) =>
      `channel: ${channel} | silence_start: ${start}\nchannel: ${channel} | silence_end: ${end}\n`)).join('') };
    const expression = args[args.indexOf('-af') + 1], match = expression.match(/atrim=start_sample=(\d+):end_sample=(\d+)/u);
    assert.ok(match, 'integer sample trim must be present');
    assert.equal(args.includes('-ss'), false, 'time seek cannot define the sample origin');
    assert.equal(args.includes('-ar'), false, 'native sample rate must be retained');
    assert.equal(args.includes('-ac'), false, 'all original channels must be retained');
    assert.equal(args[args.indexOf('-c:a') + 1], 'mp3float');
    const first = Number(match[1]), last = Number(match[2]), output = args.at(-1);
    outputs.push(output);
    const decoded = nativeWave({ channels: invalidOutput?.channels ?? channels, rate: invalidOutput?.rate ?? rate,
      frames: last - first + (invalidOutput?.extraFrames ?? 0), bits: invalidOutput?.bits ?? 64,
      floating: invalidOutput?.floating ?? true,
      sample: (frame, channel) => first + frame >= signalAt && channel === channels - 1 ? .001 : 0 });
    await writeFile(output, invalidOutput?.truncated ? decoded.subarray(0, 45) : decoded);
    if (failDecode) throw new Error('synthetic decoder failure after partial output');
    return { stdout: '', stderr: '' };
  };
  return { runProcess, calls, outputs };
}

test('independent local-start QA: native first signal respects PCM least-significant and IEEE tiny samples on every channel', async () => {
  for (const format of [{ bits: 8, value: 1 }, { bits: 16, value: 1 }, { bits: 24, value: 1 },
    { bits: 32, value: 1 }, { bits: 32, floating: true, value: 1e-40 }, { bits: 64, floating: true, value: 1e-300 }]) {
    const buffer = nativeWave({ ...format, sample: (frame, channel) => frame === 200 && channel === 1 ? format.value : 0 });
    const result = await analyzeLocalStartRanges(buffer, { originalname: 'anonymous.wav', ranges: [{ start: .1, end: .8 }] });
    assert.equal(verified(result)[0].minimumStart, .2);
    assert.equal(result.windowAudits[0].channels, 2);
    const atStart = await analyzeLocalStartRanges(buffer, { ranges: [{ start: .2, end: .8 }] });
    assert.equal(verified(atStart).length, 0);
  }
});

test('independent local-start QA: quiet voice, music-like samples, negative zero and opposite stereo phase are preserved', async () => {
  for (const sample of [() => 1e-12, (_frame, channel) => channel === 0 ? .001 : -.001,
    frame => .001 * Math.cos(frame * .173)]) {
    const result = await analyzeLocalStartRanges(nativeWave({ bits: 64, floating: true, sample }), {
      ranges: [{ start: .1, end: .8 }] });
    assert.equal(verified(result).length, 0);
  }
  const negativeZero = await analyzeLocalStartRanges(nativeWave({ bits: 64, floating: true,
    sample: frame => frame < 200 ? -0 : .001 }), { ranges: [{ start: 0, end: .8 }] });
  assert.equal(verified(negativeZero)[0].minimumStart, .2);
});

test('independent local-start QA: signal at origin, all-zero audio and zero prefix beyond cue end do not delete or stretch cues', async () => {
  for (const sample of [() => 0, frame => frame === 0 ? 1 : 0, frame => frame >= 1000 ? 1 : 0]) {
    const result = await analyzeLocalStartRanges(nativeWave({ sample }), { ranges: [{ start: 0, end: .8 }] });
    assert.equal(verified(result).length, 0);
  }
  const tiny = proof(row('아주 짧은 합성', 0, .0001), { floor: .00005 });
  assert.equal(speech([tiny])[0].end, .0001);
  assert.match(generateSRT([tiny]), /00:00:00,001 --> 00:00:00,001/u);
});

test('independent local-start QA: malformed, nonfinite, invalid and uncovered native ranges never produce proof', async () => {
  const malformed = nativeWave(); malformed.writeUInt16LE(8, 32);
  const unsupported = nativeWave(); unsupported.writeUInt16LE(6, 20);
  for (const buffer of [Buffer.from('unsupported'), nativeWave().subarray(0, 45), malformed, unsupported,
    nativeWave({ bits: 64, floating: true, sample: () => NaN }), nativeWave({ bits: 64, floating: true, sample: () => Infinity })]) {
    const result = await analyzeLocalStartRanges(buffer, { originalname: 'anonymous.wav', ranges: [{ start: .1, end: .8 }] });
    assert.equal(verified(result).length, 0);
  }
  const result = await analyzeLocalStartRanges(nativeWave(), { ranges: [{ start: -.1, end: .8 },
    { start: 0, end: Infinity }, { start: 0, end: 4 }, { start: 1, end: 1 }, { start: NaN, end: 1 }] });
  assert.equal(verified(result).length, 0);
});

test('independent local-start QA: integer native EOF is covered without adding a floating-point extra frame', async () => {
  const result = await analyzeLocalStartRanges(nativeWave({ rate: 48000, frames: 105600,
    sample: frame => frame >= 96000 ? 1 : 0 }), { ranges: [{ start: 1.9, end: 2.2 }] });
  assert.equal(verified(result)[0].minimumStart, 2);
  assert.equal(result.windowAudits[0].lastFrame, 105600);
});

test('independent local-start QA: MP3 origin is decoded sample zero and uses exact frame trim with native channels/rate', async () => {
  const decoder = mp3Decoder({ startTime: 73.125 });
  const result = await analyzeLocalStartRanges(fakeMp3, { originalname: 'anonymous.mp3',
    ranges: [{ start: 1.2, end: 2.8 }], runProcess: decoder.runProcess });
  assert.equal(verified(result)[0].minimumStart, 1.8);
  const audit = result.windowAudits[0];
  assert.equal(audit.origin, 'decoded_sample_zero');
  assert.equal(audit.rangeMethod, 'atrim_sample_indices');
  assert.equal(audit.decodedFrames, audit.expectedFrames);
  assert.equal(audit.firstFrame, 950);
  assert.equal(audit.lastFrame, 2250);
  for (const output of decoder.outputs) await assert.rejects(access(output));
});

test('independent local-start QA: MP3 rate/channel/precision/frame-count mismatch and partial decode failures preserve the cue', async () => {
  for (const options of [{ invalidOutput: { extraFrames: -1 } }, { invalidOutput: { extraFrames: 1 } },
    { invalidOutput: { channels: 1 } }, { invalidOutput: { rate: 900 } }, { invalidOutput: { bits: 32 } },
    { invalidOutput: { truncated: true } }, { failDecode: true }, { sampleFormat: 's16p' }]) {
    const decoder = mp3Decoder(options);
    const result = await analyzeLocalStartRanges(fakeMp3, { originalname: 'anonymous.mp3',
      ranges: [{ start: 1.2, end: 2.8 }], runProcess: decoder.runProcess });
    assert.equal(verified(result).length, 0);
    assert.equal(result.measurements[0].status, 'unavailable');
    for (const output of decoder.outputs) await assert.rejects(access(output));
  }
});

test('independent local-start QA: native and exclusion analysis consume the same bounded request budget', async () => {
  const budget = createLocalAudioAnalysisBudget(), buffer = nativeWave({ sample: frame => frame >= 500 ? 1 : 0 });
  await analyzeExactSilenceRanges(buffer, { ranges: [{ start: 0, end: .1 }], budget });
  const result = await analyzeLocalStartRanges(buffer, { ranges: [{ start: .1, end: .8 }], budget });
  assert.equal(verified(result)[0].minimumStart, .5);
  assert.equal(budget.windows, 2);
  assert.ok(Math.abs(budget.totalSeconds - .8) < 1e-9);
  assert.equal(budget.decodedBytes, 3200);
  for (const patch of [{ windows: 12 }, { totalSeconds: 59.9 }, { decodedBytes: 32 * 1024 * 1024 - 1 }, { deadline: Date.now() - 1 }]) {
    const blocked = await analyzeLocalStartRanges(buffer, { ranges: [{ start: .1, end: .8 }],
      budget: { ...createLocalAudioAnalysisBudget(), ...patch } });
    assert.equal(verified(blocked).length, 0);
    assert.equal(blocked.measurements[0].status, 'unavailable');
  }
});

test('independent local-start QA: exhausted MP3 budget, long quiet interval, cancellation and decoder timeout cannot create proof', async () => {
  const aborted = new AbortController(); aborted.abort();
  let calls = 0;
  const early = await analyzeLocalStartRanges(fakeMp3, { originalname: 'anonymous.mp3', ranges: [{ start: 1.2, end: 2.8 }],
    signal: aborted.signal, runProcess: async () => { calls += 1; } });
  assert.equal(verified(early).length, 0); assert.equal(calls, 0);
  for (const options of [{ intervals: [[0, 30]], duration: 40 },
    { onCall: command => { if (command === 'ffprobe') throw new Error('synthetic timeout'); } }]) {
    const decoder = mp3Decoder(options);
    const result = await analyzeLocalStartRanges(fakeMp3, { originalname: 'anonymous.mp3',
      ranges: [{ start: 1.2, end: 2.8 }], runProcess: decoder.runProcess });
    assert.equal(verified(result).length, 0);
  }
  const controller = new AbortController();
  const decoder = mp3Decoder({ onCall: (command, args) => { if (args.includes('null')) controller.abort(); } });
  const cancelled = await analyzeLocalStartRanges(fakeMp3, { originalname: 'anonymous.mp3', ranges: [{ start: 1.2, end: 2.8 }],
    signal: controller.signal, runProcess: decoder.runProcess });
  assert.equal(verified(cancelled).length, 0);
  assert.equal(decoder.outputs.length, 0);
});

test('independent local-start QA: global local-analysis lock is shared and released after failure', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pending = analyzeLocalStartRanges(fakeMp3, { originalname: 'anonymous.mp3', ranges: [{ start: 1.2, end: 2.8 }],
    runProcess: async () => { entered(); await gate; throw new Error('synthetic unavailable decoder'); } });
  await started;
  const blocked = await analyzeExactSilenceRanges(nativeWave(), { ranges: [{ start: 0, end: .1 }] });
  assert.equal(blocked.measurements[0].reason, 'busy');
  release(); await pending;
  const next = await analyzeLocalStartRanges(nativeWave({ sample: frame => frame >= 500 ? 1 : 0 }), {
    ranges: [{ start: .1, end: .8 }] });
  assert.equal(verified(next)[0].minimumStart, .5);
});

test('independent local-start QA: annotation changes metadata only and cannot renew restored/stale or manual decisions', async () => {
  const source = row('원형을 보존하는 합성', .1, .8), before = structuredClone(source);
  const result = await annotateLocalStartEvidence([source], { language: 'ko', buffer: nativeWave({ sample: frame => frame >= 500 ? 1 : 0 }) });
  assert.deepEqual(binding(result.segments[0]), binding(source));
  assert.deepEqual(source, before);
  assert.equal(evidence.getBoundLocalStartEvidence(result.segments[0]).cues[0][3], .5);
  const restored = evidence.setLocalStartEvidenceStatus(result.segments[0], 'restored');
  const stale = { ...result.segments[0], text: '편집된 합성 문장' };
  for (const input of [restored, stale, { ...source, timingSource: 'manual' }]) {
    let calls = 0;
    const next = await annotateLocalStartEvidence([input], { language: 'ko', buffer: nativeWave(),
      analyzeAudio: async () => { calls += 1; throw new Error('must not analyze opted-out source'); } });
    assert.deepEqual(next.segments, [input]);
    assert.equal(calls, 0);
  }
});

test('independent local-start QA: unsupported languages, labelled speech and equal-start shared rows do not request start analysis', async () => {
  for (const options of [{ language: 'en', segments: [row('Synthetic English', .1, .8)] },
    { language: 'ja', segments: [row('한국어 모양도 보존', .1, .8)] },
    { language: 'ko', segments: [{ ...row('화자 합성', .1, .8), speaker: 0 }] },
    { language: 'ko', segments: [row('동시 첫 합성', .1, .8), row('동시 둘째 합성', .1, 1)] }]) {
    let calls = 0;
    const result = await annotateLocalStartEvidence(options.segments, { ...options, buffer: nativeWave(),
      analyzeAudio: async () => { calls += 1; throw new Error('out of scope'); } });
    assert.deepEqual(result.segments, options.segments); assert.equal(calls, 0);
  }
});

test('independent local-start QA: generic compressed single risky signal-bearing line is reviewable without automatic exclusion', async () => {
  const source = { ...row('이 문장은 합성 안내 문구입니다', 1, 1.12), avg_logprob: -.75, no_speech_prob: .04 };
  const result = await annotateLocalTranscriptReview([source], { sourceSegments: [source], language: 'ko',
    buffer: nativeWave({ bits: 64, floating: true, sample: () => 1e-12 }), originalname: 'anonymous.wav' });
  assert.equal(result.summary.reviewCandidates, 1);
  assert.equal(result.summary.automaticExcluded, 0);
  assert.equal(result.segments[0].subtitleReview.localExclusion.status, 'review');
  assert.equal(result.segments[0].subtitleReview.localExclusion.audioStatus, 'signal_present');
  assert.deepEqual(binding(result.segments[0]), binding(source));
});

test('independent local-start QA: post-AI annotation preserves correction context, calls and recorded usage and shares one analysis budget', async t => {
  process.env.OPENAI_API_KEY = 'anonymous-QA-no-network-key';
  let forbiddenCalls = 0;
  const [{ Transcriptions }, { Completions }] = await Promise.all([
    import('openai/resources/audio/transcriptions'), import('openai/resources/chat/completions'),
  ]);
  const forbid = async () => { forbiddenCalls += 1; throw new Error('New AI/network requests are forbidden in independent QA'); };
  t.mock.method(globalThis, 'fetch', forbid);
  t.mock.method(Transcriptions.prototype, 'create', forbid);
  t.mock.method(Completions.prototype, 'create', forbid);
  const { processTranscriptionSegments } = await import('../src/services/transcription-processing.js');
  const source = Array.from({ length: 35 }, (_, index) => ({ ...row(`익명 합성 확인 문장 ${index}입니다`, 1 + index * 2, 2 + index * 2),
    ...(index === 0 ? { avg_logprob: -.8, no_speech_prob: .9 } : {}) }));
  const run = async audioBuffer => {
    const requests = [], budgets = [];
    const result = await processTranscriptionSegments(source, 'ko', { audioBuffer, originalname: 'anonymous.wav',
      correct: async (text, language, context) => { requests.push({ text, language, context }); return { text,
        model: 'anonymous-existing-provider', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } }; },
      analyzeLocalAudio: async (_buffer, { ranges, budget }) => { budgets.push(budget);
        return { measurements: ranges.map(range => ({ ...range, status: 'signal_present' })) }; },
      analyzeLocalStartAudio: async (_buffer, { ranges, budget }) => { budgets.push(budget);
        return { measurements: ranges.map(range => ({ ...range, status: 'verified', minimumStart: range.start + .1,
          method: 'native_wav', sampleRate: 1000, channels: 2 })) }; },
    });
    return { requests, result, budgets };
  };
  const before = await run(undefined), after = await run(nativeWave({ frames: 75000 }));
  assert.equal(before.requests.length, 2);
  assert.deepEqual(after.requests, before.requests);
  assert.deepEqual(after.result.correctionTimings.usage, before.result.correctionTimings.usage);
  assert.deepEqual(after.result.segments.map(binding), before.result.segments.map(binding));
  assert.equal(after.budgets.length, 2);
  assert.ok(after.budgets[0]);
  assert.equal(after.budgets[0], after.budgets[1]);
  assert.equal(forbiddenCalls, 0);
});

test('independent local-start QA: a later invalid channel cannot be hidden by an earlier nonzero channel', async () => {
  for (const invalid of [NaN, Infinity]) {
    const result = await analyzeLocalStartRanges(nativeWave({ bits: 64, floating: true,
      sample: (frame, channel) => frame === 200 ? (channel === 0 ? .001 : invalid) : 0 }), {
      ranges: [{ start: .1, end: .8 }] });
    assert.equal(verified(result).length, 0);
    assert.equal(result.measurements[0].status, 'unavailable');
  }
});

test('independent local-start QA: a compact row with one failed internal proof remains wholly unverified', async () => {
  const source = fixedSource(), before = structuredClone(source);
  const result = await annotateLocalStartEvidence([source], { buffer: nativeWave({ frames: 5000 }), language: 'ko',
    analyzeAudio: async (_buffer, { ranges }) => ({ measurements: ranges.map((range, index) => index === 0
      ? { ...range, status: 'verified', minimumStart: 1.4, method: 'native_wav', sampleRate: 1000, channels: 2 }
      : { ...range, status: 'unavailable', candidate: true, reason: 'decode_failed' }) }) });
  assert.equal(result.summary.automaticCues, 0);
  assert.equal(evidence.getBoundLocalStartEvidence(result.segments[0]).status, 'unavailable');
  assert.equal(evidence.getBoundLocalStartEvidence(result.segments[0]).reason, 'partial_verification_unavailable');
  assert.deepEqual(triples(speech(result.segments)), triples(speech([source])));
  assert.deepEqual(source, before);
});

test('independent local-start QA: total metadata and added metadata limits roll back without changing completed content', async () => {
  const source = row('메타 한도를 검증하는 합성', .1, .8), before = structuredClone(source);
  for (const limits of [{ maxJsonBytes: 64 }, { maxAddedJsonBytes: 1 }]) {
    const result = await annotateLocalStartEvidence([source], { buffer: nativeWave({ sample: frame => frame >= 500 ? 1 : 0 }),
      language: 'ko', limits });
    assert.equal(result.summary.automaticCues, 0);
    assert.equal(result.summary.automaticRows, 0);
    assert.deepEqual(result.segments, [source]);
    assert.deepEqual(source, before);
  }
});

test('independent local-start QA: failed MP3 windows consume the shared twelve-window budget and every partial output is removed', async () => {
  const decoder = mp3Decoder({ failDecode: true }), budget = createLocalAudioAnalysisBudget();
  for (let attempt = 0; attempt < 13; attempt += 1) {
    const result = await analyzeLocalStartRanges(fakeMp3, { originalname: 'anonymous.mp3',
      ranges: [{ start: 1.2, end: 2.8 }], budget, runProcess: decoder.runProcess });
    assert.equal(verified(result).length, 0);
  }
  assert.equal(budget.windows, 12);
  assert.equal(decoder.outputs.length, 12);
  assert.ok(budget.decodedBytes > 0);
  assert.ok(budget.totalSeconds > 0 && budget.totalSeconds <= 60);
  for (const output of decoder.outputs) await assert.rejects(access(output));
});

function equalStartFixed(text, end) {
  const source = row(text, 0, end);
  source.timingSource = 'speech_window';
  source.fixedCuePlan = { version: 1, binding: binding(source), cues: [[0, end, text]] };
  return source;
}

test('independent local-start QA: competing fixed cues with equal starts reject one-sided, restored and budget-failed evidence', () => {
  for (const secondEnd of [1, 2]) for (const state of ['none', 'automatic', 'restored', 'unavailable']) {
    const first = proof(equalStartFixed('첫 익명 합성', 1), { floor: .2 });
    const base = equalStartFixed('둘째 익명 합성', secondEnd);
    const second = state === 'none' ? base : proof(base, state === 'unavailable'
      ? { status: state, cues: [], reason: 'range_or_budget_limit' } : { status: state, floor: .3 });
    const sources = [first, second], before = structuredClone(sources), actual = speech(sources);
    assert.deepEqual(triples(actual), [[0, 1, first.text], [0, secondEnd, second.text]]);
    assert.ok(actual.every((cue, index) => index === 0 || cue.start >= actual[index - 1].start));
    assert.deepEqual(sources, before);
  }
});

test('independent local-start QA: restoring one equal-start fixed row cannot activate its neighbour or alter exported ends', () => {
  const first = proof(equalStartFixed('앞 동시 합성', 1), { floor: .2 });
  const second = proof(equalStartFixed('뒤 동시 합성', 2), { floor: .3 });
  for (const sources of [[first, second], [evidence.setLocalStartEvidenceStatus(first, 'restored'), second],
    [first, evidence.setLocalStartEvidenceStatus(second, 'restored')]]) {
    const unmodified = [equalStartFixed(first.text, 1), equalStartFixed(second.text, 2)];
    assert.deepEqual(triples(speech(sources)), triples(speech(unmodified)));
    assert.equal(generateSRT(sources), generateSRT(unmodified));
    assert.equal(generateASS(sources), generateASS(unmodified));
    const zipped = createBatchSrtArchive({ items: [{ status: 'completed', label: '동시 합성 QA', segments: sources }] });
    assert.equal(zipFirstSrt(zipped.buffer), generateSRT(unmodified, null, { holdShortGaps: false }));
  }
});

test('independent local-start QA: analysis skips every equal-start competitor while unrelated cue proof or budget failure remains independent', async () => {
  for (const exhausted of [false, true]) {
    const sources = [equalStartFixed('첫 경쟁 합성', 1), equalStartFixed('둘째 경쟁 합성', 2), row('독립 합성', 3, 4)];
    const before = structuredClone(sources), rangesSeen = [], budget = createLocalAudioAnalysisBudget();
    if (exhausted) budget.windows = 12;
    const result = await annotateLocalStartEvidence(sources, { language: 'ko', originalname: 'anonymous.wav',
      buffer: nativeWave({ frames: 5000, sample: frame => frame >= 3500 ? 1 : 0 }), analysisBudget: budget,
      analyzeAudio: async (buffer, options) => { rangesSeen.push(...options.ranges); return analyzeLocalStartRanges(buffer, options); } });
    assert.deepEqual(rangesSeen, [{ start: 3, end: 4 }]);
    assert.deepEqual(result.segments.slice(0, 2), before.slice(0, 2));
    assert.deepEqual(triples(speech(result.segments)).slice(0, 2), [[0, 1, sources[0].text], [0, 2, sources[1].text]]);
    assert.equal(evidence.getBoundLocalStartEvidence(result.segments[2]).status, exhausted ? 'unavailable' : 'automatic');
    assert.equal(speech(result.segments)[2].start, exhausted ? 3 : 3.5);
    assert.deepEqual(sources, before);
  }
});
