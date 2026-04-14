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
      // 1-based 번호를 붙여서 전송: "1: 텍스트\n2: 텍스트\n..."
      const numberedText = chunk.map((s, j) => `${j + 1}: ${s.text}`).join('\n');
      let translated;
      try {
        translated = await translateToEnglish(numberedText);
      } catch (err) {
        console.error('[translate chunk]', i, err.message);
        for (const seg of chunk) {
          translatedSegments.push({ ...seg, translatedText: '(번역 없음)' });
        }
        continue;
      }

      // 번호 기준으로 파싱: "1: translation text" → { 1: 'translation text', ... }
      const translationMap = {};
      for (const line of translated.split('\n')) {
        const match = line.match(/^(\d+):\s*(.+)/);
        if (match) {
          translationMap[parseInt(match[1], 10)] = match[2].trim();
        }
      }

      for (let j = 0; j < chunk.length; j++) {
        translatedSegments.push({
          ...chunk[j],
          translatedText: translationMap[j + 1] || '(번역 없음)',
        });
      }

      const matched = chunk.filter((_, j) => translationMap[j + 1]).length;
      if (matched < chunk.length) {
        console.warn(`[translate chunk ${i}] 번호 매칭: ${matched}/${chunk.length}개 성공`);
      }
    }

    res.json({ translatedSegments });
  } catch (err) {
    console.error('[translate]', err.message);
    res.status(500).json({ error: '번역 중 오류가 발생했습니다.' });
  }
});

export default router;
