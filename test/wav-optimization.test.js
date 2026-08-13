import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  WAV_READ_CHUNK_BYTES,
  inspectWavBlob,
  optimizeWavBlob,
} from '../client/src/utils/wav-optimization-core.js';

function createPcm16Wav({ sampleRate, channels, frames }) {
  const dataBytes = frames * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin((frame / sampleRate) * Math.PI * 2 * 440) * 16_000);
    for (let channel = 0; channel < channels; channel += 1) {
      view.setInt16(44 + (frame * channels + channel) * 2, sample, true);
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function createFloat32Wav({ sampleRate, channels, frames }) {
  const dataBytes = frames * channels * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.sin((frame / sampleRate) * Math.PI * 2 * 220) * 0.5;
    for (let channel = 0; channel < channels; channel += 1) {
      view.setFloat32(44 + (frame * channels + channel) * 4, sample, true);
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

test('downmixes and downsamples PCM WAV to speech-ready mono 16-bit WAV', async () => {
  const source = createPcm16Wav({ sampleRate: 48_000, channels: 2, frames: 4_800 });
  const progress = [];
  const optimized = await optimizeWavBlob(source, {
    maxOutputBytes: 150 * 1024 * 1024,
    onProgress: (value) => progress.push(value),
  });
  const metadata = await inspectWavBlob(optimized.blob);

  assert.equal(metadata.audioFormat, 1);
  assert.equal(metadata.sampleRate, 16_000);
  assert.equal(metadata.channels, 1);
  assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.totalFrames, 1_600);
  assert.equal(optimized.metadata.durationSeconds, 0.1);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 100);
  assert.ok(optimized.blob.size < source.size);
});

test('accepts IEEE Float WAV and emits standard PCM output', async () => {
  const source = createFloat32Wav({ sampleRate: 44_100, channels: 2, frames: 4_410 });
  const optimized = await optimizeWavBlob(source, { maxOutputBytes: 150 * 1024 * 1024 });
  const metadata = await inspectWavBlob(optimized.blob);

  assert.equal(metadata.audioFormat, 1);
  assert.equal(metadata.sampleRate, 16_000);
  assert.equal(metadata.channels, 1);
  assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.totalFrames, 1_600);
});

test('reads large PCM data in bounded slices', async () => {
  const source = createPcm16Wav({ sampleRate: 48_000, channels: 2, frames: 1_200_000 });
  const sliceSizes = [];
  const trackedSource = {
    size: source.size,
    slice(start, end) {
      sliceSizes.push(end - start);
      return source.slice(start, end);
    },
  };

  await optimizeWavBlob(trackedSource, { maxOutputBytes: 150 * 1024 * 1024 });

  assert.ok(Math.max(...sliceSizes) <= WAV_READ_CHUNK_BYTES);
  assert.ok(sliceSizes.length > 3);
});

test('rejects unsupported compressed WAV codecs before optimization', async () => {
  const source = createPcm16Wav({ sampleRate: 48_000, channels: 2, frames: 100 });
  const bytes = new Uint8Array(await source.arrayBuffer());
  new DataView(bytes.buffer).setUint16(20, 6, true);

  await assert.rejects(
    inspectWavBlob(new Blob([bytes])),
    (error) => error.code === 'UNSUPPORTED_WAV_CODEC',
  );
});

test('rejects truncated WAV data before doing conversion work', async () => {
  const source = createPcm16Wav({ sampleRate: 48_000, channels: 2, frames: 100 });
  const truncated = source.slice(0, source.size - 10);

  await assert.rejects(
    inspectWavBlob(truncated),
    (error) => error.code === 'INVALID_WAV_DATA',
  );
});

test('rejects a WAV whose optimized output would still exceed the upload limit', async () => {
  const source = createPcm16Wav({ sampleRate: 8_000, channels: 1, frames: 8_000 });

  await assert.rejects(
    optimizeWavBlob(source, { maxOutputBytes: 1_000 }),
    (error) => error.code === 'OPTIMIZED_WAV_TOO_LARGE',
  );
});

test('wires optimization progress and the strict pre-upload gate into the client', async () => {
  const [homePage, provider, worker] = await Promise.all([
    readFile(new URL('../client/src/pages/HomePage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/contexts/TranscriptionContext.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/src/workers/wav-optimizer.worker.js', import.meta.url), 'utf8'),
  ]);

  assert.match(homePage, /shouldOptimizeWavUpload\(selected\)/);
  assert.match(homePage, /optimizeLargeWavForUpload\(selected/);
  assert.match(homePage, /아직 업로드되거나 차감되지 않았습니다/);
  assert.match(homePage, /validatePreparedUploadFile\(file\)/);
  assert.match(provider, /validatePreparedUploadFile\(file\)/);
  assert.match(worker, /optimizeWavBlob\(event\.data\.file/);
});
