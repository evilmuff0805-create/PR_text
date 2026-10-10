import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  WAV_READ_CHUNK_BYTES,
  inspectWavBlob,
  optimizeWavBlob,
  planWavOptimization,
} from '../client/src/utils/wav-optimization-core.js';

function createPcm16Wav({ sampleRate, channels, frames, sampleAt }) {
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
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = sampleAt
        ? sampleAt(frame, channel)
        : Math.round(Math.sin((frame / sampleRate) * Math.PI * 2 * 440) * 16_000);
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

async function readPcm16Channels(blob) {
  const metadata = await inspectWavBlob(blob);
  const view = new DataView(await blob.arrayBuffer());
  const channels = Array.from({ length: metadata.channels }, () => new Int16Array(metadata.totalFrames));
  for (let frame = 0; frame < metadata.totalFrames; frame += 1) {
    for (let channel = 0; channel < metadata.channels; channel += 1) {
      channels[channel][frame] = view.getInt16(metadata.dataOffset + frame * metadata.blockAlign + channel * 2, true);
    }
  }
  return { metadata, channels, view };
}

function peak(samples) {
  return samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
}

test('preserves PCM WAV channels and source rate when the output fits', async () => {
  const source = createPcm16Wav({ sampleRate: 48_000, channels: 2, frames: 4_800 });
  const progress = [];
  const optimized = await optimizeWavBlob(source, {
    maxOutputBytes: 150 * 1024 * 1024,
    onProgress: (value) => progress.push(value),
  });
  const metadata = await inspectWavBlob(optimized.blob);

  assert.equal(metadata.audioFormat, 1);
  assert.equal(metadata.sampleRate, 48_000);
  assert.equal(metadata.channels, 2);
  assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.totalFrames, 4_800);
  assert.equal(optimized.metadata.durationSeconds, 0.1);
  assert.equal(optimized.metadata.outputChannels, 2);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 100);
  assert.equal(optimized.blob.size, source.size);
});

test('accepts IEEE Float WAV and emits standard PCM output', async () => {
  const source = createFloat32Wav({ sampleRate: 44_100, channels: 2, frames: 4_410 });
  const optimized = await optimizeWavBlob(source, { maxOutputBytes: 150 * 1024 * 1024 });
  const metadata = await inspectWavBlob(optimized.blob);

  assert.equal(metadata.audioFormat, 1);
  assert.equal(metadata.sampleRate, 44_100);
  assert.equal(metadata.channels, 2);
  assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.totalFrames, 4_410);
  assert.ok(optimized.blob.size < source.size);
});

test('opposite-phase stereo survives size reduction without cancellation', async () => {
  const source = createPcm16Wav({
    sampleRate: 48_000, channels: 2, frames: 4_800,
    sampleAt: (frame, channel) => Math.round(Math.sin(frame / 48_000 * Math.PI * 2 * 440) * 16_000) * (channel === 0 ? 1 : -1),
  });
  const optimized = await optimizeWavBlob(source, { maxOutputBytes: 12_844 });
  const { metadata, channels } = await readPcm16Channels(optimized.blob);

  assert.equal(metadata.sampleRate, 32_000);
  assert.equal(metadata.channels, 2);
  assert.ok(peak(channels[0]) > 15_000);
  assert.ok(peak(channels[1]) > 15_000);
  for (let frame = 0; frame < metadata.totalFrames; frame += 1) {
    assert.ok(Math.abs(channels[0][frame] + channels[1][frame]) <= 1);
  }
});

test('a quiet channel does not attenuate speech in another channel', async () => {
  for (const quietChannel of [0, 1]) {
    const source = createPcm16Wav({
      sampleRate: 16_000, channels: 2, frames: 1_600,
      sampleAt: (frame, channel) => channel === quietChannel ? 0 : Math.round(Math.sin(frame / 16_000 * Math.PI * 2 * 400) * 16_000),
    });
    const optimized = await optimizeWavBlob(source, { maxOutputBytes: 150 * 1024 * 1024 });
    const { channels } = await readPcm16Channels(optimized.blob);

    assert.equal(peak(channels[quietChannel]), 0);
    assert.ok(peak(channels[1 - quietChannel]) >= 15_990);
  }
});

test('different tones remain separate in every input channel with a valid multichannel header', async () => {
  const sampleAt = (frame, channel) => Math.round(Math.sin(frame / 48_000 * Math.PI * 2 * [440, 880, 1760][channel]) * [16_000, 12_000, 8_000][channel]);
  const source = createPcm16Wav({ sampleRate: 48_000, channels: 3, frames: 4_800, sampleAt });
  const optimized = await optimizeWavBlob(source, { maxOutputBytes: 150 * 1024 * 1024 });
  const { metadata, channels, view } = await readPcm16Channels(optimized.blob);

  assert.equal(metadata.channels, 3);
  assert.equal(metadata.blockAlign, 6);
  assert.equal(view.getUint32(28, true), 48_000 * 6);
  assert.equal(view.getUint32(40, true), 4_800 * 6);
  for (let channel = 0; channel < 3; channel += 1) {
    for (let frame = 0; frame < metadata.totalFrames; frame += 1) {
      assert.ok(Math.abs(channels[channel][frame] - sampleAt(frame, channel)) <= 1);
    }
  }
});

test('plans the highest fitting rate and keeps a 20-minute stereo WAV within 150 MiB', () => {
  const metadata = { sampleRate: 48_000, channels: 2, totalFrames: 48_000 * 20 * 60 };
  const plan = planWavOptimization(metadata, 150 * 1024 * 1024);

  assert.equal(plan.outputSampleRate, 32_000);
  assert.equal(plan.outputFrames, 32_000 * 20 * 60);
  assert.equal(plan.outputDataBytes, plan.outputFrames * 4);
  assert.equal(plan.outputBytes, 153_600_044);
  assert.ok(plan.outputBytes <= 150 * 1024 * 1024);
});

test('plans complete final frames at byte limits and stops before reducing below 16 kHz', () => {
  const metadata = { sampleRate: 48_000, channels: 2, totalFrames: 4_799 };
  const exactLimit = 44 + 3_200 * 4;
  const plan = planWavOptimization(metadata, exactLimit);

  assert.equal(plan.outputSampleRate, 32_000);
  assert.equal(plan.outputFrames, 3_200);
  assert.equal(plan.outputBytes, exactLimit);
  assert.equal(planWavOptimization(metadata, exactLimit - 1).outputSampleRate, 24_000);
  assert.equal(planWavOptimization(metadata, 44 + 1_600 * 4).outputSampleRate, 16_000);
  assert.throws(
    () => planWavOptimization(metadata, 44 + 1_600 * 4 - 1),
    (error) => error.code === 'OPTIMIZED_WAV_TOO_LARGE',
  );
  assert.equal(planWavOptimization({ sampleRate: 8_000, channels: 1, totalFrames: 800 }, 1_644).outputSampleRate, 8_000);
  assert.equal(planWavOptimization({ sampleRate: 96_000, channels: 1, totalFrames: 9_600 }, 150 * 1024 * 1024).outputSampleRate, 48_000);
});

test('preserves samples across output batches and keeps the final frame and full duration', async () => {
  const frames = 131_073;
  const boundarySamples = new Map([[0, 8_000], [131_071, 16_000], [131_072, 24_000]]);
  const source = createPcm16Wav({
    sampleRate: 48_000, channels: 2, frames,
    sampleAt: (frame, channel) => (boundarySamples.get(frame) || 0) * (channel === 0 ? 1 : -1),
  });
  const optimized = await optimizeWavBlob(source, { maxOutputBytes: 150 * 1024 * 1024 });
  const { metadata, channels } = await readPcm16Channels(optimized.blob);

  assert.equal(metadata.totalFrames, frames);
  assert.equal(metadata.durationSeconds, frames / 48_000);
  for (let channel = 0; channel < 2; channel += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      const expected = (boundarySamples.get(frame) || 0) * (channel === 0 ? 1 : -1);
      assert.ok(Math.abs(channels[channel][frame] - expected) <= 1);
    }
  }
});

test('keeps the final partial frame while resampling across batch boundaries', async () => {
  const frames = 400_001;
  const source = createPcm16Wav({
    sampleRate: 44_100, channels: 2, frames,
    sampleAt: (frame, channel) => (frame === frames - 1 ? 30_000 : 10_000) * (channel === 0 ? 1 : -1),
  });
  const outputFrames = Math.ceil(frames * 32_000 / 44_100);
  const optimized = await optimizeWavBlob(source, { maxOutputBytes: 44 + outputFrames * 4 });
  const { metadata, channels } = await readPcm16Channels(optimized.blob);

  assert.equal(metadata.sampleRate, 32_000);
  assert.equal(metadata.totalFrames, outputFrames);
  assert.ok(metadata.durationSeconds >= frames / 44_100);
  assert.ok(metadata.durationSeconds - frames / 44_100 < 1 / 32_000);
  assert.ok(channels[0].at(-1) > 10_000);
  assert.ok(channels[1].at(-1) < -10_000);
  for (const boundary of [131_071, 131_072, 262_143, 262_144]) {
    assert.ok(Math.abs(channels[0][boundary] - 10_000) <= 1);
    assert.ok(Math.abs(channels[1][boundary] + 10_000) <= 1);
  }
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
