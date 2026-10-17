// Only a proven prefix of exact digital zero can establish this lower bound.
// Keep native channels and sample precision; this is not a volume threshold or VAD.
export function getDigitalSilenceStart(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  const limit = buffer.readUInt32LE(4) + 8;
  if (limit > buffer.length || limit < 44) return null;
  let format = null;
  let data = null;
  let cursor = 12;
  while (cursor + 8 <= limit) {
    const name = buffer.toString('ascii', cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    if (start + size > limit) return null;
    if (name === 'fmt ') {
      if (format || size < 16) return null;
      let encoding = buffer.readUInt16LE(start);
      const channels = buffer.readUInt16LE(start + 2);
      const sampleRate = buffer.readUInt32LE(start + 4);
      const blockAlign = buffer.readUInt16LE(start + 12);
      const bits = buffer.readUInt16LE(start + 14);
      if (encoding === 0xfffe) {
        if (size < 40 || buffer.readUInt16LE(start + 16) < 22
          || buffer.subarray(start + 28, start + 40).toString('hex') !== '00001000800000aa00389b71') return null;
        encoding = buffer.readUInt32LE(start + 24);
      }
      if (![1, 3].includes(encoding) || !Number.isSafeInteger(channels) || channels < 1 || channels > 64
        || sampleRate < 1 || sampleRate > 384_000
        || (encoding === 1 && ![8, 16, 24, 32].includes(bits))
        || (encoding === 3 && ![32, 64].includes(bits))
        || blockAlign !== channels * (bits / 8)) return null;
      format = { encoding, channels, sampleRate, blockAlign, bytes: bits / 8 };
    } else if (name === 'data') {
      if (data || size === 0) return null;
      data = { start, size };
    }
    cursor = start + size + (size & 1);
    if (cursor > limit) return null;
  }
  if (cursor !== limit || !format || !data || data.size % format.blockAlign) return null;
  const { encoding, channels, sampleRate, blockAlign, bytes } = format;
  const frames = data.size / blockAlign;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = data.start + frame * blockAlign + channel * bytes;
      const sample = encoding === 3
        ? (bytes === 4 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset))
        : (bytes === 1 ? buffer[offset] - 128 : buffer.readIntLE(offset, bytes));
      if (!Number.isFinite(sample)) return null;
      if (sample !== 0) return frame / sampleRate;
    }
  }
  // An all-zero file cannot establish where a spoken caption belongs.
  return null;
}

export function attachVerifiedAudioStartFloor(segments, buffer) {
  const floor = getDigitalSilenceStart(buffer);
  if (floor === null || floor <= 0 || !Array.isArray(segments)) return segments;
  return segments.map((segment) => {
    if (!segment || typeof segment !== 'object'
      || typeof segment.start !== 'number' || !Number.isFinite(segment.start)
      || typeof segment.end !== 'number' || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.start >= floor || segment.end <= floor) return segment;
    // Leave provider start/end and every word untouched. The Korean renderer
    // can use this separate bound without legitimizing incomplete word data.
    return { ...segment, audioStartFloor: floor };
  });
}
