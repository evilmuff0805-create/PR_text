import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWavBlob, optimizeWavBlob } from '../client/src/utils/wav-optimization-core.js';
import { buildAudioChunkPlan, mergeChunkSegments } from '../src/services/audio-chunks.js';

function syntheticWav() {
  const sampleRate = 48000, channels = 2, frames = sampleRate * 12 + 1;
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate;
    if (!((time >= 4 && time < 4.5) || (time >= 9 && time < 9.5))) continue;
    const value = Math.round(Math.cos(time * Math.PI * 2 * 440) * 12000);
    bytes.writeInt16LE(value, 44 + frame * 4); bytes.writeInt16LE(-value, 46 + frame * 4);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

test('QA WAV size reduction preserves leading, middle and trailing silence on the same origin', async () => {
  const source = syntheticWav();
  const input = await inspectWavBlob(source);
  const reduced = await optimizeWavBlob(source, { maxOutputBytes: 1600000 });
  const output = await inspectWavBlob(reduced.blob);
  assert.equal(output.channels, 2);
  assert.equal(output.sampleRate, 32000);
  assert.ok(output.durationSeconds >= input.durationSeconds);
  assert.ok(output.durationSeconds - input.durationSeconds < 1 / output.sampleRate);
  const bytes = new DataView(await reduced.blob.arrayBuffer());
  let first = Infinity, last = -Infinity, peak = 0;
  for (let frame = 0; frame < output.totalFrames; frame++) {
    const left = bytes.getInt16(output.dataOffset + frame * output.blockAlign, true);
    const right = bytes.getInt16(output.dataOffset + frame * output.blockAlign + 2, true);
    const time = frame / output.sampleRate;
    assert.ok(Math.abs(left + right) <= 1);
    if (left !== 0) { first = Math.min(first, time); last = time; peak = Math.max(peak, Math.abs(left)); }
    if (time < 4 || (time >= 4.5 && time < 9) || time >= 9.5) assert.equal(left, 0);
  }
  assert.ok(Math.abs(first - 4) <= 1 / output.sampleRate);
  assert.ok(Math.abs(last - 9.5) <= 2 / output.sampleRate);
  assert.ok(peak > 10000);
});

test('QA per-file chunk offsets apply once and simultaneous synthetic speech remains in both tracks', () => {
  const durationSeconds = 600.25;
  const plan = buildAudioChunkPlan({ durationSeconds });
  assert.equal(plan[0].ownedStart, 0);
  assert.equal(plan.at(-1).ownedEnd, durationSeconds);
  const first = [
    { start: 179.98, end: 180.12, text: '경계 응답' },
    { start: 185.3, end: 185.55, text: '첫 트랙 응답' },
    { start: 570.001, end: 570.201, text: '마지막 응답' },
  ];
  const second = [{ start: 185.4, end: 185.65, text: '둘째 트랙 응답' }];
  const simulate = (segments) => mergeChunkSegments(plan.map(chunk => ({
    chunk, response: { segments: segments.filter(segment => segment.start >= chunk.inputStart && segment.end <= chunk.inputEnd).map(segment => ({
      ...segment, start: segment.start - chunk.inputStart, end: segment.end - chunk.inputStart,
    })) },
  })));
  for (const segments of [first, second]) {
    const merged = simulate(segments);
    assert.equal(merged.length, segments.length);
    for (const [index, expected] of segments.entries()) {
      assert.equal(merged[index].text, expected.text);
      assert.ok(Math.abs(merged[index].start - expected.start) < 1e-9);
      assert.ok(Math.abs(merged[index].end - expected.end) < 1e-9);
    }
  }
});
