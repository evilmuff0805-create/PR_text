import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { translateToEnglish } from '../services/gpt.js';

const router = Router();

const CHUNK_SIZE = 30;

// POST /api/translate
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { segments } = req.body;
    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'segments 배열이 필요합니다.' });
    }

    const translatedSegments = [];

    for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
      const chunk = segments.slice(i, i + CHUNK_SIZE);
      const allText = chunk.map(s => s.text).join('\n');
      let translated;
      try {
        translated = await translateToEnglish(allText);
      } catch (err) {
        console.error('[translate chunk]', i, err.message);
        // 실패 시 원본 텍스트 유지
        for (const seg of chunk) {
          translatedSegments.push({ ...seg, translatedText: seg.text });
        }
        continue;
      }

      const lines = translated.split('\n');
      if (lines.length !== chunk.length) {
        console.warn(`[translate chunk ${i}] 줄 수 불일치: 원본 ${chunk.length}줄, GPT ${lines.length}줄 → 원본 유지`);
        for (const seg of chunk) {
          translatedSegments.push({ ...seg, translatedText: seg.text });
        }
        continue;
      }

      for (let j = 0; j < chunk.length; j++) {
        translatedSegments.push({ ...chunk[j], translatedText: (lines[j] || chunk[j].text).trim() });
      }
    }

    res.json({ translatedSegments });
  } catch (err) {
    console.error('[translate]', err.message);
    res.status(500).json({ error: '번역 중 오류가 발생했습니다.' });
  }
});

export default router;
