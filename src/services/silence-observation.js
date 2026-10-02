import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

const execFileAsync = promisify(execFile);

export const SILENCE_OBSERVATION_MODE = process.env.SILENCE_OBSERVATION_MODE === 'shadow'
  ? 'shadow'
  : 'off';
export const SILENCE_OBSERVATION_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxBufferBytes: 4 * 1024 * 1024,
  maxThreads: 1,
  maxAudioBytes: 32 * 1024 * 1024,
  maxSegments: 20_000,
  maxSilenceIntervals: 20_000,
});

// Experimental observation thresholds only. They must not be used to delete or
// alter transcript segments.
export const SILENCE_CANDIDATE_THRESHOLDS = Object.freeze({
  noiseDb: -50,
  minSilenceSeconds: 0.5,
  segmentPaddingSeconds: 0.25,
  minNoSpeechProbability: 0.8,
  maxAverageLogProbability: -0.5,
});

function extensionFor(filename) {
  const suffix = typeof filename === 'string' ? filename.match(/\.[a-z0-9]{1,8}$/i)?.[0] : null;
  return suffix ?? '.audio';
}

function makeTempPath(filename) {
  return join(tmpdir(), `silence-observe-${randomUUID()}${extensionFor(filename)}`);
}

function parseSilenceIntervals(stderr) {
  if (typeof stderr !== 'string') return [];
  const intervals = [];
  const pendingStarts = [];
  const eventPattern = /(?<![\w.+-])silence_(start|end):\s*((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(?=$|[\s|])/g;
  for (const match of stderr.matchAll(eventPattern)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (match[1] === 'start') {
      pendingStarts.push(value);
      continue;
    }
    const start = pendingStarts.shift();
    if (Number.isFinite(start) && value > start) {
      intervals.push({ start, end: value });
      if (intervals.length > SILENCE_OBSERVATION_LIMITS.maxSilenceIntervals) {
        const error = new Error('observation interval limit');
        error.code = 'ERR_OBSERVATION_LIMIT';
        throw error;
      }
    }
  }
  return intervals;
}

function hasSpeakerMetadata(segment) {
  return Object.prototype.hasOwnProperty.call(segment, 'speaker');
}

export function findSilenceCandidates(
  segments,
  silenceIntervals,
  thresholds = SILENCE_CANDIDATE_THRESHOLDS,
) {
  if (!Array.isArray(segments) || !Array.isArray(silenceIntervals)) return [];
  const pad = thresholds.segmentPaddingSeconds;
  const sortedIntervals = silenceIntervals.filter((interval) => (
    interval && typeof interval.start === 'number' && Number.isFinite(interval.start)
    && typeof interval.end === 'number' && Number.isFinite(interval.end) && interval.end > interval.start
  )).sort((left, right) => left.start - right.start);
  const validIntervals = [];
  for (const interval of sortedIntervals) {
    const last = validIntervals.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else validIntervals.push({ start: interval.start, end: interval.end });
  }

  return segments.flatMap((segment, index) => {
    if (!isEligibleSegment(segment, thresholds)) return [];
    const { start, end } = segment;

    const paddedStart = start - pad;
    const paddedEnd = end + pad;
    let low = 0;
    let high = validIntervals.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (validIntervals[middle].end < paddedStart) low = middle + 1;
      else high = middle;
    }
    const interval = validIntervals[low];
    const fullyContained = interval !== undefined
      && paddedStart >= interval.start
      && paddedEnd <= interval.end;
    return fullyContained ? [{ segmentIndex: index }] : [];
  });
}

function hasValidConfidenceMetadata(segment) {
  if (!segment || typeof segment !== 'object' || hasSpeakerMetadata(segment)) return false;
  const { start, end, no_speech_prob: noSpeech, avg_logprob: averageLogProbability } = segment;
  return typeof start === 'number' && typeof end === 'number'
    && typeof noSpeech === 'number' && typeof averageLogProbability === 'number'
    && Number.isFinite(start) && Number.isFinite(end) && end > start
    && Number.isFinite(noSpeech) && noSpeech >= 0 && noSpeech <= 1
    && Number.isFinite(averageLogProbability) && averageLogProbability <= 0;
}

function isEligibleSegment(segment, thresholds) {
  if (!hasValidConfidenceMetadata(segment)) return false;
  const { no_speech_prob: noSpeech, avg_logprob: averageLogProbability } = segment;
  return noSpeech >= thresholds.minNoSpeechProbability
    && averageLogProbability <= thresholds.maxAverageLogProbability;
}

export async function detectQuietIntervals(
  buffer,
  originalname,
  { signal, runFfmpeg = execFileAsync } = {},
) {
  const inputPath = makeTempPath(originalname);
  try {
    await writeFile(inputPath, buffer, { signal });
    const { stderr } = await runFfmpeg('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-threads', String(SILENCE_OBSERVATION_LIMITS.maxThreads),
      '-filter_threads', String(SILENCE_OBSERVATION_LIMITS.maxThreads),
      '-i', inputPath,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-af', `asetpts=PTS-STARTPTS,silencedetect=noise=${SILENCE_CANDIDATE_THRESHOLDS.noiseDb}dB:d=${SILENCE_CANDIDATE_THRESHOLDS.minSilenceSeconds}`,
      '-f', 'null',
      '-',
    ], {
      timeout: SILENCE_OBSERVATION_LIMITS.timeoutMs,
      maxBuffer: SILENCE_OBSERVATION_LIMITS.maxBufferBytes,
      killSignal: 'SIGKILL',
      signal,
    });
    return parseSilenceIntervals(stderr);
  } finally {
    try { await unlink(inputPath); } catch {}
  }
}

function isAbort(error, signal) {
  return signal?.aborted
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR';
}

function outcomeFor(error, signal) {
  if (isAbort(error, signal)) return 'aborted';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
  if (error?.code === 'ERR_OBSERVATION_LIMIT') return 'analysis_limit';
  if (error?.code === 'ETIMEDOUT' || error?.killed) return 'timeout';
  return 'ffmpeg_error';
}

export async function observeSilentTranscript({
  buffer,
  originalname,
  segments,
  signal,
  detect = detectQuietIntervals,
} = {}) {
  const startedAt = performance.now();
  try {
    const silenceIntervals = await detect(buffer, originalname, { signal });
    const validConfidenceMetadataCount = Array.isArray(segments)
      ? segments.filter(hasValidConfidenceMetadata).length
      : 0;
    return {
      outcome: 'ok',
      silenceIntervalCount: silenceIntervals.length,
      validConfidenceMetadataCount,
      candidateCount: findSilenceCandidates(segments, silenceIntervals).length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    if (isAbort(error, signal)) {
      const abortError = new Error('전사 요청이 중단되었습니다.', {
        cause: signal?.reason instanceof Error ? signal.reason : undefined,
      });
      abortError.code = 'ABORTED';
      throw abortError;
    }
    return {
      outcome: outcomeFor(error, signal),
      silenceIntervalCount: 0,
      validConfidenceMetadataCount: 0,
      candidateCount: 0,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}

function snapshotSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.slice(0, SILENCE_OBSERVATION_LIMITS.maxSegments).map((segment) => {
    if (!segment || typeof segment !== 'object') return null;
    const snapshot = {
      start: segment.start,
      end: segment.end,
      no_speech_prob: segment.no_speech_prob,
      avg_logprob: segment.avg_logprob,
    };
    if (Object.prototype.hasOwnProperty.call(segment, 'speaker')) snapshot.speaker = true;
    return snapshot;
  });
}

export function createSilenceObservationScheduler({
  mode = SILENCE_OBSERVATION_MODE,
  observe = observeSilentTranscript,
  logger = (summary) => console.info('[transcription.silence_observation]', JSON.stringify(summary)),
  timeoutMs = SILENCE_OBSERVATION_LIMITS.timeoutMs,
  maxAudioBytes = SILENCE_OBSERVATION_LIMITS.maxAudioBytes,
} = {}) {
  let activeObservation = null;
  let shuttingDown = false;
  const activeTasks = new Set();
  const report = (summary) => {
    try { logger({ mode: 'shadow', ...summary }); } catch {}
  };

  function schedule({ buffer, originalname, segments, signal, clientRequestIds = [] } = {}) {
    if (mode !== 'shadow') return;
    if (shuttingDown) {
      report({ outcome: 'skipped', reason: 'shutdown', clientRequestIds });
      return;
    }
    if (!Buffer.isBuffer(buffer) || buffer.length > maxAudioBytes) {
      report({ outcome: 'skipped', reason: 'audio_size', audioBytes: Buffer.isBuffer(buffer) ? buffer.length : 0, clientRequestIds });
      return;
    }
    if (Array.isArray(segments) && segments.length > SILENCE_OBSERVATION_LIMITS.maxSegments) {
      report({ outcome: 'skipped', reason: 'segment_limit', segmentCount: segments.length, clientRequestIds });
      return;
    }
    if (activeObservation) {
      report({ outcome: 'skipped', reason: 'busy', clientRequestIds });
      return;
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    const startedAt = performance.now();
    let deadlineReached = false;
    const timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(new Error('observation deadline'));
    }, timeoutMs);
    activeObservation = controller;

    const task = Promise.resolve().then(() => observe({
      buffer,
      originalname,
      segments: snapshotSegments(segments),
      signal: controller.signal,
    })).then((summary) => {
      report({ ...summary, clientRequestIds });
    }).catch(() => {
      report({
        outcome: deadlineReached ? 'deadline' : signal?.aborted ? 'aborted' : 'observer_error',
        silenceIntervalCount: 0,
        validConfidenceMetadataCount: 0,
        candidateCount: 0,
        durationMs: Math.round(performance.now() - startedAt),
        clientRequestIds,
      });
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
      if (activeObservation === controller) activeObservation = null;
      activeTasks.delete(task);
    });
    activeTasks.add(task);
    task.catch(() => {});
  }

  async function stop() {
    shuttingDown = true;
    activeObservation?.abort(new Error('server shutdown'));
    await Promise.allSettled([...activeTasks]);
  }

  return { schedule, stop };
}

const defaultScheduler = createSilenceObservationScheduler();
export const scheduleSilenceObservation = defaultScheduler.schedule;
export const stopSilenceObservation = defaultScheduler.stop;
