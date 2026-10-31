import { Router } from 'express';
import { generateSRT, generateTXT, generateASS } from '../services/subtitle.js';
import { isLocallyExcluded } from '../services/subtitle-review.js';
import { authMiddleware } from '../middleware/auth.js';
import { validateSubtitleSegments } from '../services/subtitle-payload.js';
import {
  MAX_SPEAKERS,
  normalizeStoredSpeakerMetadata,
} from '../services/speakers.js';

const router = Router();
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const ASS_POSITIONS = new Set(['top', 'middle', 'bottom']);

function validateSpeakerColors(speakerColors) {
  if (speakerColors === undefined || speakerColors === null) return null;
  if (typeof speakerColors !== 'object' || Array.isArray(speakerColors)) return '화자 색상 형식이 올바르지 않습니다.';

  const entries = Object.entries(speakerColors);
  if (entries.length > MAX_SPEAKERS) return '화자 색상 수가 너무 많습니다.';
  if (entries.some(([speaker, color]) => !/^\d+$/.test(speaker) || !HEX_COLOR.test(color))) {
    return '화자 색상 값이 올바르지 않습니다.';
  }

  return null;
}

function validateAssOptions(assOptions) {
  if (assOptions === undefined || assOptions === null) return null;
  if (typeof assOptions !== 'object' || Array.isArray(assOptions)) return 'ASS 설정 형식이 올바르지 않습니다.';

  const { position, fontFamily, fontColor, fontSize } = assOptions;
  if (position !== undefined && !ASS_POSITIONS.has(position)) return 'ASS 자막 위치가 올바르지 않습니다.';
  if (fontFamily !== undefined && (typeof fontFamily !== 'string' || fontFamily.length > 100 || /[\r\n,]/.test(fontFamily))) {
    return 'ASS 폰트명이 올바르지 않습니다.';
  }
  if (fontColor !== undefined && (typeof fontColor !== 'string' || !HEX_COLOR.test(fontColor))) return 'ASS 글자 색상이 올바르지 않습니다.';
  // 1920x1080 좌표계 기준이라 상한이 120이면 큰 자막을 만들 수 없다.
  if (fontSize !== undefined && (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 200)) return 'ASS 글자 크기가 올바르지 않습니다.';

  return null;
}

export function validateDownloadPayload({ segments, format, assOptions, speakerColors, holdShortGaps }) {
  const segmentError = validateSubtitleSegments(segments, { allowEmpty: format === 'srt' });
  if (segmentError) return segmentError;

  const supportedFormats = ['srt', 'txt', 'ass'];
  if (!supportedFormats.includes(format)) return `지원하지 않는 형식입니다: ${format}`;

  if (holdShortGaps !== undefined && typeof holdShortGaps !== 'boolean') {
    return '자막 간격 설정은 참 또는 거짓이어야 합니다.';
  }

  const speakerColorError = validateSpeakerColors(speakerColors);
  if (speakerColorError) return speakerColorError;

  return validateAssOptions(assOptions);
}

export function prepareDownloadPayload({ segments, format, assOptions, speakerColors, holdShortGaps }) {
  const normalized = normalizeStoredSpeakerMetadata(segments, speakerColors);
  if (normalized.error) return { error: normalized.error };

  const payload = {
    segments: normalized.segments,
    format,
    assOptions,
    speakerColors: normalized.speakerColors,
    holdShortGaps,
  };
  return {
    ...payload,
    error: validateDownloadPayload(payload),
  };
}

// POST /api/download
router.post('/', authMiddleware, (req, res) => {
  try {
    const prepared = prepareDownloadPayload(req.body);
    if (prepared.error) return res.status(400).json({ error: prepared.error });
    const { segments, format, assOptions, speakerColors, holdShortGaps } = prepared;

    const colors = speakerColors && Object.keys(speakerColors).length > 0 ? speakerColors : null;

    let content;
    if (format === 'srt') {
      content = generateSRT(segments, colors, { holdShortGaps });
      if (!content && !segments.some(isLocallyExcluded)) return res.status(422).json({ error: '인식된 대사가 없어 SRT를 만들 수 없습니다. 원본을 확인해 주세요.' });
    } else if (format === 'txt') {
      content = generateTXT(segments);
    } else if (format === 'ass') {
      content = generateASS(segments, { ...assOptions, holdShortGaps }, colors);
    }
    if (!content) return res.status(422).json({ error: segments.some(isLocallyExcluded)
      ? '제외 후 남은 자막이 없습니다. 제외를 복원해 주세요.'
      : '남은 자막이 없어 파일을 만들 수 없습니다. 원본을 확인해 주세요.' });

    const mimeTypes = { srt: 'application/x-subrip', txt: 'text/plain', ass: 'text/x-ssa' };
    res.setHeader('Content-Type', `${mimeTypes[format]}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="subtitle.${format}"`);
    res.send(content);
  } catch (err) {
    if (err.code === 'LOCAL_EXCLUSION_CONFLICT') {
      return res.status(400).json({ error: err.message, code: err.code, connectedRows: err.connectedRows });
    }
    console.error('[download]', err.message);
    res.status(500).json({ error: '다운로드 중 오류가 발생했습니다.' });
  }
});

export default router;
