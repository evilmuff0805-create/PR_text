import { Router } from 'express';
import uploadMiddleware from '../middleware/upload.js';
import { transcribe } from '../services/whisper.js';
import { correctText, translateToKorean } from '../services/gpt.js';
import { authMiddleware } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

// 세그먼트 텍스트 일괄 교정/번역 헬퍼
async function processSegments(segments, detectedLang) {
  const lang = (detectedLang || '').toLowerCase();
  const CHUNK_SIZE = 30;
  if (!lang.includes('korean') && lang !== 'ko' &&
      !lang.includes('japanese') && lang !== 'ja' &&
      !lang.includes('chinese') && lang !== 'zh') {
    return segments;
  }
  const isTranslate = lang.includes('japanese') || lang === 'ja' ||
                      lang.includes('chinese') || lang === 'zh';
  const langName = (lang.includes('japanese') || lang === 'ja') ? '일본어' : '중국어';
  const result = [];
  for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
    const chunk = segments.slice(i, i + CHUNK_SIZE);
    const allText = chunk.map(s => s.text).join('\n');
    let processed;
    try {
      processed = isTranslate ? await translateToKorean(allText, langName)
                              : await correctText(allText, 'ko');
    } catch (err) {
      console.error('[gpt chunk]', i, err.message);
      result.push(...chunk);
      continue;
    }
    const lines = processed.split('\n');
    if (lines.length !== chunk.length) {
      console.warn(`[gpt chunk ${i}] 줄 수 불일치: 원본 ${chunk.length}줄, GPT ${lines.length}줄 → 원본 유지`);
      result.push(...chunk);
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      result.push({ ...chunk[j], text: (lines[j] || chunk[j].text).trim() });
    }
  }
  return result;
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
router.post('/', authMiddleware, uploadMiddleware, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '오디오 파일이 필요합니다.' });

    // 1단계: 변환 전 최소 크레딧 검증
    if (req.user.credits < 1) {
      return res.status(402).json({ error: '크레딧이 부족합니다. 충전 후 이용해주세요.' });
    }

    const { buffer, originalname } = req.file;
    const language = req.body.language || null;
    const result = await transcribe(buffer, originalname, language);

    // 오디오 길이 → 크레딧 필요량 (1분당 1크레딧, 최소 1)
    const lastSegment = result.segments[result.segments.length - 1];
    const totalSeconds = lastSegment ? lastSegment.end : 0;
    const audioMinutes = Math.ceil(totalSeconds / 60);
    const creditsNeeded = Math.max(audioMinutes, 1);

    // 2단계: Atomic 크레딧 차감 (race condition 방지)
    // Supabase RPC 함수 deduct_credits 호출:
    //   UPDATE profiles SET credits = credits - p_credits, updated_at = now()
    //   WHERE id = p_user_id AND credits >= p_credits
    //   RETURNING credits
    // 크레딧 부족 또는 동시 요청으로 조건 불충족 시 null 반환
    const { data: deducted, error: deductErr } = await supabaseAdmin.rpc('deduct_credits', {
      p_user_id: req.user.id,
      p_credits: creditsNeeded,
    });

    if (deductErr) {
      console.error(`[transcribe] 크레딧 차감 DB 오류 — user_id: ${req.user.id}, creditsNeeded: ${creditsNeeded}`, deductErr.message);
      return res.status(500).json({ error: '크레딧 처리 중 오류가 발생했습니다.' });
    }

    if (deducted === null || deducted === undefined) {
      return res.status(402).json({
        error: `크레딧이 부족합니다. 필요: ${creditsNeeded}, 보유: ${req.user.credits}`,
        creditsNeeded,
        creditsHave: req.user.credits,
      });
    }

    const newCredits = deducted;

    // 사용 로그 기록
    await supabaseAdmin.from('usage_logs').insert({
      user_id: req.user.id,
      action: 'transcribe',
      credits_used: creditsNeeded,
      audio_minutes: parseFloat((totalSeconds / 60).toFixed(1)),
      description: `${originalname} (${(totalSeconds / 60).toFixed(1)}분)`,
    });

    console.log(`[transcribe] 유저 ${req.user.email}: ${creditsNeeded}크레딧 차감 (${newCredits} 남음)`);

    // 4번: 무음 세그먼트 필터링
    let filteredSegments = filterSilentSegments(result.segments);

    // GPT 교정/번역 적용
    let processedSegments;
    try {
      processedSegments = await processSegments(filteredSegments, result.language);
    } catch (gptErr) {
      console.error('[gpt]', gptErr.message);
      processedSegments = filteredSegments;
    }

    // 3번: 쉼표 제거 적용
    processedSegments = processedSegments.map(seg => ({
      ...seg,
      text: removeCommas(seg.text),
    }));

    // 5번: 줄바꿈으로 텍스트 결합 (기존: join(' ') → 변경: join('\n'))
    const processedText = processedSegments.map(s => s.text).join('\n');

    // 변환 이력 기록 (실패해도 응답에 영향 없음)
    supabaseAdmin.from('transcription_logs').insert({
      user_id: req.user.id,
      filename: originalname,
      duration_seconds: totalSeconds,
      language: result.language,
      segments_count: processedSegments.length,
      text_preview: processedText.slice(0, 200),
      segments: processedSegments,
    }).then(({ error }) => {
      if (error) console.error('[transcription_logs] 기록 실패:', error.message);
    });

    res.json({
      text: processedText,
      segments: processedSegments,
      language: result.language,
      creditsUsed: creditsNeeded,
      creditsRemaining: newCredits,
    });
  } catch (err) {
    console.error('[transcribe]', err.message);
    if (err.message.includes('지원하지 않는 파일')) return res.status(415).json({ error: err.message });
    if (err.message.includes('Whisper API')) return res.status(502).json({ error: err.message });
    res.status(500).json({ error: '변환 중 오류가 발생했습니다.' });
  }
});

export default router;
