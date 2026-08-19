import OpenAI from 'openai';
import { toFile } from 'openai';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { buildAudioChunkPlan, mapWithConcurrency, mergeChunkSegments } from './audio-chunks.js';
import { normalizeProviderSpeakerLabels } from './speakers.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 4 });
const execFileAsync = promisify(execFile);

const WHISPER_LIMIT = 25 * 1024 * 1024; // 25MB
// The production job bucket accepts files up to 50MB. Leave headroom so a
// large video never fails after the user has already uploaded it to Railway.
const DIARIZATION_STORAGE_SAFE_LIMIT = 45 * 1024 * 1024;
const OPENAI_SUPPORTED_EXTENSIONS = new Set(['.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.oga', '.ogg', '.wav', '.webm']);
const PARALLEL_TRANSCRIBE_MIN_SECONDS = 6 * 60;
const PARALLEL_TRANSCRIBE_CHUNK_SECONDS = 3 * 60;
const PARALLEL_TRANSCRIBE_CONCURRENCY = 2;
const PARALLEL_TRANSCRIBE_ENABLED = process.env.PARALLEL_TRANSCRIBE_ENABLED !== 'false';

// The production API rejects diarized audio longer than 1,400 seconds. Keep the
// product limit at the previously proven 20 minutes, leaving enough operational
// headroom for ffprobe/model duration drift before credits are reserved.
export const DIARIZATION_PROVIDER_MAX_AUDIO_SECONDS = 1_400;
const DIARIZATION_OPERATIONAL_HEADROOM_SECONDS = 200;
export const DIARIZATION_MAX_AUDIO_SECONDS =
  DIARIZATION_PROVIDER_MAX_AUDIO_SECONDS - DIARIZATION_OPERATIONAL_HEADROOM_SECONDS;
const DIARIZATION_BACKSTOP_SECONDS = DIARIZATION_PROVIDER_MAX_AUDIO_SECONDS;
export const DIARIZATION_DURATION_LIMIT_CODE = 'DIARIZATION_DURATION_LIMIT';

export function diarizationDurationLimitMessage() {
  const minutes = Math.floor(DIARIZATION_MAX_AUDIO_SECONDS / 60);
  return `다화자 분리 모드는 최대 ${minutes}분 음성만 지원합니다. 파일을 분할 후 다시 시도해주세요.`;
}

export function createDiarizationDurationLimitError() {
  const error = new Error(diarizationDurationLimitMessage());
  error.code = DIARIZATION_DURATION_LIMIT_CODE;
  return error;
}

export function isDiarizationProviderDurationLimitError(error) {
  return error?.status === 400
    && /audio duration .* seconds is longer than .* seconds which is the maximum for this model/i
      .test(error?.message || '');
}

// The diarization model runs as a single un-chunked request, so its duration
// scales with the audio. The SDK default is a flat 10 minutes, which a 20-minute
// file already reaches 89% of, so the budget is derived from the audio length.
//
// Sizing it at 60s per audio minute — about twice the median — was not enough.
// A production job timed out here after the same account's near-identical file
// had finished at 28.6s per audio minute fifteen minutes earlier: provider
// latency more than doubled inside that window, past 60s per audio minute. The
// user saw a failure, retried, and gave up on diarization.
//
// This budget exists to cut a connection that is never going to answer, not to
// hold the model to a latency target. A request that is still streaming is worth
// waiting for, because the alternative is a refund and a lost result. So it is
// sized off the observed tail rather than the median, with a ceiling so a truly
// hung request cannot occupy the single worker indefinitely.
const DIARIZATION_TIMEOUT_MS_PER_AUDIO_SECOND = 3_000;
const DIARIZATION_MIN_TIMEOUT_MS = 10 * 60_000;
const DIARIZATION_MAX_TIMEOUT_MS = 45 * 60_000;
// Retrying a request this long doubles both the wait and the OpenAI spend, so
// the shared client's retry budget is narrowed for this call only.
const DIARIZATION_MAX_RETRIES = 1;

function getExtension(filename) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return '';
  return filename.slice(dotIndex).toLowerCase();
}

function getSafeAudioName(originalname, fallbackExt = '.mp3') {
  const ext = getExtension(originalname);
  const safeExt = OPENAI_SUPPORTED_EXTENSIONS.has(ext) ? ext : fallbackExt;
  return `audio-${Date.now()}${safeExt}`;
}

function isInvalidFileFormatError(err) {
  return err.status === 400 && /invalid file format/i.test(err.message || '');
}

function createTempPath(prefix, extension) {
  return join(tmpdir(), `${prefix}-${randomUUID()}${extension}`);
}

export async function probeAudioDuration(buffer, originalname) {
  const extension = getExtension(originalname) || '.audio';
  const inputPath = createTempPath('stt-probe', extension);

  try {
    await writeFile(inputPath, buffer);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { timeout: 30_000 });

    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('오디오 길이를 읽을 수 없습니다.');
    }
    return duration;
  } finally {
    try { await unlink(inputPath); } catch {}
  }
}

async function compressAudio(buffer, originalname) {
  const ext = getExtension(originalname) || '.audio';
  const inputPath = createTempPath('stt-input', ext);
  const outputPath = createTempPath('stt-output', '.mp3');

  try {
    await writeFile(inputPath, buffer);

    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '32k',
      '-y',
      outputPath,
    ], { timeout: 120_000 });

    const compressed = await readFile(outputPath);
    return compressed;
  } catch (err) {
    throw new Error(`FFmpeg 압축 오류: ${err.message}`);
  } finally {
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
  }
}

export function shouldCompressDiarizationAudioForStorage(byteLength) {
  return byteLength > DIARIZATION_STORAGE_SAFE_LIMIT;
}

function diarizationRequestTimeoutMs(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return DIARIZATION_MIN_TIMEOUT_MS;
  const budget = Math.round(seconds * DIARIZATION_TIMEOUT_MS_PER_AUDIO_SECOND);
  return Math.min(
    DIARIZATION_MAX_TIMEOUT_MS,
    Math.max(DIARIZATION_MIN_TIMEOUT_MS, budget),
  );
}

export function buildDiarizationRequestOptions({ durationSeconds, signal } = {}) {
  return {
    timeout: diarizationRequestTimeoutMs(durationSeconds),
    maxRetries: DIARIZATION_MAX_RETRIES,
    signal,
  };
}

export async function prepareDiarizationAudioForStorage({ buffer, originalname, contentType }) {
  if (!shouldCompressDiarizationAudioForStorage(buffer.length)) {
    return {
      buffer,
      filename: originalname,
      contentType,
      converted: false,
    };
  }

  console.log(`[diarization] 대기열 저장 전 오디오만 mp3로 변환합니다. original=${originalname}, inputBytes=${buffer.length}`);
  const compressed = await compressAudio(buffer, originalname);
  if (shouldCompressDiarizationAudioForStorage(compressed.length)) {
    const error = new Error(`다화자 변환용 오디오 파일이 저장 가능한 크기를 초과했습니다. ${Math.floor(DIARIZATION_MAX_AUDIO_SECONDS / 60)}분 이하 파일로 다시 시도해주세요.`);
    error.code = 'DIARIZATION_STORAGE_LIMIT';
    throw error;
  }

  return {
    buffer: compressed,
    filename: 'queued-audio.mp3',
    contentType: 'audio/mpeg',
    converted: true,
  };
}

function parseSilenceEnds(stderr) {
  return [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)]
    .map(match => Number.parseFloat(match[1]))
    .filter(Number.isFinite);
}

async function prepareParallelChunks(buffer, originalname, durationSeconds) {
  const extension = getExtension(originalname) || '.audio';
  const inputPath = createTempPath('stt-parallel-input', extension);
  const outputPaths = [];

  try {
    await writeFile(inputPath, buffer);
    const { stderr } = await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-i', inputPath,
      '-af', 'silencedetect=noise=-35dB:d=0.35',
      '-f', 'null',
      '-',
    ], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

    const chunkPlan = buildAudioChunkPlan({
      durationSeconds,
      silenceEnds: parseSilenceEnds(stderr),
      targetSeconds: PARALLEL_TRANSCRIBE_CHUNK_SECONDS,
    });
    const chunks = [];

    for (const chunk of chunkPlan) {
      const outputPath = createTempPath(`stt-parallel-${chunk.index}`, '.mp3');
      outputPaths.push(outputPath);
      await execFileAsync('ffmpeg', [
        '-ss', chunk.inputStart.toFixed(3),
        '-i', inputPath,
        '-t', (chunk.inputEnd - chunk.inputStart).toFixed(3),
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-b:a', '32k',
        '-y',
        outputPath,
      ], { timeout: 120_000 });

      const chunkBuffer = await readFile(outputPath);
      if (chunkBuffer.length === 0) throw new Error('분할된 오디오가 비어 있습니다.');
      chunks.push({ ...chunk, buffer: chunkBuffer });
    }

    return chunks;
  } finally {
    try { await unlink(inputPath); } catch {}
    await Promise.all(outputPaths.map(async (path) => {
      try { await unlink(path); } catch {}
    }));
  }
}

async function createTranscriptionWithFallback({
  buffer,
  originalname,
  params,
  logPrefix,
  requestOptions,
}) {
  let audioBuffer = buffer;
  let audioName = getSafeAudioName(originalname);
  const timings = { compressionMs: 0, openaiMs: 0, openaiAttempts: [], preconvertedM4a: false };

  async function compressWithTiming(sourceBuffer) {
    const startedAt = performance.now();
    try {
      return await compressAudio(sourceBuffer, originalname);
    } finally {
      timings.compressionMs += performance.now() - startedAt;
    }
  }

  async function requestTranscription(sourceBuffer, sourceName, phase) {
    const startedAt = performance.now();
    let outcome = 'success';
    try {
      const file = await toFile(sourceBuffer, sourceName);
      return await openai.audio.transcriptions.create({ ...params, file }, requestOptions);
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      const durationMs = performance.now() - startedAt;
      timings.openaiMs += durationMs;
      timings.openaiAttempts.push({ phase, outcome, durationMs });
    }
  }

  try {
    if (getExtension(originalname) === '.m4a') {
      console.log(`[${logPrefix}] 휴대폰 m4a 호환성을 위해 mp3로 선제 변환합니다. original=${originalname}`);
      audioBuffer = await compressWithTiming(buffer);
      audioName = 'converted.mp3';
      timings.preconvertedM4a = true;
    } else if (buffer.length >= WHISPER_LIMIT) {
      console.log(`[${logPrefix}] 압축 전: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
      audioBuffer = await compressWithTiming(buffer);
      audioName = 'compressed.mp3';
      console.log(`[${logPrefix}] 압축 후: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    }

    try {
      const response = await requestTranscription(audioBuffer, audioName, 'initial');
      return { response, timings };
    } catch (err) {
      if (!isInvalidFileFormatError(err) || audioName === 'compressed.mp3' || audioName === 'converted.mp3') {
        throw err;
      }

      console.warn(`[${logPrefix}] OpenAI 파일 형식 오류. 휴대폰 녹음 파일 호환성을 위해 mp3로 변환 후 재시도합니다. original=${originalname}, upload=${audioName}`);
      const converted = await compressWithTiming(buffer);
      const response = await requestTranscription(converted, 'converted.mp3', 'format_fallback');
      return { response, timings };
    }
  } catch (error) {
    // These timings only left this function on the success path, so a failed job
    // recorded no attempt count and no request duration — the two numbers that
    // separate a timeout from a transient blip. Carry them out on the error too.
    error.timings = timings;
    throw error;
  }
}

async function transcribeLongAudioInParallel({ buffer, originalname, params, durationSeconds }) {
  const splitStartedAt = performance.now();
  let chunks;
  try {
    chunks = await prepareParallelChunks(buffer, originalname, durationSeconds);
  } catch (err) {
    console.warn(`[whisper] 병렬 분할 준비 실패. 기존 단일 전사로 진행합니다: ${err.message}`);
    return null;
  }
  const splitMs = performance.now() - splitStartedAt;

  if (chunks.length < 2) return null;

  const openaiStartedAt = performance.now();
  const chunkResults = await mapWithConcurrency(
    chunks,
    PARALLEL_TRANSCRIBE_CONCURRENCY,
    async (chunk) => {
      const { response, timings } = await createTranscriptionWithFallback({
        buffer: chunk.buffer,
        originalname: `chunk-${chunk.index}.mp3`,
        params,
        logPrefix: `whisper chunk ${chunk.index + 1}/${chunks.length}`,
      });
      return { chunk, response, timings };
    }
  );
  const openaiMs = performance.now() - openaiStartedAt;
  const segments = mergeChunkSegments(chunkResults);

  return {
    text: segments.map(segment => segment.text).join(' '),
    segments,
    language: chunkResults.find(result => result.response.language)?.response.language ?? 'unknown',
    timings: {
      compressionMs: chunkResults.reduce((total, result) => total + result.timings.compressionMs, 0),
      splitMs,
      openaiMs,
      openaiAggregateMs: chunkResults.reduce((total, result) => total + result.timings.openaiMs, 0),
      chunkCount: chunks.length,
      chunkTimings: chunkResults.map(({ chunk, timings }) => ({
        index: chunk.index,
        ownedStartSeconds: chunk.ownedStart,
        ownedEndSeconds: chunk.ownedEnd,
        inputStartSeconds: chunk.inputStart,
        inputEndSeconds: chunk.inputEnd,
        compressionMs: timings.compressionMs,
        openaiMs: timings.openaiMs,
        openaiAttempts: timings.openaiAttempts,
      })),
    },
  };
}

export async function transcribeWithDiarization(
  buffer,
  originalname,
  language,
  { durationSeconds, signal } = {},
) {
  try {
    const params = {
      model: 'gpt-4o-transcribe-diarize',
      response_format: 'diarized_json',
      // The diarization API requires chunking for audio longer than 30 seconds.
      chunking_strategy: 'auto',
    };

    if (language) {
      params.language = language;
    }

    const { response, timings } = await createTranscriptionWithFallback({
      buffer,
      originalname,
      params,
      logPrefix: 'diarize',
      requestOptions: buildDiarizationRequestOptions({ durationSeconds, signal }),
    });

    const rawSegments = response.segments ?? [];

    // 길이 게이트를 통과했지만 실제 응답이 상한을 넘는 경우의 백스톱.
    const lastEnd = rawSegments.length > 0 ? rawSegments[rawSegments.length - 1].end : 0;
    if (lastEnd > DIARIZATION_BACKSTOP_SECONDS) {
      throw createDiarizationDurationLimitError();
    }

    // 공급자가 A/B 외의 라벨을 반환해도 음수 화자 ID가 생기지 않도록
    // 실제 등장 순서대로 안정적인 0..19 ID를 부여한다.
    const segments = normalizeProviderSpeakerLabels(rawSegments).map(s => ({
      start: s.start,
      end: s.end,
      text: s.text,
      speaker: s.speaker,
    }));

    return {
      text: response.text,
      segments,
      language: response.language ?? language ?? 'unknown',
      timings,
    };
  } catch (err) {
    if (err.code === DIARIZATION_DURATION_LIMIT_CODE) throw err;
    if (isDiarizationProviderDurationLimitError(err)) {
      const e = createDiarizationDurationLimitError();
      e.timings = err.timings;
      throw e;
    }
    // The worker aborts on cancellation, a lost lease, or container shutdown.
    // Without this branch it would surface as a generic API failure.
    if (err instanceof OpenAI.APIUserAbortError) {
      const e = new Error('다화자 전사 요청이 중단되었습니다.');
      e.code = 'ABORTED';
      e.timings = err.timings;
      throw e;
    }
    // Must precede APIConnectionError, which this extends. Reporting a timeout as
    // a transient blip told a user to retry straight back into the same failure.
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      const e = new Error('다화자 변환이 제한 시간 안에 끝나지 않았습니다. 잠시 후 다시 시도하거나 파일을 나눠서 올려주세요.');
      e.code = 'TIMEOUT';
      e.timings = err.timings;
      throw e;
    }
    if (err instanceof OpenAI.APIConnectionError) {
      const e = new Error('OpenAI 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해주세요.');
      e.code = 'CONNECTION';
      e.timings = err.timings;
      throw e;
    }
    if (err.status === 429) {
      const quota = err.code === 'insufficient_quota';
      const e = new Error(quota
        ? '변환 서버(OpenAI) 사용량이 소진되었습니다. 관리자에게 문의해주세요.'
        : '요청이 일시적으로 많습니다. 잠시 후 다시 시도해주세요.');
      e.code = quota ? 'QUOTA' : 'RATELIMIT';
      e.timings = err.timings;
      throw e;
    }
    const wrapped = new Error(`Whisper Diarize API 오류: ${err.message}`);
    wrapped.timings = err.timings;
    throw wrapped;
  }
}

/**
 * @param {Buffer} buffer - 오디오 파일 버퍼
 * @param {string} originalname - 원본 파일명 (확장자 추출용)
 * @param {string} [language] - ISO-639-1 언어 코드 (없으면 자동 감지)
 * @returns {{ text: string, segments: object[], language: string }}
 */
export async function transcribe(buffer, originalname, language, { durationSeconds } = {}) {
  try {
    const params = {
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    };

    if (language) {
      params.language = language;
    }

    if (PARALLEL_TRANSCRIBE_ENABLED && Number.isFinite(durationSeconds) && durationSeconds >= PARALLEL_TRANSCRIBE_MIN_SECONDS) {
      const parallelResult = await transcribeLongAudioInParallel({
        buffer,
        originalname,
        params,
        durationSeconds,
      });
      if (parallelResult) {
        return {
          ...parallelResult,
          language: parallelResult.language === 'unknown' ? (language ?? 'unknown') : parallelResult.language,
        };
      }
    }

    const { response, timings } = await createTranscriptionWithFallback({
      buffer,
      originalname,
      params,
      logPrefix: 'whisper',
    });

    return {
      text: response.text,
      segments: response.segments ?? [],
      language: response.language ?? language ?? 'unknown',
      timings,
    };
  } catch (err) {
    if (err instanceof OpenAI.APIConnectionError) {
      const e = new Error('OpenAI 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해주세요.');
      e.code = 'CONNECTION';
      throw e;
    }
    if (err.status === 429) {
      const quota = err.code === 'insufficient_quota';
      const e = new Error(quota
        ? '변환 서버(OpenAI) 사용량이 소진되었습니다. 관리자에게 문의해주세요.'
        : '요청이 일시적으로 많습니다. 잠시 후 다시 시도해주세요.');
      e.code = quota ? 'QUOTA' : 'RATELIMIT';
      throw e;
    }
    throw new Error(`Whisper API 오류: ${err.message}`);
  }
}
