import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import test from 'node:test';
import {
  detectQuietIntervals,
  findSilenceCandidates,
  observeSilentTranscript,
  SILENCE_CANDIDATE_THRESHOLDS,
  SILENCE_OBSERVATION_LIMITS,
  createSilenceObservationScheduler,
} from '../src/services/silence-observation.js';

const base = Object.freeze({ start: 20, end: 21, text: 'synthetic text', no_speech_prob: 0.95, avg_logprob: -1.2 });
test('candidate requires confidence thresholds and the padded segment wholly inside silence', () => {
  assert.deepEqual(findSilenceCandidates([base], [{ start: 19.75, end: 21.25 }]), [{ segmentIndex: 0 }]);
  assert.deepEqual(findSilenceCandidates([base], [{ start: 19.76, end: 21.25 }]), []);
  assert.deepEqual(findSilenceCandidates([base], [{ start: 19.75, end: 21.24 }]), []);
  assert.deepEqual(findSilenceCandidates([{ ...base, no_speech_prob: 0.79 }], [{ start: 19, end: 22 }]), []);
  assert.deepEqual(findSilenceCandidates([{ ...base, avg_logprob: -0.49 }], [{ start: 19, end: 22 }]), []);
  const intervals = [{ start: 0, end: 100 }, { start: 1, end: 2 }];
  const intervalSnapshot = structuredClone(intervals);
  assert.deepEqual(findSilenceCandidates([{ ...base, start: 50, end: 51 }], intervals), [{ segmentIndex: 0 }]);
  assert.deepEqual(intervals, intervalSnapshot);
});
test('invalid, missing, out-of-range, and speaker metadata is preserved from candidacy', () => {
  const invalid = [
    { ...base, start: NaN }, { ...base, end: 20 }, { ...base, no_speech_prob: null },
    { ...base, no_speech_prob: 1.01 }, { ...base, avg_logprob: Infinity },
    { ...base, speaker: 0 }, { ...base, avg_logprob: undefined },
  ];
  assert.deepEqual(findSilenceCandidates(invalid, [{ start: 0, end: 100 }]), []);
});
test('provider segments and metadata remain unchanged by observation', async () => {
  const segments = [{ ...base, sourceWords: [{ word: 'synthetic' }] }];
  const before = structuredClone(segments);
  const result = await observeSilentTranscript({ buffer: Buffer.from('fixture'), segments, detect: async () => [{ start: 19, end: 22 }] });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.validConfidenceMetadataCount, 1);
  assert.deepEqual(segments, before);
});
test('ffmpeg receives original multichannel audio without downmix and temp file is removed', async () => {
  let inputPath;
  const intervals = await detectQuietIntervals(Buffer.from('fixture'), 'private-name.wav', {
    runFfmpeg: async (bin, args, options) => {
      inputPath = args[args.indexOf('-i') + 1];
      assert.equal(bin, 'ffmpeg');
      assert.ok(args.includes('-map') && args.includes('0:a:0'));
      assert.ok(args.includes('asetpts=PTS-STARTPTS,silencedetect=noise=-50dB:d=0.5'));
      assert.equal(args.includes('-ac'), false);
      assert.equal(options.timeout, SILENCE_OBSERVATION_LIMITS.timeoutMs);
      assert.equal(options.maxBuffer, SILENCE_OBSERVATION_LIMITS.maxBufferBytes);
      assert.equal(options.killSignal, 'SIGKILL');
      await stat(inputPath);
      return { stderr: '[silencedetect] silence_start: 0.000 | silence_end: 4.000 | silence_duration: 4.000' };
    },
  });
  assert.deepEqual(intervals, [{ start: 0, end: 4 }]);
  await assert.rejects(stat(inputPath), { code: 'ENOENT' });
});
test('ffmpeg errors are privacy-safe and do not fail the transcription result', async () => {
  const result = await observeSilentTranscript({ buffer: Buffer.from('x'), originalname: 'secret.wav', segments: [base], detect: async () => { throw Object.assign(new Error('secret file path'), { code: 'ENOENT' }); } });
  assert.equal(result.outcome, 'ffmpeg_error');
  assert.equal(result.candidateCount, 0);
  assert.equal(Object.hasOwn(result, 'error'), false);
});
test('abort is propagated as the existing ABORTED outcome', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(observeSilentTranscript({ buffer: Buffer.from('x'), segments: [base], signal: controller.signal, detect: async () => { throw controller.signal.reason; } }), { code: 'ABORTED' });
});
test('ffmpeg interval parser rejects partial invalid timestamp matches', async () => {
  const result = await detectQuietIntervals(Buffer.from('fixture'), 'x.wav', { runFfmpeg: async () => ({ stderr: 'x silence_start: -0.3 x silence_end: 1.0 | silence_duration: 1.3\nsilence_start: 2e0 | silence_end: 4e0 | silence_duration: 2e0' }) });
  assert.deepEqual(result, [{ start: 2, end: 4 }]);
});
test('ffmpeg failure also removes the temporary source file', async () => {
  let inputPath;
  await assert.rejects(detectQuietIntervals(Buffer.from('fixture'), 'private.wav', {
    runFfmpeg: async (_bin, args) => {
      inputPath = args[args.indexOf('-i') + 1];
      throw Object.assign(new Error('ffmpeg failed'), { code: 'ENOENT' });
    },
  }), { code: 'ENOENT' });
  await assert.rejects(stat(inputPath), { code: 'ENOENT' });
});

test('shadow scheduler returns immediately, allows only one task, and stores no subtitle text', async () => {
  const events = [];
  let release;
  let observed;
  const scheduler = createSilenceObservationScheduler({
    mode: 'shadow',
    logger: (event) => events.push(event),
    observe: async ({ segments }) => {
      observed = segments;
      await new Promise((resolve) => { release = resolve; });
      return { outcome: 'ok', candidateCount: 0, durationMs: 1 };
    },
  });
  const first = scheduler.schedule({ buffer: Buffer.from('small'), segments: [base] });
  assert.equal(first, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed[0].text, undefined);
  scheduler.schedule({ buffer: Buffer.from('second'), segments: [base] });
  assert.equal(events.at(-1).reason, 'busy');
  release();
  await scheduler.stop();
  assert.equal(events.some((event) => event.outcome === 'ok'), true);
});

test('shadow scheduler skips oversized input and off mode starts no work', async () => {
  const events = [];
  let called = false;
  const shadow = createSilenceObservationScheduler({
    mode: 'shadow', maxAudioBytes: 1, logger: (event) => events.push(event),
    observe: async () => { called = true; return { outcome: 'ok' }; },
  });
  shadow.schedule({ buffer: Buffer.from('oversized'), segments: [base] });
  assert.equal(events.at(-1).reason, 'audio_size');
  shadow.schedule({ buffer: Buffer.from('x'), segments: Array(20_001).fill(base) });
  assert.equal(events.at(-1).reason, 'segment_limit');
  const off = createSilenceObservationScheduler({ mode: 'off', observe: async () => { called = true; } });
  off.schedule({ buffer: Buffer.from('small'), segments: [base] });
  assert.equal(called, false);
  await shadow.stop();
  await off.stop();
});

test('request cancellation and shutdown abort background analysis and await cleanup', async () => {
  const events = [];
  let cleaned = false;
  const scheduler = createSilenceObservationScheduler({
    mode: 'shadow', logger: (event) => events.push(event),
    observe: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { cleaned = true; reject(signal.reason); }, { once: true });
    }),
  });
  const controller = new AbortController();
  scheduler.schedule({ buffer: Buffer.from('x'), segments: [base], signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await scheduler.stop();
  assert.equal(cleaned, true);
  assert.equal(events.some((event) => event.outcome === 'aborted'), true);
});

test('deadline abort is measured and logger failures never escape to transcription', async () => {
  const events = [];
  const scheduler = createSilenceObservationScheduler({
    mode: 'shadow', timeoutMs: 5, logger: (event) => { events.push(event); throw new Error('sink failure'); },
    observe: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  assert.doesNotThrow(() => scheduler.schedule({ buffer: Buffer.from('x'), segments: [base] }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  await scheduler.stop();
  assert.equal(events[0].outcome, 'deadline');
  assert.ok(events[0].durationMs >= 0 && events[0].durationMs < 1000);
});
