import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { normalizeLanguage } from './language.js';
import { buildSubtitleCues, SUBTITLE_SOURCE_INDICES } from './subtitle.js';
import { mergeSubtitleReviews } from './subtitle-review.js';
import { normalizeLocalStartEvidence } from './local-start-evidence.js';
import { validateSubtitleSegments } from './subtitle-payload.js';
import { LOCAL_TRANSCRIPT_LIMITS as LIMITS, createLocalAudioAnalysisBudget,
  parseNativeWave, tryAcquireLocalAudioAnalysis } from './local-transcript-review.js';

const execFileAsync = promisify(execFile);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validRange = value => value && finite(value.start) && finite(value.end) && value.start >= 0 && value.end > value.start;
const hasSpeaker = value => value?.speaker !== undefined && value.speaker !== null && value.speaker !== '';
const binding = value => ({ text: value.text, start: value.start, end: value.end });
const key = value => `${value.start}:${value.end}`;
export const LOCAL_START_METADATA_LIMITS = Object.freeze({ maxJsonBytes: 49 * 1024 * 1024, maxAddedJsonBytes: 4 * 1024 * 1024 });

function sample(buffer, wave, frame, channel) {
  const offset = wave.start + frame * wave.blockAlign + channel * wave.bytes;
  return wave.encoding === 3
    ? (wave.bytes === 4 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset))
    : (wave.bytes === 1 ? buffer[offset] - 128 : buffer.readIntLE(offset, wave.bytes));
}

function zeroFrame(buffer, wave, frame) {
  let zero = true;
  for (let channel = 0; channel < wave.channels; channel += 1) {
    const value = sample(buffer, wave, frame, channel);
    if (!Number.isFinite(value)) return null;
    if (value !== 0) zero = false;
  }
  return zero;
}

function firstSignal(buffer, wave, first, last, { signal, deadline }) {
  for (let frame = first; frame < last; frame += 1) {
    if ((frame - first) % 4096 === 0 && (signal?.aborted || Date.now() >= deadline)) return { reason: signal?.aborted ? 'aborted' : 'analysis_limit' };
    const zero = zeroFrame(buffer, wave, frame);
    if (zero === null) return { reason: 'invalid_samples' };
    if (!zero) return { frame };
  }
  return {};
}

// A quiet interval is only a window-selection hint. Its threshold never proves
// silence and never supplies a start timestamp.
function quietHints(stderr, channels, duration, { signal, deadline }) {
  if (typeof stderr !== 'string') return [];
  const starts = new Map();
  const perChannel = Array.from({ length: channels }, () => []);
  const pattern = /channel:\s*(\d+)\s*\|\s*silence_(start|end):\s*((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/gu;
  let count = 0;
  for (const match of stderr.matchAll(pattern)) {
    if (++count > 40_000 || count % 128 === 0 && (signal?.aborted || Date.now() >= deadline)) return null;
    const channel = Number(match[1]), time = Number(match[3]);
    if (!Number.isSafeInteger(channel) || channel < 0 || channel >= channels || !finite(time) || time < 0 || time > duration) return null;
    if (match[2] === 'start') starts.set(channel, time);
    else if (starts.has(channel)) {
      const start = starts.get(channel);
      if (time > start) perChannel[channel].push({ start, end: time });
      starts.delete(channel);
    }
  }
  for (const [channel, start] of starts) if (start < duration) perChannel[channel].push({ start, end: duration });
  const intersect = (left, right) => {
    const result = [];
    for (let a = 0, b = 0; a < left.length && b < right.length;) {
      const start = Math.max(left[a].start, right[b].start), end = Math.min(left[a].end, right[b].end);
      if (end > start) result.push({ start, end });
      if (left[a].end < right[b].end) a += 1; else b += 1;
    }
    return result;
  };
  for (const intervals of perChannel) intervals.sort((a, b) => a.start - b.start);
  return perChannel.reduce(intersect);
}

/** Exact-zero prefix evidence in decoded-sample-zero time; no AI or time seek. */
export async function analyzeLocalStartRanges(buffer, {
  originalname, ranges = [], signal, runProcess = execFileAsync, budget = createLocalAudioAnalysisBudget(),
} = {}) {
  const unavailable = reason => ({ measurements: ranges.map(range => ({ ...range, status: 'unavailable', reason })), windowAudits: [] });
  if (!ranges.length) return { measurements: [], windowAudits: [] };
  if (!Buffer.isBuffer(buffer) || buffer.length > LIMITS.maxAudioBytes) return unavailable('audio_unavailable_or_limit');
  if (ranges.length > LIMITS.maxSegments) return unavailable('analysis_limit');
  if (signal?.aborted) return unavailable('aborted');
  if (Date.now() >= budget.deadline) return unavailable('analysis_limit');
  const release = tryAcquireLocalAudioAnalysis();
  if (!release) return unavailable('busy');
  const files = [];
  const windowAudits = [];
  const measurements = ranges.map(range => ({ ...range, status: 'unchanged' }));
  const options = () => ({ timeout: Math.max(1, budget.deadline - Date.now()), maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true });
  const withinBudget = (seconds, bytes) => budget.windows < LIMITS.maxWindows && seconds <= LIMITS.maxWindowSeconds
    && budget.totalSeconds + seconds <= LIMITS.maxTotalWindowSeconds && budget.decodedBytes + bytes <= LIMITS.maxDecodedBytes
    && !signal?.aborted && Date.now() < budget.deadline;
  try {
    const wave = parseNativeWave(buffer);
    if (wave) {
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        const first = Math.floor(range.start * wave.sampleRate);
        const last = Math.min(wave.frames, Math.ceil(range.end * wave.sampleRate), first + Math.floor(LIMITS.maxWindowSeconds * wave.sampleRate));
        if (!validRange(range) || range.end > wave.frames / wave.sampleRate || last <= first) {
          measurements[index] = { ...range, status: 'unavailable', reason: 'range_outside_audio' }; continue;
        }
        // Preserve a signal at the very first native frame, however small it is.
        const initial = zeroFrame(buffer, wave, first);
        if (initial === null) { measurements[index] = { ...range, status: 'unavailable', candidate: true, reason: 'invalid_samples' }; continue; }
        if (!initial) continue;
        const seconds = (last - first) / wave.sampleRate, bytes = (last - first) * wave.blockAlign;
        if (!withinBudget(seconds, bytes)) { measurements[index] = { ...range, status: 'unavailable', candidate: true, reason: 'range_or_budget_limit' }; continue; }
        budget.windows += 1; budget.totalSeconds += seconds; budget.decodedBytes += bytes;
        const found = firstSignal(buffer, wave, first, last, { signal, deadline: budget.deadline });
        const minimumStart = found.frame / wave.sampleRate;
        const audit = { method: 'native_wav', firstFrame: first, lastFrame: last, expectedFrames: last - first,
          decodedFrames: last - first, origin: 'decoded_sample_zero', sampleRate: wave.sampleRate, channels: wave.channels };
        windowAudits.push(audit);
        if (found.reason) measurements[index] = { ...range, status: 'unavailable', candidate: true, reason: found.reason };
        else if (minimumStart > range.start && minimumStart < range.end) measurements[index] = { ...range, status: 'verified', minimumStart,
          method: 'native_wav', sampleRate: wave.sampleRate, channels: wave.channels };
      }
      return { measurements, windowAudits };
    }
    // Unsupported or malformed native files may not gain evidence by repair.
    if (buffer.toString('ascii', 0, 4) === 'RIFF' || !/\.mp3$/iu.test(String(originalname ?? ''))) return unavailable('unsupported_audio');
    const input = join(tmpdir(), `local-start-${randomUUID()}.mp3`);
    files.push(input);
    await writeFile(input, buffer, { signal });
    const response = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
      'stream=codec_name,sample_fmt,sample_rate,channels,start_time:format=duration', '-of', 'json', input], options());
    const probe = JSON.parse(response.stdout), stream = probe.streams?.[0];
    const rate = Number(stream?.sample_rate), channels = Number(stream?.channels), duration = Number(probe.format?.duration);
    if (stream?.codec_name !== 'mp3' || !['fltp', 'flt', 'dblp', 'dbl'].includes(stream.sample_fmt)
      || !Number.isSafeInteger(rate) || rate < 1 || rate > 384_000 || !Number.isSafeInteger(channels) || channels < 1 || channels > 64
      || !finite(duration) || duration <= 0) return unavailable('unsupported_decode_format');
    if (Date.now() >= budget.deadline || signal?.aborted) return unavailable(signal?.aborted ? 'aborted' : 'analysis_limit');
    const hints = await runProcess('ffmpeg', ['-nostdin', '-hide_banner', '-nostats', '-threads', '1', '-filter_threads', '1', '-c:a', 'mp3float', '-i', input,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'asetpts=PTS-STARTPTS,silencedetect=noise=-50dB:d=0.5:mono=1', '-f', 'null', '-'], options());
    const intervals = quietHints(hints.stderr, channels, duration, { signal, deadline: budget.deadline });
    if (!intervals) return unavailable(signal?.aborted ? 'aborted' : Date.now() >= budget.deadline ? 'analysis_limit' : 'candidate_analysis_unavailable');
    const ordered = ranges.flatMap((range, index) => validRange(range) && range.end <= duration ? [{ range, index }] : [])
      .sort((a, b) => a.range.start - b.range.start);
    let cursor = 0;
    for (const interval of intervals) {
      if (signal?.aborted || Date.now() >= budget.deadline) {
        for (; cursor < ordered.length; cursor += 1) measurements[ordered[cursor].index] = { ...ordered[cursor].range,
          status: 'unavailable', reason: signal?.aborted ? 'aborted' : 'analysis_limit' };
        break;
      }
      while (cursor < ordered.length && ordered[cursor].range.start < interval.start) cursor += 1;
      const candidates = [];
      while (cursor < ordered.length && ordered[cursor].range.start < interval.end) { candidates.push(ordered[cursor]); cursor += 1; }
      if (!candidates.length) continue;
      const first = Math.max(0, Math.floor((candidates[0].range.start - LIMITS.paddingSeconds) * rate));
      const last = Math.ceil(Math.min(duration, interval.end + LIMITS.paddingSeconds) * rate);
      const expectedFrames = last - first, bytes = expectedFrames * channels * 8, seconds = expectedFrames / rate;
      if (!withinBudget(seconds, bytes + 4096)) {
        for (const { range, index } of candidates) measurements[index] = { ...range, status: 'unavailable', candidate: true, reason: 'range_or_budget_limit' };
        continue;
      }
      budget.windows += 1; budget.totalSeconds += seconds;
      // Reserve before spawning: failed/partial windows still consume the budget.
      budget.decodedBytes += bytes + 4096;
      const output = join(tmpdir(), `local-start-${randomUUID()}.wav`);
      files.push(output);
      try {
        // Decode from the first audio sample and trim by integer frame indices.
        // In particular, do not use input/output -ss or subtract MP3 start_time.
        await runProcess('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-c:a', 'mp3float', '-i', input,
          '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', `atrim=start_sample=${first}:end_sample=${last},asetpts=PTS-STARTPTS`,
          '-c:a', 'pcm_f64le', '-threads', '1', '-fs', String(bytes + 4096), '-y', output], options());
        if ((await stat(output)).size > bytes + 4096) throw new Error('decode size');
        const decoded = await readFile(output), decodedWave = parseNativeWave(decoded);
        if (!decodedWave || decodedWave.encoding !== 3 || decodedWave.bits !== 64 || decodedWave.channels !== channels
          || decodedWave.sampleRate !== rate || decodedWave.frames !== expectedFrames) throw new Error('decode frames');
        const audit = { method: 'mp3_f64', firstFrame: first, lastFrame: last, expectedFrames, decodedFrames: decodedWave.frames,
          origin: 'decoded_sample_zero', rangeMethod: 'atrim_sample_indices', sampleRate: rate, channels };
        windowAudits.push(audit);
        for (const { range, index } of candidates) {
          const cueFirst = Math.floor(range.start * rate) - first;
          if (cueFirst < 0 || cueFirst >= expectedFrames) throw new Error('cue outside decode');
          const found = firstSignal(decoded, decodedWave, cueFirst, expectedFrames, { signal, deadline: budget.deadline });
          const minimumStart = (first + found.frame) / rate;
          if (found.reason) measurements[index] = { ...range, status: 'unavailable', candidate: true, reason: found.reason };
          else if (minimumStart > range.start && minimumStart < range.end) measurements[index] = { ...range, status: 'verified', minimumStart,
            method: 'mp3_f64', sampleRate: rate, channels };
        }
      } catch {
        for (const { range, index } of candidates) measurements[index] = { ...range, status: 'unavailable', candidate: true, reason: signal?.aborted ? 'aborted' : 'decode_failed' };
      } finally { try { await unlink(output); } catch {} }
    }
    return { measurements, windowAudits };
  } catch {
    return unavailable(signal?.aborted ? 'aborted' : Date.now() >= budget.deadline ? 'analysis_limit' : 'analysis_failed');
  } finally {
    await Promise.all(files.map(async file => { try { await unlink(file); } catch {} }));
    release();
  }
}

/** Runs after all existing AI work. Row, word and fixed-plan times stay intact. */
export async function annotateLocalStartEvidence(segments, {
  buffer, originalname, language, signal, analyzeAudio = analyzeLocalStartRanges, analysisBudget, limits,
} = {}) {
  const empty = { automaticCues: 0, automaticRows: 0, unavailableRows: 0, analyzedWindows: 0 };
  if (!Array.isArray(segments) || normalizeLanguage(language) !== 'ko' || segments.some(hasSpeaker)
    || segments.length > LIMITS.maxSegments || !Buffer.isBuffer(buffer)) return { segments, summary: empty };
  const cues = buildSubtitleCues(segments, { holdShortGaps: false, ignoreLocalExclusions: true,
    ignoreLocalStartEvidence: true, includeSourceIndices: true });
  const seenStarts = new Set(), competingStarts = new Set();
  for (const cue of cues) {
    if (seenStarts.has(cue.start)) competingStarts.add(cue.start);
    seenStarts.add(cue.start);
  }
  const candidates = cues.flatMap(cue => {
    const owners = cue[SUBTITLE_SOURCE_INDICES] ?? [];
    const index = owners.length === 1 ? owners[0] : undefined;
    return index !== undefined && !competingStarts.has(cue.start) && segments[index].timingSource !== 'manual'
      && !segments[index].subtitleReview?.localStart && /[가-힣]/u.test(cue.text)
      ? [{ cue, index }] : [];
  });
  if (!candidates.length) return { segments, summary: empty };
  const ranges = [...new Map(candidates.map(({ cue }) => [key(cue), { start: cue.start, end: cue.end }])).values()];
  let analyzed;
  try { analyzed = await analyzeAudio(buffer, { originalname, ranges, signal, ...(analysisBudget ? { budget: analysisBudget } : {}) }); }
  catch { analyzed = { measurements: ranges.map(range => ({ ...range, status: 'unavailable', reason: 'analysis_failed' })) }; }
  const measured = new Map((analyzed?.measurements ?? []).filter(validRange).map(item => [key(item), item]));
  const byRow = new Map();
  for (const { cue, index } of candidates) {
    const value = measured.get(key(cue));
    if (value?.status === 'unchanged') continue;
    const values = byRow.get(index) ?? [];
    values.push({ cue, value: value ?? { status: 'unavailable', reason: 'missing_measurement' } }); byRow.set(index, values);
  }
  const result = segments.slice();
  let automaticCues = 0, automaticRows = 0, unavailableRows = 0;
  for (const [index, values] of byRow) {
    const verified = values.filter(({ value }) => value.status === 'verified');
    const failed = values.filter(({ value }) => value.status !== 'verified');
    const first = verified[0]?.value;
    const consistent = first && verified.every(({ value }) => value.method === first.method && value.sampleRate === first.sampleRate && value.channels === first.channels);
    let localStart = !failed.length && consistent ? normalizeLocalStartEvidence({ version: 1, status: 'automatic', binding: binding(segments[index]),
      cues: verified.map(({ cue, value }) => [cue.start, cue.end, cue.text, value.minimumStart]),
      sampleRate: first.sampleRate, channels: first.channels, method: first.method }) : undefined;
    // A partially verified compact row stays unverified as a whole. Do not let
    // a successful child make its unchecked sibling look automatically safe.
    if (!localStart) localStart = normalizeLocalStartEvidence({ version: 1, status: 'unavailable', binding: binding(segments[index]), cues: [],
      reason: verified.length && failed.length ? 'partial_verification_unavailable' : failed[0]?.value.reason ?? 'invalid_evidence' });
    if (!localStart) continue;
    result[index] = { ...segments[index], subtitleReview: mergeSubtitleReviews(segments[index].subtitleReview,
      { version: 1, issues: [], localStart }) };
    if (localStart.status === 'automatic') { automaticCues += localStart.cues.length; automaticRows += 1; }
    else unavailableRows += 1;
  }
  const summary = { automaticCues, automaticRows, unavailableRows,
    unavailableRanges: [...measured.values()].filter(item => item.status === 'unavailable').length,
    analyzedWindows: analyzed?.windowAudits?.length ?? 0, limited: false };
  const cap = name => finite(limits?.[name]) && limits[name] >= 0 ? Math.min(limits[name], LOCAL_START_METADATA_LIMITS[name]) : LOCAL_START_METADATA_LIMITS[name];
  try {
    const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const addedBytes = resultBytes - Buffer.byteLength(JSON.stringify(segments), 'utf8');
    if (validateSubtitleSegments(result) || resultBytes > cap('maxJsonBytes') || addedBytes > cap('maxAddedJsonBytes')) {
      return { segments, summary: { ...summary, automaticCues: 0, automaticRows: 0, unavailableRows: 0, limited: true, reason: 'metadata_limit' } };
    }
  } catch { return { segments, summary: { ...summary, automaticCues: 0, automaticRows: 0, unavailableRows: 0, limited: true, reason: 'metadata_limit' } }; }
  return { segments: result, summary };
}
