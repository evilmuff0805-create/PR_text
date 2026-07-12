import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { supabaseAdmin } from '../lib/supabase.js';
import { transcribeWithDiarization } from './whisper.js';
import { joinSegmentText, processTranscriptionSegments } from './transcription-processing.js';

const STORAGE_BUCKET = 'transcription-jobs';
const JOB_POLL_INTERVAL_MS = 5_000;
const JOB_LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let workerTimer;
let workerBusy = false;
let workerCycleBusy = false;

export function isDiarizationJobId(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

export function toClientDiarizationJob(job, creditsRemaining) {
  const completed = job.status === 'completed';
  const failed = job.status === 'failed';

  return {
    id: job.id,
    status: job.status,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    updatedAt: job.updated_at,
    filename: job.filename,
    creditsUsed: job.credits_reserved,
    creditsRemaining,
    creditsRefunded: job.credits_refunded,
    text: completed ? job.result_text : undefined,
    segments: completed ? job.result_segments : undefined,
    language: completed ? job.result_language : undefined,
    error: failed ? '변환에 실패해 예약한 변환 시간이 자동 환불되었습니다.' : undefined,
  };
}

function storagePathFor(userId, storageFilename) {
  const extension = storageFilename?.toLowerCase().endsWith('.mp3') ? '.mp3' : '';
  return `${userId}/${randomUUID()}${extension}`;
}

export function storageFilenameForJob(job) {
  return job.storage_path?.toLowerCase().endsWith('.mp3') ? 'queued-audio.mp3' : job.filename;
}

function roundTiming(value) {
  return Number(value.toFixed(1));
}

function summarizeCorrection(timings) {
  if (!timings) return undefined;

  return {
    eligible: timings.eligible,
    languageDecision: timings.languageDecision,
    model: timings.model,
    requestedModel: timings.requestedModel,
    fallbackCount: timings.fallbackCount,
    usage: timings.usage,
    estimatedCostUsd: Number.isFinite(timings.estimatedCostUsd)
      ? Number(timings.estimatedCostUsd.toFixed(8))
      : undefined,
    wallMs: Number.isFinite(timings.wallMs) ? roundTiming(timings.wallMs) : undefined,
    chunkCount: timings.chunkCount,
    batchCount: timings.batchCount,
    concurrency: timings.concurrency,
    batches: timings.batches?.map((batch) => ({
      ...batch,
      durationMs: roundTiming(batch.durationMs),
    })),
    chunks: timings.chunks?.map((chunk) => ({
      index: chunk.index,
      segmentCount: chunk.segmentCount,
      outcome: chunk.outcome,
      durationMs: roundTiming(chunk.durationMs),
    })),
  };
}

export function createDiarizationJobTimingLog({
  job,
  outcome,
  startedAt,
  wallStartedAt,
  completedAt = performance.now(),
  wallCompletedAt = Date.now(),
  timings,
  rawTimings,
  correctionTimings,
  segmentCount,
  language,
  error,
  creditsRefunded,
}) {
  const totalMs = completedAt - startedAt;
  const wallMs = wallCompletedAt - wallStartedAt;
  const fields = {
    claim: timings.claimMs,
    storageDownload: timings.storageDownloadMs,
    transcription: timings.transcriptionMs,
    processing: timings.processingMs,
    persistence: timings.persistenceMs,
    history: timings.historyMs,
    completion: timings.completionMs,
    cleanup: timings.cleanupMs,
    refund: timings.refundMs,
  };
  const stageNamesExceedingTotal = Object.entries(fields)
    .filter(([name, value]) => !['history', 'completion'].includes(name) && Number.isFinite(value) && value > wallMs + 1_000)
    .map(([name]) => name);
  const monotonicWallDeltaMs = Math.abs(totalMs - wallMs);

  return {
    jobId: job.id,
    outcome,
    attempt: job.attempt_count,
    wallStartedAt: new Date(wallStartedAt).toISOString(),
    wallCompletedAt: new Date(wallCompletedAt).toISOString(),
    segmentCount,
    language,
    preconvertedM4a: rawTimings?.preconvertedM4a,
    openaiAttempts: rawTimings?.openaiAttempts?.map((attempt) => ({
      phase: attempt.phase,
      outcome: attempt.outcome,
      durationMs: roundTiming(attempt.durationMs),
    })),
    correction: summarizeCorrection(correctionTimings),
    creditsRefunded,
    error: error?.message,
    timingMismatch: {
      detected: monotonicWallDeltaMs > 1_000 || stageNamesExceedingTotal.length > 0,
      monotonicWallDeltaMs: roundTiming(monotonicWallDeltaMs),
      stagesExceedingTotal: stageNamesExceedingTotal,
    },
    totalMs: roundTiming(totalMs),
    wallMs: roundTiming(wallMs),
    ...Object.fromEntries(
      Object.entries({
        ...fields,
        compression: rawTimings?.compressionMs,
        openai: rawTimings?.openaiMs,
      })
        .filter(([, value]) => Number.isFinite(value))
        .map(([name, value]) => [`${name}Ms`, roundTiming(value)])
    ),
  };
}

async function removeAudio(storagePath) {
  const { error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]);
  if (error) {
    console.warn(`[diarization.job] 원본 삭제 실패: ${error.message}`);
    return false;
  }
  return true;
}

async function removeJobAudio(job) {
  if (!(await removeAudio(job.storage_path))) return;

  const { error } = await supabaseAdmin
    .from('transcription_jobs')
    .update({ audio_deleted_at: new Date().toISOString() })
    .eq('id', job.id)
    .is('audio_deleted_at', null);
  if (error) console.warn(`[diarization.job] 원본 삭제 기록 실패: ${error.message}`);
}

async function cleanUpFinishedAudio() {
  const { data: jobs, error } = await supabaseAdmin
    .from('transcription_jobs')
    .select('id, storage_path')
    .in('status', ['completed', 'failed'])
    .is('audio_deleted_at', null)
    .limit(10);

  if (error) throw new Error(`다화자 작업 원본 정리 조회 실패: ${error.message}`);
  await Promise.all((jobs || []).map(removeJobAudio));
}

export async function enqueueDiarizationJob({
  userId,
  filename,
  storageFilename,
  buffer,
  contentType,
  language,
  durationSeconds,
  creditsNeeded,
}) {
  const storagePath = storagePathFor(userId, storageFilename);
  const { error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: contentType || 'application/octet-stream',
      upsert: false,
    });

  if (uploadError) {
    const error = new Error(`다화자 작업 원본 저장 실패: ${uploadError.message}`);
    if (/exceeded the maximum allowed size/i.test(uploadError.message || '')) {
      error.code = 'DIARIZATION_STORAGE_LIMIT';
    }
    throw error;
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('enqueue_diarization_job', {
      p_user_id: userId,
      p_filename: filename,
      p_storage_path: storagePath,
      p_requested_language: language || null,
      p_duration_seconds: durationSeconds,
      p_credits: creditsNeeded,
    });

    if (error) throw new Error(`다화자 작업 예약 실패: ${error.message}`);

    const queued = data?.[0];
    if (!queued?.job_id) {
      await removeAudio(storagePath);
      return null;
    }

    return {
      jobId: queued.job_id,
      creditsRemaining: queued.credits_remaining,
      creditsUsed: creditsNeeded,
    };
  } catch (error) {
    await removeAudio(storagePath);
    throw error;
  }
}

export async function getDiarizationJobForUser(jobId, userId) {
  const { data, error } = await supabaseAdmin
    .from('transcription_jobs')
    .select('id, status, created_at, started_at, completed_at, updated_at, filename, credits_reserved, credits_refunded, result_text, result_segments, result_language')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`다화자 작업 조회 실패: ${error.message}`);
  if (!data) return null;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .single();

  if (profileError) throw new Error(`크레딧 조회 실패: ${profileError.message}`);
  return toClientDiarizationJob(data, profile.credits);
}

export async function cancelDiarizationJobForUser(jobId, userId) {
  const { data: job, error: jobError } = await supabaseAdmin
    .from('transcription_jobs')
    .select('id, storage_path')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();

  if (jobError) throw new Error(`다화자 작업 취소 조회 실패: ${jobError.message}`);
  if (!job) return null;

  const { data, error } = await supabaseAdmin.rpc('cancel_diarization_job', {
    p_job_id: jobId,
    p_user_id: userId,
  });
  if (error) throw new Error(`다화자 작업 취소 실패: ${error.message}`);

  const cancelled = data?.[0];
  if (!cancelled?.updated) return null;

  await removeJobAudio(job);
  return { creditsRemaining: cancelled.credits_remaining };
}

async function claimNextDiarizationJob(workerToken) {
  const { data, error } = await supabaseAdmin.rpc('claim_diarization_job', {
    p_worker_token: workerToken,
  });

  if (error) throw new Error(`다화자 작업 claim 실패: ${error.message}`);
  return data?.[0] || null;
}

function startJobLeaseHeartbeat(job, workerToken) {
  let stopped = false;
  let renewing = false;

  const renew = async () => {
    if (stopped || renewing) return;
    renewing = true;
    try {
      const { data, error } = await supabaseAdmin.rpc('renew_diarization_job_lease', {
        p_job_id: job.id,
        p_worker_token: workerToken,
      });
      if (error) {
        console.warn(`[diarization.job] lease 갱신 실패: job=${job.id} ${error.message}`);
      } else if (!data) {
        console.warn(`[diarization.job] lease를 잃어 갱신을 중단합니다: job=${job.id}`);
        stopped = true;
      }
    } catch (error) {
      console.warn(`[diarization.job] lease 갱신 오류: job=${job.id} ${error.message}`);
    } finally {
      renewing = false;
    }
  };

  const timer = setInterval(() => {
    renew();
  }, JOB_LEASE_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function storeCompletedJob(job, workerToken, result) {
  const historyStartedAt = performance.now();
  const { data: transcriptionLog, error: logError } = await supabaseAdmin
    .from('transcription_logs')
    .insert({
      user_id: job.user_id,
      filename: job.filename,
      duration_seconds: job.duration_seconds,
      language: result.language,
      segments_count: result.segments.length,
      text_preview: result.text.slice(0, 200),
      segments: result.segments,
    })
    .select('id')
    .single();

  if (logError) throw new Error(`다화자 작업 이력 기록 실패: ${logError.message}`);

  const completionStartedAt = performance.now();
  const { data: completed, error } = await supabaseAdmin.rpc('complete_diarization_job', {
    p_job_id: job.id,
    p_worker_token: workerToken,
    p_result_text: result.text,
    p_result_segments: result.segments,
    p_result_language: result.language,
    p_transcription_log_id: transcriptionLog.id,
  });

  if (error) throw new Error(`다화자 작업 완료 기록 실패: ${error.message}`);
  if (!completed) throw new Error('다화자 작업 lease가 만료되어 결과를 저장하지 못했습니다.');

  return {
    historyMs: completionStartedAt - historyStartedAt,
    completionMs: performance.now() - completionStartedAt,
  };
}

async function refundFailedJob(job, workerToken, error) {
  const { data, error: refundError } = await supabaseAdmin.rpc('fail_diarization_job', {
    p_job_id: job.id,
    p_worker_token: workerToken,
    p_error_message: error.message,
  });

  if (refundError) {
    console.error(`[diarization.job] 환불 처리 실패: job=${job.id} ${refundError.message}`);
    return false;
  }

  if (data?.[0]?.updated) {
    console.warn(`[diarization.job] 작업 실패 및 환불 완료: job=${job.id}`);
    return true;
  }

  return false;
}

async function processNextDiarizationJob() {
  if (workerBusy) return;
  workerBusy = true;

  const workerToken = randomUUID();
  let job;
  const startedAt = performance.now();
  const wallStartedAt = Date.now();
  const timings = {};
  let rawResult;
  let processedResult;
  let result;
  let stopLeaseHeartbeat;
  try {
    const claimStartedAt = performance.now();
    job = await claimNextDiarizationJob(workerToken);
    timings.claimMs = performance.now() - claimStartedAt;
    if (!job) return;

    console.log(`[diarization.job] 시작: job=${job.id} attempt=${job.attempt_count}`);
    stopLeaseHeartbeat = startJobLeaseHeartbeat(job, workerToken);
    const storageDownloadStartedAt = performance.now();
    const { data: audio, error: downloadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .download(job.storage_path);
    if (downloadError) throw new Error(`다화자 작업 원본 다운로드 실패: ${downloadError.message}`);

    const buffer = Buffer.from(await audio.arrayBuffer());
    timings.storageDownloadMs = performance.now() - storageDownloadStartedAt;
    const transcriptionStartedAt = performance.now();
    rawResult = await transcribeWithDiarization(
      buffer,
      storageFilenameForJob(job),
      job.requested_language,
    );
    timings.transcriptionMs = performance.now() - transcriptionStartedAt;
    const processingStartedAt = performance.now();
    processedResult = await processTranscriptionSegments(rawResult.segments, rawResult.language);
    result = {
      text: joinSegmentText(processedResult.segments),
      segments: processedResult.segments,
      language: rawResult.language,
    };
    timings.processingMs = performance.now() - processingStartedAt;

    const persistenceStartedAt = performance.now();
    const persistenceTimings = await storeCompletedJob(job, workerToken, result);
    timings.persistenceMs = performance.now() - persistenceStartedAt;
    Object.assign(timings, persistenceTimings);
    const cleanupStartedAt = performance.now();
    await removeJobAudio(job);
    timings.cleanupMs = performance.now() - cleanupStartedAt;
    console.log('[diarization.job.timing]', JSON.stringify(createDiarizationJobTimingLog({
      job,
      outcome: 'success',
      startedAt,
      wallStartedAt,
      timings,
      rawTimings: rawResult.timings,
      correctionTimings: processedResult.correctionTimings,
      segmentCount: result.segments.length,
      language: result.language,
      creditsRefunded: false,
    })));
  } catch (error) {
    console.error(`[diarization.job] 실패: job=${job?.id || '-'} ${error.message}`);
    if (job) {
      const refundStartedAt = performance.now();
      const failed = await refundFailedJob(job, workerToken, error);
      timings.refundMs = performance.now() - refundStartedAt;
      if (failed) {
        const cleanupStartedAt = performance.now();
        await removeJobAudio(job);
        timings.cleanupMs = performance.now() - cleanupStartedAt;
      }
      console.log('[diarization.job.timing]', JSON.stringify(createDiarizationJobTimingLog({
        job,
        outcome: 'error',
        startedAt,
        wallStartedAt,
        timings,
        rawTimings: rawResult?.timings,
        correctionTimings: processedResult?.correctionTimings,
        segmentCount: result?.segments.length,
        language: result?.language,
        error,
        creditsRefunded: failed,
      })));
    }
  } finally {
    stopLeaseHeartbeat?.();
    workerBusy = false;
  }
}

async function runWorkerCycle() {
  if (workerCycleBusy) return;
  workerCycleBusy = true;
  try {
    await cleanUpFinishedAudio();
    await processNextDiarizationJob();
  } finally {
    workerCycleBusy = false;
  }
}

export function startDiarizationJobWorker() {
  if (workerTimer) return;

  workerTimer = setInterval(() => {
    runWorkerCycle().catch((error) => {
      console.error(`[diarization.job] worker 오류: ${error.message}`);
    });
  }, JOB_POLL_INTERVAL_MS);

  runWorkerCycle().catch((error) => {
    console.error(`[diarization.job] worker 초기화 오류: ${error.message}`);
  });
}
