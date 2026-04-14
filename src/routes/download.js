import { Router } from 'express';
import { generateSRT, generateTXT, generateASS } from '../services/subtitle.js';

const router = Router();

// POST /api/download
router.post('/', (req, res) => {
  try {
    const { segments, format, assOptions } = req.body;

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'segments가 필요합니다.' });
    }

    const supportedFormats = ['srt', 'txt', 'ass'];
    if (!supportedFormats.includes(format)) {
      return res.status(400).json({ error: `지원하지 않는 형식입니다: ${format}` });
    }

    let content;
    if (format === 'srt') {
      content = generateSRT(segments);
    } else if (format === 'txt') {
      content = generateTXT(segments);
    } else if (format === 'ass') {
      content = generateASS(segments, assOptions || {});
    }

    const mimeTypes = { srt: 'application/x-subrip', txt: 'text/plain', ass: 'text/x-ssa' };
    res.setHeader('Content-Type', `${mimeTypes[format]}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="subtitle.${format}"`);
    res.send(content);
  } catch (err) {
    console.error('[download]', err.message);
    res.status(500).json({ error: '다운로드 중 오류가 발생했습니다.' });
  }
});

export default router;
