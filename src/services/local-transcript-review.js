import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeLanguage } from './language.js';
import { alignKoreanSegmentWithWordTimings } from './korean-word-timing.js';
import { buildSubtitleCues, SUBTITLE_SOURCE_INDICES } from './subtitle.js';
import { mergeSubtitleReviews } from './subtitle-review.js';

const execFileAsync = promisify(execFile);
export const LOCAL_TRANSCRIPT_LIMITS = Object.freeze({
  maxAudioBytes: 32 * 1024 * 1024, maxDecodedBytes: 32 * 1024 * 1024,
  timeoutMs: 10_000, maxThreads: 1, maxWindows: 12, maxWindowSeconds: 20,
  maxTotalWindowSeconds: 60, paddingSeconds: .25, maxSegments: 20_000,
});
export const LOCAL_TRANSCRIPT_THRESHOLDS = Object.freeze({
  minRepeatCount: 3, minRepeatCharacters: 8, minRepeatSpanSeconds: 4,
  maxAverageLogProbability: -.5, minNoSpeechProbability: .8,
  maxCompressedSeconds: .3, minCompressedCharacters: 8,
});
let analyzing = false;
export function createLocalAudioAnalysisBudget() {
  return { deadline: Date.now() + LOCAL_TRANSCRIPT_LIMITS.timeoutMs, windows: 0, totalSeconds: 0, decodedBytes: 0 };
}
export function tryAcquireLocalAudioAnalysis() {
  if (analyzing) return null;
  analyzing = true;
  return () => { analyzing = false; };
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validRange = value => value && finite(value.start) && finite(value.end) && value.start >= 0 && value.end > value.start;
const hasSpeaker = value => value?.speaker !== undefined && value.speaker !== null && value.speaker !== '';
const speech = text => String(text ?? '').normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');
const repeatedKey = text => String(text ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').replace(/[.!?…]+$/u, '');
const sourceKey = value => `${value.start}:${value.end}:${String(value.text ?? '').normalize('NFC').replace(/[,，]/gu, '').trim()}`;
const groupId = text => `repeat_${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

// Parse native samples directly. PCM16 conversion, resampling, downmixing,
// threshold filters, padding, and noise gates must never establish exact zero.
export function parseNativeWave(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  const limit = buffer.readUInt32LE(4) + 8;
  if (limit > buffer.length || limit < 44) return null;
  let format;
  let data;
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
      const byteRate = buffer.readUInt32LE(start + 8);
      const blockAlign = buffer.readUInt16LE(start + 12);
      const bits = buffer.readUInt16LE(start + 14);
      if (encoding === 0xfffe) {
        if (size < 40 || buffer.readUInt16LE(start + 16) < 22
          || buffer.subarray(start + 28, start + 40).toString('hex') !== '00001000800000aa00389b71') return null;
        const validBits = buffer.readUInt16LE(start + 18);
        if (validBits !== 0 && validBits !== bits) return null;
        encoding = buffer.readUInt32LE(start + 24);
      }
      if (![1, 3].includes(encoding) || channels < 1 || channels > 64 || sampleRate < 1 || sampleRate > 384_000
        || (encoding === 1 && ![8, 16, 24, 32].includes(bits))
        || (encoding === 3 && ![32, 64].includes(bits))
        || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) return null;
      format = { encoding, channels, sampleRate, blockAlign, bits, bytes: bits / 8 };
    } else if (name === 'data') {
      if (data || !size) return null;
      data = { start, size };
    }
    cursor = start + size + (size & 1);
    if (cursor > limit) return null;
  }
  if (cursor !== limit || !format || !data || data.size % format.blockAlign) return null;
  return { ...format, ...data, frames: data.size / format.blockAlign };
}

function measureSamples(buffer, wave, start, end) {
  const first = Math.floor(start * wave.sampleRate);
  // The file's exact duration already has an integer frame boundary. Do not
  // multiply it back into a spurious extra frame (e.g. 2.2 * 48,000).
  const last = end === wave.frames / wave.sampleRate ? wave.frames : Math.ceil(end * wave.sampleRate);
  return measureFrames(buffer, wave, first, last);
}

function measureFrames(buffer, wave, first, last) {
  if (first < 0 || last > wave.frames || last <= first) return 'unavailable';
  for (let frame = first; frame < last; frame += 1) {
    for (let channel = 0; channel < wave.channels; channel += 1) {
      const offset = wave.start + frame * wave.blockAlign + channel * wave.bytes;
      const sample = wave.encoding === 3
        ? (wave.bytes === 4 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset))
        : (wave.bytes === 1 ? buffer[offset] - 128 : buffer.readIntLE(offset, wave.bytes));
      if (!Number.isFinite(sample)) return 'unavailable';
      if (sample !== 0) return 'signal_present';
    }
  }
  return 'exact_zero';
}

/** Local measurements only. Ranges already include the caller's safety margin. */
export async function analyzeExactSilenceRanges(buffer, { originalname, ranges = [], signal, runProcess = execFileAsync, budget = createLocalAudioAnalysisBudget() } = {}) {
  if (!ranges.length) return { measurements: [] };
  const unavailable = reason => ({ measurements: ranges.map(range => ({ ...range, status: 'unavailable', reason })) });
  if (!Buffer.isBuffer(buffer) || buffer.length > LOCAL_TRANSCRIPT_LIMITS.maxAudioBytes) return unavailable('audio_unavailable_or_limit');
  if (signal?.aborted) return unavailable('aborted');
  const release = tryAcquireLocalAudioAnalysis();
  if (!release) return unavailable('busy');
  const deadline = budget.deadline;
  const files = [];
  const initialBytes = budget.decodedBytes;
  const initialWindows = budget.windows;
  try {
    const wave = parseNativeWave(buffer);
    let inputPath;
    let probe;
    if (!wave) {
      // A malformed/unsupported WAV cannot become evidence through repair.
      if (buffer.toString('ascii', 0, 4) === 'RIFF' || !/\.mp3$/iu.test(String(originalname ?? ''))) return unavailable('unsupported_audio');
      inputPath = join(tmpdir(), `local-caption-${randomUUID()}.mp3`);
      files.push(inputPath);
      await writeFile(inputPath, buffer);
      const response = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_fmt,sample_rate,channels:format=duration', '-of', 'json', inputPath],
      { timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1024 * 1024, signal, windowsHide: true });
      const data = JSON.parse(response.stdout);
      const stream = data.streams?.[0];
      probe = { channels: Number(stream?.channels), sampleRate: Number(stream?.sample_rate), duration: Number(data.format?.duration) };
      if (stream?.codec_name !== 'mp3' || !['fltp', 'flt', 'dblp', 'dbl'].includes(stream.sample_fmt)
        || !Number.isSafeInteger(probe.channels) || probe.channels < 1 || probe.channels > 64
        || !Number.isSafeInteger(probe.sampleRate) || probe.sampleRate < 1 || probe.sampleRate > 384_000
        || !finite(probe.duration) || probe.duration <= 0) return unavailable('unsupported_decode_format');
    }
    const measurements = [];
    for (const range of ranges) {
      const result = { ...range, status: 'unavailable' };
      if (!validRange(range) || range.end - range.start > LOCAL_TRANSCRIPT_LIMITS.maxWindowSeconds
        || budget.windows >= LOCAL_TRANSCRIPT_LIMITS.maxWindows
        || budget.totalSeconds + range.end - range.start > LOCAL_TRANSCRIPT_LIMITS.maxTotalWindowSeconds
        || signal?.aborted || Date.now() >= deadline) {
        measurements.push({ ...result, reason: 'range_or_budget_limit' });
        continue;
      }
      budget.windows += 1;
      budget.totalSeconds += range.end - range.start;
      if (wave) {
        const last = range.end === wave.frames / wave.sampleRate ? wave.frames : Math.ceil(range.end * wave.sampleRate);
        const byteCount = (last - Math.floor(range.start * wave.sampleRate)) * wave.blockAlign;
        if (range.end > wave.frames / wave.sampleRate || budget.decodedBytes + byteCount > LOCAL_TRANSCRIPT_LIMITS.maxDecodedBytes) {
          measurements.push({ ...result, reason: 'range_or_byte_limit' });
          continue;
        }
        budget.decodedBytes += byteCount;
        measurements.push({ ...result, status: measureSamples(buffer, wave, range.start, range.end) });
        continue;
      }
      if (range.end > probe.duration) {
        measurements.push({ ...result, reason: 'range_outside_audio' });
        continue;
      }
      const first = Math.floor(range.start * probe.sampleRate);
      const last = Math.ceil(range.end * probe.sampleRate);
      const expectedFrames = last - first;
      const expectedBytes = expectedFrames * probe.channels * 8;
      if (budget.decodedBytes + expectedBytes + 4096 > LOCAL_TRANSCRIPT_LIMITS.maxDecodedBytes) {
        measurements.push({ ...result, reason: 'decoded_byte_limit' });
        continue;
      }
      // Reserve failed/partial output too when sharing the request budget.
      budget.decodedBytes += expectedBytes + 4096;
      const outputPath = join(tmpdir(), `local-caption-${randomUUID()}.wav`);
      files.push(outputPath);
      try {
        await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-c:a', 'mp3float',
          '-i', inputPath, '-ss', (first / probe.sampleRate).toFixed(9), '-t', (expectedFrames / probe.sampleRate).toFixed(9),
          '-map', '0:a:0', '-vn', '-c:a', 'pcm_f64le', '-threads', '1', '-fs', String(expectedBytes + 4096), '-y', outputPath],
        { timeout: Math.max(1, deadline - Date.now()), maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true });
        const size = (await stat(outputPath)).size;
        if (size > expectedBytes + 4096) throw new Error('decoded size limit');
        const decoded = await readFile(outputPath);
        const decodedWave = parseNativeWave(decoded);
        if (!decodedWave || decodedWave.encoding !== 3 || decodedWave.bits !== 64 || decodedWave.channels !== probe.channels
          || decodedWave.sampleRate !== probe.sampleRate || decodedWave.frames !== expectedFrames) throw new Error('decoded range incomplete');
        measurements.push({ ...result, status: measureFrames(decoded, decodedWave, 0, expectedFrames) });
      } catch {
        measurements.push({ ...result, reason: 'decode_failed' });
      } finally {
        // Failed decodes may leave partial files; their reserved budget remains.
        // Release each window immediately; the outer cleanup remains a fallback.
        try { await unlink(outputPath); } catch {}
      }
    }
    return { measurements, decodedBytes: budget.decodedBytes - initialBytes, windows: budget.windows - initialWindows };
  } catch {
    return unavailable('analysis_failed');
  } finally {
    await Promise.all(files.map(async file => { try { await unlink(file); } catch {} }));
    release();
  }
}

function repetitionGroups(segments) {
  const values = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!validRange(segment) || !/[가-힣]/u.test(String(segment.text ?? ''))) continue;
    const key = repeatedKey(segment.text);
    if (Array.from(speech(key)).length < LOCAL_TRANSCRIPT_THRESHOLDS.minRepeatCharacters) continue;
    const group = values.get(key) ?? [];
    group.push(index);
    values.set(key, group);
  }
  const byIndex = new Map();
  for (const [key, indices] of values) {
    const starts = indices.map(index => segments[index].start);
    const ends = indices.map(index => segments[index].end);
    if (indices.length < LOCAL_TRANSCRIPT_THRESHOLDS.minRepeatCount
      || Math.max(...ends) - Math.min(...starts) < LOCAL_TRANSCRIPT_THRESHOLDS.minRepeatSpanSeconds) continue;
    const group = { groupId: groupId(key), occurrences: indices.length };
    for (const index of indices) byIndex.set(index, group);
  }
  return byIndex;
}

function sourceMatches(segments, sourceSegments) {
  const lookup = new Map();
  const append = (cue, index) => {
    const key = sourceKey(cue);
    const indices = lookup.get(key) ?? new Set();
    indices.add(index);
    lookup.set(key, indices);
  };
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const source = sourceSegments[index];
    if (!validRange(source) || typeof source.text !== 'string' || hasSpeaker(source)) continue;
    append(source, index);
    if (Array.isArray(source.sourceWords) && source.sourceWords.length > 0 && source.sourceWords.length <= 2_000) {
      const aligned = alignKoreanSegmentWithWordTimings(source);
      if (aligned.aligned) for (const cue of aligned.segments) append(cue, index);
    }
  }
  return segments.map(segment => {
    const matches = lookup.get(sourceKey(segment));
    return matches?.size === 1 ? [...matches][0] : undefined;
  });
}

/** Runs strictly AFTER the existing AI pipeline; it never requests AI work. */
export async function annotateLocalTranscriptReview(segments, {
  sourceSegments = [], buffer, originalname, language, signal, analyzeAudio = analyzeExactSilenceRanges, analysisBudget,
} = {}) {
  const empty = { automaticExcluded: 0, reviewCandidates: 0, groups: 0, analyzedWindows: 0, unavailableWindows: 0 };
  if (!Array.isArray(segments) || normalizeLanguage(language) !== 'ko' || segments.some(hasSpeaker)
    || segments.length > LOCAL_TRANSCRIPT_LIMITS.maxSegments) return { segments, summary: empty };
  const sources = Array.isArray(sourceSegments) && sourceSegments.length <= LOCAL_TRANSCRIPT_LIMITS.maxSegments ? sourceSegments : [];
  const groups = repetitionGroups(segments);
  const sourceGroups = repetitionGroups(sources);
  const matches = sourceMatches(segments, sources);
  const owners = new Map();
  const baseline = buildSubtitleCues(segments, { holdShortGaps: false, ignoreLocalExclusions: true, includeSourceIndices: true });
  for (const cue of baseline) {
    const indices = cue[SUBTITLE_SOURCE_INDICES] ?? [];
    for (const index of indices) owners.set(index, [...(owners.get(index) ?? []), indices]);
  }
  const candidates = [];
  const ranges = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!validRange(segment) || typeof segment.text !== 'string' || !segment.text.trim()
      || segment.subtitleReview?.localExclusion) continue; // Never undo a user's restore or rebind a stale decision.
    const sourceIndex = matches[index];
    const source = sources[sourceIndex];
    const group = groups.get(index) ?? sourceGroups.get(sourceIndex);
    const lowConfidence = finite(source?.avg_logprob) && source.avg_logprob <= LOCAL_TRANSCRIPT_THRESHOLDS.maxAverageLogProbability;
    const noSpeech = finite(source?.no_speech_prob) && source.no_speech_prob >= LOCAL_TRANSCRIPT_THRESHOLDS.minNoSpeechProbability && source.no_speech_prob <= 1;
    const compressed = source && source.end - source.start < LOCAL_TRANSCRIPT_THRESHOLDS.maxCompressedSeconds
      && Array.from(speech(source.text)).length >= LOCAL_TRANSCRIPT_THRESHOLDS.minCompressedCharacters;
    const providerRisk = lowConfidence && (noSpeech || sourceGroups.has(sourceIndex) || compressed);
    if (!group && !providerRisk) continue;
    const sourceCues = owners.get(index);
    const uniqueOwner = sourceCues?.length > 0 && sourceCues.every(indices => indices.length === 1 && indices[0] === index);
    const range = source && { start: source.start - LOCAL_TRANSCRIPT_LIMITS.paddingSeconds,
      end: source.end + LOCAL_TRANSCRIPT_LIMITS.paddingSeconds };
    const rangeKey = range && validRange(range) && range.end - range.start <= LOCAL_TRANSCRIPT_LIMITS.maxWindowSeconds
      ? `${range.start}:${range.end}` : undefined;
    if (rangeKey && !ranges.has(rangeKey)) ranges.set(rangeKey, range);
    candidates.push({ index, group, providerRisk, uniqueOwner, rangeKey });
  }
  if (!candidates.length) return { segments, summary: empty };
  let measurements = [];
  try {
    const analyzed = await analyzeAudio(buffer, { originalname, ranges: [...ranges.values()], signal, ...(analysisBudget ? { budget: analysisBudget } : {}) });
    measurements = Array.isArray(analyzed?.measurements) ? analyzed.measurements : [];
  } catch { /* Local analysis is best-effort: preserve dialogue on failure. */ }
  const measured = new Map(measurements.filter(validRange).map(item => [`${item.start}:${item.end}`, item.status]));
  const result = segments.slice();
  let automaticExcluded = 0;
  const seenGroups = new Set();
  for (const candidate of candidates) {
    const segment = segments[candidate.index];
    const measuredStatus = measured.get(candidate.rangeKey);
    const audioStatus = ['exact_zero', 'signal_present'].includes(measuredStatus) ? measuredStatus : 'unavailable';
    const automatic = audioStatus === 'exact_zero' && candidate.providerRisk && candidate.uniqueOwner;
    const status = automatic ? 'automatic' : 'review';
    if (automatic) automaticExcluded += 1;
    if (candidate.group) seenGroups.add(candidate.group.groupId);
    const localExclusion = { version: 1, status,
      reason: automatic ? 'exact_zero_with_provider_risk' : candidate.group ? 'distributed_repetition' : 'suspicious_silence',
      binding: { text: segment.text, start: segment.start, end: segment.end }, audioStatus,
      ...(candidate.group ?? {}) };
    const subtitleReview = mergeSubtitleReviews(segment.subtitleReview, { version: 1,
      issues: [{ code: automatic ? 'local_exact_silence_excluded' : candidate.group ? 'local_repetition_review' : 'local_silence_review' }],
      originalText: segment.subtitleReview?.originalText ?? segment.text,
      originalTiming: segment.subtitleReview?.originalTiming ?? { start: segment.start, end: segment.end },
      localExclusion });
    result[candidate.index] = { ...segment, subtitleReview };
  }
  const analyzedWindows = [...ranges.keys()].filter(key => ['exact_zero', 'signal_present'].includes(measured.get(key))).length;
  return { segments: result, summary: { automaticExcluded, reviewCandidates: candidates.length - automaticExcluded,
    groups: seenGroups.size, analyzedWindows, unavailableWindows: ranges.size - analyzedWindows } };
}
