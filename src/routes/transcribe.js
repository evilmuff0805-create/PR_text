import { Router } from 'express';
import uploadMiddleware from '../middleware/upload.js';
import { prepareDiarizationAudioForStorage, probeAudioDuration, transcribe } from '../services/whisper.js';
import { authMiddleware } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { enqueueDiarizationJob } from '../services/diarization-jobs.js';
import { joinSegmentText, processTranscriptionSegments } from '../services/transcription-processing.js';

const router = Router();

function createTiming(req, res, next) {
  req.transcriptionTiming = {
    requestId: randomUUID(),
    startedAt: performance.now(),
    wallStartedAt: Date.now(),
  };
  next();
}

function timedAuth(req, res, next) {
  const startedAt = performance.now();
  Promise.resolve(authMiddleware(req, res, (err) => {
    req.transcriptionTiming.authMs = performance.now() - startedAt;
    next(err);
  })).catch(next);
}

function timedUpload(req, res, next) {
  const startedAt = performance.now();
  uploadMiddleware(req, res, (err) => {
    req.transcriptionTiming.uploadMs = performance.now() - startedAt;
    next(err);
  });
}

function roundTiming(value) {
  return Number(value.toFixed(1));
}

function summarizeParallelChunks(chunks) {
  if (!Array.isArray(chunks)) return undefined;
  return chunks.map((chunk) => ({
    index: chunk.index,
    ownedStartSeconds: roundTiming(chunk.ownedStartSeconds),
    ownedEndSeconds: roundTiming(chunk.ownedEndSeconds),
    inputStartSeconds: roundTiming(chunk.inputStartSeconds),
    inputEndSeconds: roundTiming(chunk.inputEndSeconds),
    compressionMs: roundTiming(chunk.compressionMs),
    openaiMs: roundTiming(chunk.openaiMs),
    openaiAttempts: chunk.openaiAttempts.map((attempt) => ({
      phase: attempt.phase,
      outcome: attempt.outcome,
      durationMs: roundTiming(attempt.durationMs),
    })),
  }));
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
    wallMs: roundTiming(timings.wallMs),
    chunkCount: timings.chunkCount,
    batchCount: timings.batchCount,
    concurrency: timings.concurrency,
    batches: timings.batches?.map((batch) => ({
      ...batch,
      durationMs: roundTiming(batch.durationMs),
    })),
    chunks: timings.chunks.map((chunk) => ({
      index: chunk.index,
      segmentCount: chunk.segmentCount,
      outcome: chunk.outcome,
      durationMs: roundTiming(chunk.durationMs),
    })),
  };
}

function completeTiming(req, res, outcome) {
  const timing = req.transcriptionTiming;
  if (!timing) return;

  const completedAt = Date.now();
  const totalMs = performance.now() - timing.startedAt;
  const totalWallMs = completedAt - timing.wallStartedAt;
  const fields = {
    total: totalMs,
    wall: totalWallMs,
    auth: timing.authMs,
    upload: timing.uploadMs,
    probe: timing.probeMs,
    split: timing.splitMs,
    compress: timing.compressionMs,
    openai: timing.openaiMs,
    transcription: timing.transcriptionMs,
    correction: timing.correctionMs,
    credit: timing.creditMs,
    usageLog: timing.usageLogMs,
    history: timing.historyMs,
  };
  const serverTiming = Object.entries(fields)
    .filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => `${name};dur=${roundTiming(value)}`)
    .join(', ');

  if (serverTiming) res.setHeader('Server-Timing', serverTiming);
  const stageNamesExceedingTotal = Object.entries(fields)
    .filter(([name, value]) => name !== 'total' && name !== 'wall' && Number.isFinite(value) && value > totalWallMs + 1_000)
    .map(([name]) => name);
  const monotonicWallDeltaMs = Math.abs(totalMs - totalWallMs);

  console.log('[transcribe.timing]', JSON.stringify({
    requestId: timing.requestId,
    outcome,
    wallStartedAt: new Date(timing.wallStartedAt).toISOString(),
    wallCompletedAt: new Date(completedAt).toISOString(),
    chunkCount: timing.chunkCount ?? 1,
    language: timing.language,
    segmentCount: timing.segmentCount,
    openaiAggregateMs: Number.isFinite(timing.openaiAggregateMs) ? roundTiming(timing.openaiAggregateMs) : undefined,
    openaiAttempts: timing.openaiAttempts?.map((attempt) => ({
      phase: attempt.phase,
      outcome: attempt.outcome,
      durationMs: roundTiming(attempt.durationMs),
    })),
    preconvertedM4a: timing.preconvertedM4a,
    parallelChunks: summarizeParallelChunks(timing.parallelChunkTimings),
    correction: summarizeCorrection(timing.correctionTimings),
    timingMismatch: {
      detected: monotonicWallDeltaMs > 1_000 || stageNamesExceedingTotal.length > 0,
      monotonicWallDeltaMs: roundTiming(monotonicWallDeltaMs),
      stagesExceedingTotal: stageNamesExceedingTotal,
    },
    ...Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => Number.isFinite(value))
        .map(([name, value]) => [`${name}Ms`, roundTiming(value)])
    ),
  }));
}

// POST /api/transcribe
router.post('/', createTiming, timedAuth, timedUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '오디오 파일이 필요합니다.' });

    // 1단계: 변환 전 최소 크레딧 검증
    if (req.user.credits < 1) {
      return res.status(402).json({ error: '변환 가능 시간이 부족합니다. 충전 후 이용해주세요.' });
    }

    const { buffer, originalname } = req.file;
    const language = req.body.language || null;
    const diarize = req.body.diarize === 'true' || req.body.diarize === true;
    const probeStartedAt = performance.now();
    let durationSeconds = null;
    try {
      durationSeconds = await probeAudioDuration(buffer, originalname);
    } catch (probeErr) {
      console.warn(`[transcribe.duration] 길이 사전 확인 실패: ${probeErr.message}`);
    } finally {
      req.transcriptionTiming.probeMs = performance.now() - probeStartedAt;
    }

    if (durationSeconds !== null) {
      const creditsNeeded = Math.max(Math.ceil(durationSeconds / 60), 1);
      if (req.user.credits < creditsNeeded) {
        completeTiming(req, res, 'insufficient_credits_before_transcription');
        return res.status(402).json({
          error: `변환 가능 시간이 부족합니다. 필요: ${creditsNeeded}분, 보유: ${req.user.credits}분`,
          creditsNeeded,
          creditsHave: req.user.credits,
        });
      }
    }

    if (diarize) {
      if (durationSeconds === null) {
        completeTiming(req, res, 'duration_probe_required_for_diarization');
        return res.status(422).json({
          error: '다화자 변환을 위해 파일 길이를 확인하지 못했습니다. 다른 형식으로 다시 시도해주세요.',
        });
      }

      if (durationSeconds > 20 * 60) {
        completeTiming(req, res, 'diarization_duration_limit');
        return res.status(400).json({
          error: '다화자 분리 모드는 최대 20분 음성만 지원합니다. 파일을 분할 후 다시 시도해주세요.',
        });
      }

      const creditsNeeded = Math.max(Math.ceil(durationSeconds / 60), 1);
      const compressionStartedAt = performance.now();
      let queuedAudio;
      try {
        queuedAudio = await prepareDiarizationAudioForStorage({
          buffer,
          originalname,
          contentType: req.file.mimetype,
        });
      } finally {
        req.transcriptionTiming.compressionMs = performance.now() - compressionStartedAt;
      }
      const queued = await enqueueDiarizationJob({
        userId: req.user.id,
        filename: originalname,
        storageFilename: queuedAudio.filename,
        buffer: queuedAudio.buffer,
        contentType: queuedAudio.contentType,
        language,
        durationSeconds,
        creditsNeeded,
      });

      if (!queued) {
        completeTiming(req, res, 'insufficient_credits_when_queuing_diarization');
        return res.status(402).json({
          error: `변환 가능 시간이 부족합니다. 필요: ${creditsNeeded}분, 보유: ${req.user.credits}분`,
          creditsNeeded,
          creditsHave: req.user.credits,
        });
      }

      console.log(`[diarization.job] 유저 ${req.user.email}: ${creditsNeeded}크레딧 예약 (${queued.creditsRemaining} 남음), job=${queued.jobId}`);
      completeTiming(req, res, 'diarization_queued');
      return res.status(202).json({
        jobId: queued.jobId,
        status: 'queued',
        creditsUsed: queued.creditsUsed,
        creditsRemaining: queued.creditsRemaining,
        diarize: true,
      });
    }

    const transcriptionStartedAt = performance.now();
    const result = await transcribe(buffer, originalname, language, { durationSeconds });
    req.transcriptionTiming.transcriptionMs = performance.now() - transcriptionStartedAt;
    req.transcriptionTiming.compressionMs = result.timings?.compressionMs;
    req.transcriptionTiming.splitMs = result.timings?.splitMs;
    req.transcriptionTiming.openaiMs = result.timings?.openaiMs;
    req.transcriptionTiming.openaiAggregateMs = result.timings?.openaiAggregateMs;
    req.transcriptionTiming.openaiAttempts = result.timings?.openaiAttempts;
    req.transcriptionTiming.preconvertedM4a = result.timings?.preconvertedM4a;
    req.transcriptionTiming.parallelChunkTimings = result.timings?.chunkTimings;
    req.transcriptionTiming.chunkCount = result.timings?.chunkCount;
    req.transcriptionTiming.language = result.language;
    req.transcriptionTiming.segmentCount = result.segments.length;

    // 오디오 길이 → 크레딧 필요량 (1분당 1크레딧, 최소 1)
    const lastSegment = result.segments[result.segments.length - 1];
    const totalSeconds = durationSeconds ?? (lastSegment ? lastSegment.end : 0);
    const audioMinutes = Math.ceil(totalSeconds / 60);
    const creditsNeeded = Math.max(audioMinutes, 1);

    // 2단계: Atomic 크레딧 차감 (race condition 방지)
    // Supabase RPC 함수 deduct_credits 호출:
    //   UPDATE profiles SET credits = credits - p_credits, updated_at = now()
    //   WHERE id = p_user_id AND credits >= p_credits
    //   RETURNING credits
    // 크레딧 부족 또는 동시 요청으로 조건 불충족 시 null 반환
    const creditStartedAt = performance.now();
    const { data: deducted, error: deductErr } = await supabaseAdmin.rpc('deduct_credits', {
      p_user_id: req.user.id,
      p_credits: creditsNeeded,
    });
    req.transcriptionTiming.creditMs = performance.now() - creditStartedAt;

    if (deductErr) {
      console.error(`[transcribe] 크레딧 차감 DB 오류 — user_id: ${req.user.id}, creditsNeeded: ${creditsNeeded}`, deductErr.message);
      completeTiming(req, res, 'credit_error');
      return res.status(500).json({ error: '변환 시간 처리 중 오류가 발생했습니다.' });
    }

    if (deducted === null || deducted === undefined) {
      completeTiming(req, res, 'insufficient_credits_after_transcription');
      return res.status(402).json({
        error: `변환 가능 시간이 부족합니다. 필요: ${creditsNeeded}분, 보유: ${req.user.credits}분`,
        creditsNeeded,
        creditsHave: req.user.credits,
      });
    }

    const newCredits = deducted;

    // 사용 로그 기록
    const usageLogStartedAt = performance.now();
    await supabaseAdmin.from('usage_logs').insert({
      user_id: req.user.id,
      action: 'transcribe',
      credits_used: creditsNeeded,
      audio_minutes: parseFloat((totalSeconds / 60).toFixed(1)),
      description: `${originalname} (${(totalSeconds / 60).toFixed(1)}분)`,
    });
    req.transcriptionTiming.usageLogMs = performance.now() - usageLogStartedAt;

    console.log(`[transcribe] 유저 ${req.user.email}: ${creditsNeeded}크레딧 차감 (${newCredits} 남음)`);

    // GPT 교정/번역 적용
    const processedResult = await processTranscriptionSegments(result.segments, result.language);
    const processedSegments = processedResult.segments;
    req.transcriptionTiming.correctionTimings = processedResult.correctionTimings;
    req.transcriptionTiming.correctionMs = processedResult.correctionMs;

    const processedText = joinSegmentText(processedSegments);

    // 변환 이력 기록
    const historyStartedAt = performance.now();
    const { error: logErr } = await supabaseAdmin.from('transcription_logs').insert({
      user_id: req.user.id,
      filename: originalname,
      duration_seconds: totalSeconds,
      language: result.language,
      segments_count: processedSegments.length,
      text_preview: processedText.slice(0, 200),
      segments: processedSegments,
    });
    req.transcriptionTiming.historyMs = performance.now() - historyStartedAt;
    if (logErr) console.error('[transcription_logs] 기록 실패:', logErr.message);

    completeTiming(req, res, 'success');
    res.json({
      text: processedText,
      segments: processedSegments,
      language: result.language,
      creditsUsed: creditsNeeded,
      creditsRemaining: newCredits,
      diarize,
    });
  } catch (err) {
    console.error('[transcribe]', err.message);
    completeTiming(req, res, 'error');
    if (err.code === 'CONNECTION') return res.status(503).json({ error: err.message, retryable: true });
    if (err.code === 'QUOTA') return res.status(503).json({ error: err.message });
    if (err.code === 'RATELIMIT') return res.status(429).json({ error: err.message });
    if (err.message.includes('지원하지 않는 파일')) return res.status(415).json({ error: err.message });
    if (err.message.includes('최대 20분')) return res.status(400).json({ error: err.message });
    if (err.code === 'DIARIZATION_STORAGE_LIMIT') return res.status(413).json({ error: err.message });
    if (err.message.includes('Whisper API') || err.message.includes('Diarize API')) return res.status(502).json({ error: err.message });
    res.status(500).json({ error: '변환 중 오류가 발생했습니다.' });
  }
});

export default router;
