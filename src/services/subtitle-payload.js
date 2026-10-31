import { MAX_SPEAKERS } from './speakers.js';
import { normalizeLocalExclusion } from './subtitle-review.js';

export const MAX_SUBTITLE_SEGMENTS = 5_000;
export const MAX_SUBTITLE_SEGMENT_TEXT = 10_000;
export const MAX_SUBTITLE_TOTAL_TEXT = 1_000_000;

// Empty recognition is permitted only by the batch export contract. Existing
// single-file downloads continue to require a nonempty segment array.
export function validateSubtitleSegments(segments, { allowEmpty = false } = {}) {
  if (!Array.isArray(segments) || (!allowEmpty && segments.length === 0)) return 'segments가 필요합니다.';
  if (segments.length > MAX_SUBTITLE_SEGMENTS) return '자막 세그먼트 수가 너무 많습니다.';

  let totalTextLength = 0;
  let totalGrammarRestoreLength = 0;
  let totalExclusionBindingLength = 0;
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return '자막 세그먼트 형식이 올바르지 않습니다.';
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) {
      return '자막 시간 정보가 올바르지 않습니다.';
    }
    if (typeof segment.text !== 'string' || segment.text.length > MAX_SUBTITLE_SEGMENT_TEXT) {
      return '자막 텍스트가 너무 길거나 올바르지 않습니다.';
    }
    if (segment.grammarPolish !== undefined) {
      const metadata = segment.grammarPolish;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).some((key) => !['originalText', 'originalTimingSource', 'status'].includes(key))
        || typeof metadata.status !== 'string' || metadata.status.length > 40
        || (metadata.originalText !== undefined && (typeof metadata.originalText !== 'string' || metadata.originalText.length > MAX_SUBTITLE_SEGMENT_TEXT))
        || (metadata.originalTimingSource !== undefined && (typeof metadata.originalTimingSource !== 'string' || metadata.originalTimingSource.length > 32))) {
        return '문장 다듬기 복원 정보가 올바르지 않습니다.';
      }
      totalGrammarRestoreLength += metadata.originalText?.length || 0;
      if (totalGrammarRestoreLength > MAX_SUBTITLE_TOTAL_TEXT) return '문장 다듬기 복원 정보가 너무 큽니다.';
    }
    if (segment.subtitleReview?.localExclusion !== undefined) {
      const exclusion = normalizeLocalExclusion(segment.subtitleReview.localExclusion);
      if (!exclusion) return '자막 제외 정보가 올바르지 않습니다.';
      totalExclusionBindingLength += exclusion.binding.text.length;
      if (totalExclusionBindingLength > MAX_SUBTITLE_TOTAL_TEXT) return '자막 제외 정보가 너무 큽니다.';
    }
    if (segment.speaker !== undefined && (!Number.isInteger(segment.speaker) || segment.speaker < 0 || segment.speaker >= MAX_SPEAKERS)) {
      return '화자 정보가 올바르지 않습니다.';
    }
    totalTextLength += segment.text.length;
    if (totalTextLength > MAX_SUBTITLE_TOTAL_TEXT) return '자막 전체 텍스트가 너무 큽니다.';
  }
  return null;
}
