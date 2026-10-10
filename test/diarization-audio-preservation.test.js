import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';

const {
  buildAudioCompressionArguments,
  createTranscriptionWithFallback,
  prepareDiarizationAudioForStorage,
  transcribeWithDiarization,
} = await import('../src/services/whisper.js');

const providerResponse = {
  text: '네. 알겠습니다.',
  language: 'ko',
  segments: [
    { start: 1, end: 1.15, text: '네.', speaker: 'voice-a' },
    { start: 1.4, end: 1.9, text: '알겠습니다.', speaker: 'voice-b' },
  ],
};

function apiFixture({ rejectFirst = false } = {}) {
  const requests = [];
  const conversions = [];
  const converted = Buffer.from('synthetic-converted-audio');
  return {
    requests,
    conversions,
    converted,
    dependencies: {
      client: { audio: { transcriptions: { async create(params, options) {
        requests.push({
          params,
          options,
          bytes: Buffer.from(await params.file.arrayBuffer()),
        });
        if (rejectFirst && requests.length === 1) {
          throw Object.assign(new Error('Invalid file format'), { status: 400 });
        }
        return providerResponse;
      } } } },
      async convertAudio(buffer, filename, options) {
        conversions.push({ buffer, filename, options });
        return converted;
      },
    },
  };
}

test('diarization submits supported M4A bytes before trying any lossy conversion', async () => {
  const fixture = apiFixture();
  const buffer = Buffer.from('synthetic-original-m4a');
  const result = await transcribeWithDiarization(
    buffer, 'recording.m4a', 'ko', { durationSeconds: 2 }, fixture.dependencies,
  );

  assert.equal(fixture.conversions.length, 0);
  assert.deepEqual(fixture.requests[0].bytes, buffer);
  assert.match(fixture.requests[0].params.file.name, /\.m4a$/);
  assert.equal(result.timings.preconvertedM4a, false);
  assert.equal(result.timings.compressionMs, 0);
  assert.deepEqual(result.segments, [
    { start: 1, end: 1.15, text: '네.', speaker: 0 },
    { start: 1.4, end: 1.9, text: '알겠습니다.', speaker: 1 },
  ]);
  assert.equal(fixture.requests[0].params.chunking_strategy, 'auto');
  assert.equal('prompt' in fixture.requests[0].params, false);
  assert.equal('num_speakers' in fixture.requests[0].params, false);
});

test('an M4A provider format rejection uses one diarization conversion and preserves request cancellation', async () => {
  const fixture = apiFixture({ rejectFirst: true });
  const signal = new AbortController().signal;
  const buffer = Buffer.from('synthetic-original-m4a');
  const result = await transcribeWithDiarization(
    buffer, 'recording.m4a', 'ko', { durationSeconds: 2, signal }, fixture.dependencies,
  );

  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[0].bytes, buffer);
  assert.deepEqual(fixture.requests[1].bytes, fixture.converted);
  assert.equal(fixture.requests[1].params.file.name, 'converted.mp3');
  assert.equal(fixture.conversions.length, 1);
  assert.equal(fixture.conversions[0].buffer, buffer);
  assert.deepEqual(fixture.conversions[0].options, { diarize: true });
  assert.equal(fixture.requests[1].options.signal, signal);
  assert.equal(fixture.requests[1].options.maxRetries, 1);
  assert.deepEqual(result.timings.openaiAttempts.map(({ phase, outcome }) => ({ phase, outcome })), [
    { phase: 'initial', outcome: 'error' },
    { phase: 'format_fallback', outcome: 'success' },
  ]);
});

test('other rejected supported formats also use the diarization conversion policy', async () => {
  const fixture = apiFixture({ rejectFirst: true });
  await transcribeWithDiarization(
    Buffer.from('synthetic-original-wav'), 'recording.wav', 'ko', {}, fixture.dependencies,
  );

  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.conversions[0].options, { diarize: true });
});

test('diarization converts provider-sized inputs with its own audio policy', async () => {
  const fixture = apiFixture();
  const buffer = Buffer.alloc(25 * 1024 * 1024);
  await transcribeWithDiarization(buffer, 'recording.wav', 'ko', {}, fixture.dependencies);

  assert.equal(fixture.conversions.length, 1);
  assert.equal(fixture.conversions[0].buffer, buffer);
  assert.deepEqual(fixture.conversions[0].options, { diarize: true });
  assert.equal(fixture.requests[0].params.file.name, 'compressed.mp3');
  assert.deepEqual(fixture.requests[0].bytes, fixture.converted);
});

test('queued diarization keeps small originals and uses the same policy above the storage limit', async () => {
  const fixture = apiFixture();
  const buffer = Buffer.from('synthetic-small-original');
  const original = await prepareDiarizationAudioForStorage({
    buffer, originalname: 'recording.m4a', contentType: 'audio/mp4',
  }, fixture.dependencies);
  assert.equal(original.buffer, buffer);
  assert.equal(original.filename, 'recording.m4a');
  assert.equal(original.converted, false);
  assert.equal(fixture.conversions.length, 0);

  const large = Buffer.alloc(45 * 1024 * 1024 + 1);
  const prepared = await prepareDiarizationAudioForStorage({
    buffer: large, originalname: 'recording.mp4', contentType: 'video/mp4',
  }, fixture.dependencies);
  assert.equal(fixture.conversions[0].buffer, large);
  assert.deepEqual(fixture.conversions[0].options, { diarize: true });
  assert.equal(prepared.buffer, fixture.converted);
  assert.equal(prepared.filename, 'queued-audio.mp3');
  assert.equal(prepared.contentType, 'audio/mpeg');
  assert.equal(prepared.converted, true);
});

test('diarization conversion avoids forced mono and downsampling without silence filters', () => {
  const args = buildAudioCompressionArguments('input.wav', 'output.mp3', { diarize: true });
  assert.equal(args[args.indexOf('-b:a') + 1], '128k');
  assert.ok(args.includes('-vn'));
  assert.equal(args.includes('-ac'), false);
  assert.equal(args.includes('-ar'), false);
  assert.equal(args.includes('-af'), false);
  assert.equal(args.includes('-ss'), false);
  assert.equal(args.includes('-t'), false);
});

test('ordinary transcription keeps its existing M4A compatibility conversion and 32kbps policy', async () => {
  const fixture = apiFixture();
  const result = await createTranscriptionWithFallback({
    buffer: Buffer.from('synthetic-m4a'),
    originalname: 'recording.m4a',
    params: { model: 'whisper-1', response_format: 'verbose_json' },
    logPrefix: 'whisper',
  }, fixture.dependencies);

  assert.equal(fixture.conversions.length, 1);
  assert.deepEqual(fixture.conversions[0].options, { diarize: false });
  assert.equal(result.timings.preconvertedM4a, true);
  assert.deepEqual(buildAudioCompressionArguments('input.m4a', 'output.mp3'), [
    '-i', 'input.m4a', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-y', 'output.mp3',
  ]);
});
