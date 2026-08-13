export const WAV_READ_CHUNK_BYTES = 4 * 1024 * 1024;

const MAX_METADATA_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_HEADERS = 256;
const TARGET_SAMPLE_RATE = 16_000;

export class WavOptimizationError extends Error {
  constructor(message, code = 'WAV_OPTIMIZATION_FAILED') {
    super(message);
    this.name = 'WavOptimizationError';
    this.code = code;
  }
}

function readAscii(view, offset, length) {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

async function readView(blob, start, length) {
  const end = Math.min(start + length, blob.size);
  if (start < 0 || end <= start) {
    throw new WavOptimizationError('WAV 파일 구조를 읽을 수 없습니다.', 'INVALID_WAV');
  }
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function parseFormatChunk(view) {
  if (view.byteLength < 16) {
    throw new WavOptimizationError('WAV 오디오 형식 정보가 손상되었습니다.', 'INVALID_WAV_FORMAT');
  }

  let audioFormat = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const blockAlign = view.getUint16(12, true);
  const bitsPerSample = view.getUint16(14, true);

  if (audioFormat === 0xfffe) {
    if (view.byteLength < 40) {
      throw new WavOptimizationError('확장 WAV 형식 정보가 손상되었습니다.', 'INVALID_WAV_FORMAT');
    }
    audioFormat = view.getUint16(24, true);
  }

  const supportedBits = audioFormat === 1
    ? new Set([8, 16, 24, 32])
    : new Set([32, 64]);
  const bytesPerSample = bitsPerSample / 8;

  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new WavOptimizationError(
      '이 WAV 압축 방식은 자동 최적화를 지원하지 않습니다. PCM 또는 IEEE Float WAV로 다시 저장해주세요.',
      'UNSUPPORTED_WAV_CODEC',
    );
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) {
    throw new WavOptimizationError('지원하지 않는 WAV 채널 구성입니다.', 'UNSUPPORTED_WAV_CHANNELS');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) {
    throw new WavOptimizationError('지원하지 않는 WAV 샘플링 주파수입니다.', 'UNSUPPORTED_WAV_SAMPLE_RATE');
  }
  if (!supportedBits.has(bitsPerSample)) {
    throw new WavOptimizationError('지원하지 않는 WAV 비트 깊이입니다.', 'UNSUPPORTED_WAV_BIT_DEPTH');
  }
  if (blockAlign !== channels * bytesPerSample) {
    throw new WavOptimizationError('지원하지 않는 WAV 프레임 구조입니다.', 'UNSUPPORTED_WAV_LAYOUT');
  }

  return {
    audioFormat,
    channels,
    sampleRate,
    blockAlign,
    bitsPerSample,
    bytesPerSample,
  };
}

export async function inspectWavBlob(blob) {
  if (!blob || !Number.isFinite(blob.size) || blob.size < 44) {
    throw new WavOptimizationError('WAV 파일이 비어 있거나 너무 작습니다.', 'INVALID_WAV');
  }

  const riff = await readView(blob, 0, 12);
  if (readAscii(riff, 0, 4) !== 'RIFF' || readAscii(riff, 8, 4) !== 'WAVE') {
    throw new WavOptimizationError('RIFF/WAVE 형식의 WAV 파일이 아닙니다.', 'INVALID_WAV');
  }

  let format = null;
  let offset = 12;
  let scannedHeaders = 0;

  while (offset + 8 <= blob.size && offset <= MAX_METADATA_SCAN_BYTES) {
    if (scannedHeaders >= MAX_CHUNK_HEADERS) {
      throw new WavOptimizationError('WAV 메타데이터가 지나치게 복잡합니다.', 'UNSUPPORTED_WAV_METADATA');
    }
    scannedHeaders += 1;

    const chunkHeader = await readView(blob, offset, 8);
    const chunkId = readAscii(chunkHeader, 0, 4);
    const chunkSize = chunkHeader.getUint32(4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ') {
      const formatLength = Math.min(chunkSize, 64);
      format = parseFormatChunk(await readView(blob, chunkDataOffset, formatLength));
    } else if (chunkId === 'data') {
      if (!format) {
        throw new WavOptimizationError('WAV 오디오 형식 정보가 데이터보다 먼저 있어야 합니다.', 'INVALID_WAV');
      }
      if (chunkSize <= 0 || chunkDataOffset + chunkSize > blob.size) {
        throw new WavOptimizationError('WAV 오디오 데이터가 손상되었거나 잘렸습니다.', 'INVALID_WAV_DATA');
      }

      const usableDataBytes = chunkSize - (chunkSize % format.blockAlign);
      const totalFrames = Math.floor(usableDataBytes / format.blockAlign);
      if (totalFrames <= 0) {
        throw new WavOptimizationError('WAV 파일에 변환할 오디오가 없습니다.', 'EMPTY_WAV_DATA');
      }

      return {
        ...format,
        dataOffset: chunkDataOffset,
        dataBytes: usableDataBytes,
        totalFrames,
        durationSeconds: totalFrames / format.sampleRate,
      };
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    const nextOffset = chunkDataOffset + paddedSize;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > blob.size) {
      throw new WavOptimizationError('WAV 청크 구조가 손상되었습니다.', 'INVALID_WAV');
    }
    offset = nextOffset;
  }

  throw new WavOptimizationError('WAV 오디오 데이터를 찾을 수 없습니다.', 'INVALID_WAV_DATA');
}

function readSample(view, byteOffset, audioFormat, bitsPerSample) {
  if (audioFormat === 3) {
    const value = bitsPerSample === 32
      ? view.getFloat32(byteOffset, true)
      : view.getFloat64(byteOffset, true);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }

  if (bitsPerSample === 8) return (view.getUint8(byteOffset) - 128) / 128;
  if (bitsPerSample === 16) return view.getInt16(byteOffset, true) / 32_768;
  if (bitsPerSample === 24) {
    let value = view.getUint8(byteOffset)
      | (view.getUint8(byteOffset + 1) << 8)
      | (view.getUint8(byteOffset + 2) << 16);
    if (value & 0x800000) value |= 0xff000000;
    return value / 8_388_608;
  }
  return view.getInt32(byteOffset, true) / 2_147_483_648;
}

function readMonoFrame(view, frameIndex, metadata) {
  const frameOffset = frameIndex * metadata.blockAlign;
  let sum = 0;
  for (let channel = 0; channel < metadata.channels; channel += 1) {
    sum += readSample(
      view,
      frameOffset + channel * metadata.bytesPerSample,
      metadata.audioFormat,
      metadata.bitsPerSample,
    );
  }
  return sum / metadata.channels;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function createPcmWavHeader({ sampleRate, dataBytes }) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

function toPcm16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767);
}

export async function optimizeWavBlob(blob, { maxOutputBytes, onProgress } = {}) {
  const metadata = await inspectWavBlob(blob);
  const outputSampleRate = Math.min(metadata.sampleRate, TARGET_SAMPLE_RATE);
  const inputFramesPerOutput = metadata.sampleRate / outputSampleRate;
  const outputFrames = Math.ceil(metadata.totalFrames / inputFramesPerOutput);
  const outputDataBytes = outputFrames * 2;
  const outputBytes = outputDataBytes + 44;

  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 44) {
    throw new WavOptimizationError('최적화 파일 크기 제한이 올바르지 않습니다.', 'INVALID_OUTPUT_LIMIT');
  }
  if (outputBytes > maxOutputBytes) {
    throw new WavOptimizationError(
      '최적화 후에도 파일이 150MB를 초과합니다. WAV를 여러 파일로 나눈 뒤 다시 시도해주세요.',
      'OPTIMIZED_WAV_TOO_LARGE',
    );
  }

  const sourceFramesPerBatch = Math.max(
    1,
    Math.floor((WAV_READ_CHUNK_BYTES - (2 * metadata.blockAlign)) / metadata.blockAlign),
  );
  const outputFramesPerBatch = Math.max(
    1,
    Math.min(131_072, Math.floor(sourceFramesPerBatch / inputFramesPerOutput)),
  );
  const outputParts = [];

  onProgress?.(0);

  for (let outputStart = 0; outputStart < outputFrames; outputStart += outputFramesPerBatch) {
    const outputEnd = Math.min(outputFrames, outputStart + outputFramesPerBatch);
    const sourceStart = Math.floor(outputStart * inputFramesPerOutput);
    const sourceEnd = Math.min(
      metadata.totalFrames,
      Math.ceil(outputEnd * inputFramesPerOutput),
    );
    const sourceBuffer = await blob.slice(
      metadata.dataOffset + sourceStart * metadata.blockAlign,
      metadata.dataOffset + sourceEnd * metadata.blockAlign,
    ).arrayBuffer();
    const sourceView = new DataView(sourceBuffer);
    const outputBuffer = new ArrayBuffer((outputEnd - outputStart) * 2);
    const outputView = new DataView(outputBuffer);

    for (let outputIndex = outputStart; outputIndex < outputEnd; outputIndex += 1) {
      const windowStart = outputIndex * inputFramesPerOutput;
      const windowEnd = Math.min(
        metadata.totalFrames,
        (outputIndex + 1) * inputFramesPerOutput,
      );
      const firstInputFrame = Math.floor(windowStart);
      const lastInputFrame = Math.ceil(windowEnd);
      let weightedSum = 0;
      let totalWeight = 0;

      for (let inputFrame = firstInputFrame; inputFrame < lastInputFrame; inputFrame += 1) {
        const weight = Math.min(windowEnd, inputFrame + 1) - Math.max(windowStart, inputFrame);
        if (weight <= 0) continue;
        weightedSum += readMonoFrame(sourceView, inputFrame - sourceStart, metadata) * weight;
        totalWeight += weight;
      }

      const sample = totalWeight > 0 ? weightedSum / totalWeight : 0;
      outputView.setInt16((outputIndex - outputStart) * 2, toPcm16(sample), true);
    }

    outputParts.push(new Uint8Array(outputBuffer));
    onProgress?.(Math.round((outputEnd / outputFrames) * 100));
  }

  const header = createPcmWavHeader({
    sampleRate: outputSampleRate,
    dataBytes: outputDataBytes,
  });
  const outputBlob = new Blob([header, ...outputParts], { type: 'audio/wav' });

  return {
    blob: outputBlob,
    metadata: {
      inputBytes: blob.size,
      outputBytes: outputBlob.size,
      inputSampleRate: metadata.sampleRate,
      outputSampleRate,
      inputChannels: metadata.channels,
      durationSeconds: metadata.durationSeconds,
    },
  };
}
