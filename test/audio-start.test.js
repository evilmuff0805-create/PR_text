import assert from 'node:assert/strict';
import test from 'node:test';
import { attachVerifiedAudioStartFloor, getDigitalSilenceStart } from '../src/services/audio-start.js';

function wav({ channels = 1, rate = 1000, bits = 16, floating = false, frames = 10, nonzero = 5, channel = 0, sample = 1 } = {}) {
  const bytes = bits / 8;
  const payload = Buffer.alloc(frames * channels * bytes, bits === 8 && !floating ? 128 : 0);
  const offset = nonzero * channels * bytes + channel * bytes;
  if (nonzero < frames) {
    if (floating) bits === 32 ? payload.writeFloatLE(sample, offset) : payload.writeDoubleLE(sample, offset);
    else if (bits === 8) payload[offset] = sample + 128;
    else payload.writeIntLE(sample, offset, bytes);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + payload.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(floating ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytes, 28); header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bits, 34); header.write('data', 36); header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

test('native PCM silence ends at the first nonzero frame without a volume threshold', () => {
  for (const bits of [8, 16, 24, 32]) assert.equal(getDigitalSilenceStart(wav({ bits, sample: 1 })), 0.005);
  for (const bits of [32, 64]) assert.equal(getDigitalSilenceStart(wav({ bits, floating: true, sample: 1e-20 })), 0.005);
});

test('every original channel participates, including opposite-phase speech', () => {
  const audio = wav({ channels: 2, channel: 1, nonzero: 3, sample: 1 });
  assert.equal(getDigitalSilenceStart(audio), 0.003);
  audio.writeInt16LE(100, 44 + 3 * 4); audio.writeInt16LE(-100, 44 + 3 * 4 + 2);
  assert.equal(getDigitalSilenceStart(audio), 0.003);
});

test('unsupported, malformed, all-zero and nonfinite audio establishes no bound', () => {
  const truncated = wav().subarray(0, 45);
  const invalidBlock = wav(); invalidBlock.writeUInt16LE(8, 32);
  const invalidFloat = wav({ floating: true, bits: 32, sample: NaN });
  const unknown = wav(); unknown.writeUInt16LE(6, 20);
  for (const value of [null, Buffer.alloc(44), truncated, invalidBlock, invalidFloat, unknown, wav({ nonzero: 10 })]) {
    assert.equal(getDigitalSilenceStart(value), null);
  }
});

test('annotation preserves raw timing, words, input and captions with no signal inside their range', () => {
  const source = [
    { start: 0.001, end: 0.009, text: '첫 말', sourceWords: [{ word: '첫', start: 0.001, end: 0.008 }] },
    { start: 0.006, end: 0.009, text: '다음 말' },
    { start: 0, end: 0.002, text: '범위 밖' },
  ];
  const before = structuredClone(source);
  const output = attachVerifiedAudioStartFloor(source, wav());
  assert.deepEqual(source, before);
  assert.deepEqual(output[0], { ...source[0], audioStartFloor: 0.005 });
  assert.strictEqual(output[1], source[1]); assert.strictEqual(output[2], source[2]);
  assert.strictEqual(attachVerifiedAudioStartFloor(source, Buffer.alloc(44)), source);
});

test('signal at the origin and unsigned 8-bit silence keep the shared audio origin', () => {
  assert.equal(getDigitalSilenceStart(wav({ nonzero: 0 })), 0);
  assert.equal(getDigitalSilenceStart(wav({ bits: 8, nonzero: 4 })), 0.004);
});

test('ordinary transcription attaches evidence without changing the provider word sequence', async () => {
  process.env.OPENAI_API_KEY ??= 'synthetic-test-key';
  process.env.SILENCE_OBSERVATION_MODE = 'off';
  const { Transcriptions } = await import('openai/resources/audio/transcriptions');
  const create = Transcriptions.prototype.create;
  let calls = 0;
  const provider = { text: '네 네 네', language: 'korean', segments: [{ start: 0.001, end: 0.009, text: '네 네 네' }],
    words: [{ word: '네', start: 0.001, end: 0.007 }, { word: '네', start: 0.007, end: 0.007 }, { word: '네', start: 0.007, end: 0.009 }] };
  Transcriptions.prototype.create = async request => {
    calls += 1;
    assert.equal(request.model, 'whisper-1');
    assert.deepEqual(request.timestamp_granularities, ['segment', 'word']);
    return structuredClone(provider);
  };
  try {
    const { transcribe } = await import('../src/services/whisper.js');
    const result = await transcribe(wav(), 'synthetic.wav', 'ko');
    assert.equal(calls, 1);
    assert.equal(result.segments[0].audioStartFloor, 0.005);
    assert.equal(result.segments[0].start, 0.001);
    assert.equal(result.segments[0].text, '네 네 네');
    assert.equal(result.segments[0].sourceWords.length, 2);
    assert.equal(result.segments[0].sourceWords[0].start, 0.001);
    assert.equal(provider.words.length, 3);
  } finally { Transcriptions.prototype.create = create; }
});
