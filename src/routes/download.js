import { Router } from 'express';
import { generateSRT, generateTXT, generateASS } from '../services/subtitle.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  MAX_SPEAKERS,
  normalizeStoredSpeakerMetadata,
} from '../services/speakers.js';

const router = Router();
const MAX_SEGMENTS = 5_000;
const MAX_SEGMENT_TEXT_LENGTH = 10_000;
const MAX_TOTAL_TEXT_LENGTH = 1_000_000;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const ASS_POSITIONS = new Set(['top', 'middle', 'bottom']);

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 'segments가 필요합니다.';
  if (segments.length > MAX_SEGMENTS) return '자막 세그먼트 수가 너무 많습니다.';

  let totalTextLength = 0;
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return '자막 세그먼트 형식이 올바르지 않습니다.';
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) {
      return '자막 시간 정보가 올바르지 않습니다.';
    }
    if (typeof segment.text !== 'string' || segment.text.length > MAX_SEGMENT_TEXT_LENGTH) {
      return '자막 텍스트가 너무 길거나 올바르지 않습니다.';
    }
    if (segment.speaker !== undefined && (!Number.isInteger(segment.speaker) || segment.speaker < 0 || segment.speaker >= MAX_SPEAKERS)) {
      return '화자 정보가 올바르지 않습니다.';
    }

    totalTextLength += segment.text.length;
    if (totalTextLength > MAX_TOTAL_TEXT_LENGTH) return '자막 전체 텍스트가 너무 큽니다.';
  }

  return null;
}

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

export function validateDownloadPayload({ segments, format, assOptions, speakerColors }) {
  const segmentError = validateSegments(segments);
  if (segmentError) return segmentError;

  const supportedFormats = ['srt', 'txt', 'ass'];
  if (!supportedFormats.includes(format)) return `지원하지 않는 형식입니다: ${format}`;

  const speakerColorError = validateSpeakerColors(speakerColors);
  if (speakerColorError) return speakerColorError;

  return validateAssOptions(assOptions);
}

export function prepareDownloadPayload({ segments, format, assOptions, speakerColors }) {
  const normalized = normalizeStoredSpeakerMetadata(segments, speakerColors);
  if (normalized.error) return { error: normalized.error };

  const payload = {
    segments: normalized.segments,
    format,
    assOptions,
    speakerColors: normalized.speakerColors,
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
    const { segments, format, assOptions, speakerColors } = prepared;

    const colors = speakerColors && Object.keys(speakerColors).length > 0 ? speakerColors : null;

    let content;
    if (format === 'srt') {
      content = generateSRT(segments, colors);
    } else if (format === 'txt') {
      content = generateTXT(segments);
    } else if (format === 'ass') {
      content = generateASS(segments, assOptions || {}, colors);
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
