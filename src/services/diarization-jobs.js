import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { transcribeWithDiarization } from './whisper.js';
import { joinSegmentText, processTranscriptionSegments } from './transcription-processing.js';

const STORAGE_BUCKET = 'transcription-jobs';
const JOB_POLL_INTERVAL_MS = 5_000;
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

function storagePathFor(userId) {
  return `${userId}/${randomUUID()}`;
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
  buffer,
  contentType,
  language,
  durationSeconds,
  creditsNeeded,
}) {
  const storagePath = storagePathFor(userId);
  const { error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: contentType || 'application/octet-stream',
      upsert: false,
    });

  if (uploadError) throw new Error(`다화자 작업 원본 저장 실패: ${uploadError.message}`);

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
    .select('id, status, created_at, started_at, completed_at, filename, credits_reserved, credits_refunded, result_text, result_segments, result_language')
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

async function claimNextDiarizationJob(workerToken) {
  const { data, error } = await supabaseAdmin.rpc('claim_diarization_job', {
    p_worker_token: workerToken,
  });

  if (error) throw new Error(`다화자 작업 claim 실패: ${error.message}`);
  return data?.[0] || null;
}

async function storeCompletedJob(job, workerToken, result) {
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
  try {
    job = await claimNextDiarizationJob(workerToken);
    if (!job) return;

    console.log(`[diarization.job] 시작: job=${job.id} attempt=${job.attempt_count}`);
    const { data: audio, error: downloadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .download(job.storage_path);
    if (downloadError) throw new Error(`다화자 작업 원본 다운로드 실패: ${downloadError.message}`);

    const buffer = Buffer.from(await audio.arrayBuffer());
    const rawResult = await transcribeWithDiarization(
      buffer,
      job.filename,
      job.requested_language,
    );
    const processedResult = await processTranscriptionSegments(rawResult.segments, rawResult.language);
    const result = {
      text: joinSegmentText(processedResult.segments),
      segments: processedResult.segments,
      language: rawResult.language,
    };

    await storeCompletedJob(job, workerToken, result);
    await removeJobAudio(job);
    console.log('[diarization.job]', JSON.stringify({
      jobId: job.id,
      outcome: 'success',
      segmentCount: result.segments.length,
      language: result.language,
      correctionMs: Number(processedResult.correctionMs.toFixed(1)),
      correction: processedResult.correctionTimings,
    }));
  } catch (error) {
    console.error(`[diarization.job] 실패: job=${job?.id || '-'} ${error.message}`);
    if (job) {
      const failed = await refundFailedJob(job, workerToken, error);
      if (failed) await removeJobAudio(job);
    }
  } finally {
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
