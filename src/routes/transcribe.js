import { Router } from 'express';
import uploadMiddleware from '../middleware/upload.js';
import { probeAudioDuration, transcribe, transcribeWithDiarization } from '../services/whisper.js';
import { processSegments } from '../services/postprocess.js';
import { authMiddleware } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

const router = Router();

function createTiming(req, res, next) {
  req.transcriptionTiming = {
    requestId: randomUUID(),
    startedAt: performance.now(),
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

function completeTiming(req, res, outcome) {
  const timing = req.transcriptionTiming;
  if (!timing) return;

  const totalMs = performance.now() - timing.startedAt;
  const fields = {
    total: totalMs,
    auth: timing.authMs,
    upload: timing.uploadMs,
    probe: timing.probeMs,
    compress: timing.compressionMs,
    openai: timing.openaiMs,
    correction: timing.correctionMs,
    credit: timing.creditMs,
    history: timing.historyMs,
  };
  const serverTiming = Object.entries(fields)
    .filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => `${name};dur=${roundTiming(value)}`)
    .join(', ');

  if (serverTiming) res.setHeader('Server-Timing', serverTiming);
  console.log('[transcribe.timing]', JSON.stringify({
    requestId: timing.requestId,
    outcome,
    ...Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => Number.isFinite(value))
        .map(([name, value]) => [`${name}Ms`, roundTiming(value)])
    ),
  }));
}

// 무음 세그먼트 필터링 (텍스트가 비어있거나 의미없는 내용만 있는 경우)
function filterSilentSegments(segments) {
  return segments.filter(seg => {
    const text = (seg.text || '').trim();
    // 빈 텍스트
    if (!text) return false;
    // Whisper가 무음에 넣는 패턴들: "...", "(무음)", "[음악]", "(음악)", "MBC 뉴스", 등
    const silencePatterns = /^(\.\.\.|…|\.+|\s+|\(.*무음.*\)|\[.*무음.*\]|\(.*음악.*\)|\[.*음악.*\]|\(.*박수.*\)|\[.*박수.*\])$/i;
    if (silencePatterns.test(text)) return false;
    // 공백·특수문자만 있는 경우
    if (/^[\s.,!?;:'"()\[\]{}…\-_]+$/.test(text)) return false;
    return true;
  });
}

// 한국어 텍스트에서 쉼표 제거
function removeCommas(text) {
  return text.replace(/,/g, '').replace(/，/g, '');
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

    const transcriptionStartedAt = performance.now();
    const result = diarize
      ? await transcribeWithDiarization(buffer, originalname, language)
      : await transcribe(buffer, originalname, language);
    req.transcriptionTiming.transcriptionMs = performance.now() - transcriptionStartedAt;
    req.transcriptionTiming.compressionMs = result.timings?.compressionMs;
    req.transcriptionTiming.openaiMs = result.timings?.openaiMs;

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

    // 4번: 무음 세그먼트 필터링
    let filteredSegments = filterSilentSegments(result.segments);

    // GPT 교정/번역 적용
    const correctionStartedAt = performance.now();
    let processedSegments;
    try {
      processedSegments = await processSegments(filteredSegments, result.language);
    } catch (gptErr) {
      console.error('[gpt]', gptErr.message);
      processedSegments = filteredSegments;
    }
    req.transcriptionTiming.correctionMs = performance.now() - correctionStartedAt;

    // 3번: 쉼표 제거 적용
    processedSegments = processedSegments.map(seg => ({
      ...seg,
      text: removeCommas(seg.text),
    }));

    // 5번: 줄바꿈으로 텍스트 결합 (기존: join(' ') → 변경: join('\n'))
    const processedText = processedSegments.map(s => s.text).join('\n');

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
    if (err.message.includes('Whisper API') || err.message.includes('Diarize API')) return res.status(502).json({ error: err.message });
    res.status(500).json({ error: '변환 중 오류가 발생했습니다.' });
  }
});

export default router;
