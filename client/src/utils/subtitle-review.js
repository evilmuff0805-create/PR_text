import { getBoundCorrectionStatus, getBoundFixedCuePlan, normalizeCorrectionBinding, normalizeFixedCuePlan, restoreFixedCuePlan as restoreFixedCuePlanState } from '../../../src/services/fixed-cue-plan.js';
import { getBoundLocalStartEvidence, normalizeLocalStartEvidence, setLocalStartEvidenceStatus } from '../../../src/services/local-start-evidence.js';

export { getBoundCorrectionStatus, getBoundFixedCuePlan, normalizeCorrectionBinding, normalizeFixedCuePlan, getBoundLocalStartEvidence, normalizeLocalStartEvidence, setLocalStartEvidenceStatus };

export function restoreFixedCuePlan(segment) {
  const restored = restoreFixedCuePlanState(segment);
  if (restored === segment || (restored.text === segment.text && restored.start === segment.start && restored.end === segment.end)
    || restored.subtitleReview?.localStart === undefined) return restored;
  const subtitleReview = { ...restored.subtitleReview };
  delete subtitleReview.localStart;
  return { ...restored, subtitleReview };
}

const ISSUE_CODES = new Set(['short_cue', 'high_reading_speed', 'overlap_trim', 'word_timing_fallback', 'correction_alignment_rejected', 'correction_guard_rejected', 'chunk_boundary_replanned', 'chunk_boundary_unverified', 'audio_recheck_word_timing', 'audio_recheck_inconclusive', 'audio_recheck_failed', 'audio_boundary_estimate_updated', 'audio_boundary_candidate', 'audio_boundary_inconclusive', 'cue_window_correction_applied', 'source_boundary_preserved', 'finalization_candidate_held']);
const NUMBER_FIELDS = ['durationSeconds', 'characters', 'charactersPerSecond', 'cueStart', 'cueEnd', 'originalEnd', 'clippedEnd', 'trimmedSeconds', 'originalDurationSeconds', 'remainingDurationSeconds', 'sourceIndex', 'wordCount', 'assignedWordCount', 'excludedWordCount', 'chunkIndex', 'sourceStart', 'sourceEnd', 'ownedStart', 'ownedEnd'];
const validText = (value) => typeof value === 'string' && value.length <= 10_000;

const validRange = (start, end) => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
const validTimingText = (value) => validText(value) && value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

const LOCAL_EXCLUSION_TOKEN = /^[a-z][a-z0-9_-]{0,95}$/;
const LOCAL_EXCLUSION_REASONS = new Set(['distributed_repetition', 'suspicious_silence', 'exact_zero_with_provider_risk', 'user_selection']);
const hasSpeaker = (segment) => segment?.speaker !== undefined && segment.speaker !== null && segment.speaker !== '';

// Keep the snapshot after edits so an old exclusion cannot follow new speech.
export function normalizeLocalExclusion(value) {
  if (!value || value.version !== 1 || !['review', 'automatic', 'user', 'restored'].includes(value.status)
    || !LOCAL_EXCLUSION_REASONS.has(value.reason)
    || !validText(value.binding?.text) || !value.binding.text.trim() || !validRange(value.binding?.start, value.binding?.end)) return undefined;
  const result = { version: 1, status: value.status, reason: value.reason,
    binding: { text: value.binding.text, start: value.binding.start, end: value.binding.end } };
  if (typeof value.groupId === 'string' && LOCAL_EXCLUSION_TOKEN.test(value.groupId)) result.groupId = value.groupId;
  if (Number.isSafeInteger(value.occurrences) && value.occurrences >= 1 && value.occurrences <= 20_000) result.occurrences = value.occurrences;
  if (['exact_zero', 'signal_present', 'unavailable', 'not_checked'].includes(value.audioStatus)) result.audioStatus = value.audioStatus;
  return result;
}

export function getBoundLocalExclusion(segment) {
  if (hasSpeaker(segment)) return undefined;
  const value = normalizeLocalExclusion(segment?.subtitleReview?.localExclusion);
  return value && value.binding.text === segment.text && value.binding.start === segment.start
    && value.binding.end === segment.end ? value : undefined;
}

export function isLocallyExcluded(segment) {
  return ['automatic', 'user'].includes(getBoundLocalExclusion(segment)?.status);
}

export function setSubtitleExclusion(segment, excluded) {
  if (!segment || hasSpeaker(segment) || !validText(segment.text) || !segment.text.trim() || !validRange(segment.start, segment.end)) return segment;
  const prior = normalizeSubtitleReview(segment.subtitleReview, segment.text);
  const previous = normalizeLocalExclusion(prior?.localExclusion);
  if (!excluded && !previous) return segment;
  const binding = { text: segment.text, start: segment.start, end: segment.end };
  const bound = getBoundLocalExclusion(segment);
  const localExclusion = excluded
    ? { version: 1, status: 'user', reason: 'user_selection', binding,
      ...(bound?.groupId ? { groupId: bound.groupId, occurrences: bound.occurrences } : {}),
      audioStatus: bound?.audioStatus || 'not_checked' }
    : { ...previous, status: 'restored' };
  const review = { version: 1, issues: [], ...prior,
    originalText: prior?.originalText ?? previous?.binding.text ?? segment.text,
    originalTiming: prior?.originalTiming ?? (previous ? { start: previous.binding.start, end: previous.binding.end } : { start: segment.start, end: segment.end }),
    localExclusion };
  return { ...segment, subtitleReview: normalizeSubtitleReview(review, segment.text) };
}

function normalizeTimingEvidence(value, confirmed = false) {
  if (!value || !validRange(value.sourceStart, value.sourceEnd) || !validRange(value.start, value.end)
    || !validTimingText(value.matchingText)
    || (confirmed ? value.status !== 'confirmed' : !['consistent_estimate', 'unverified'].includes(value.status))) return undefined;
  const result = { sourceStart: value.sourceStart, sourceEnd: value.sourceEnd, start: value.start, end: value.end,
    matchingText: value.matchingText, status: value.status };
  if (!confirmed) {
    if (Number.isSafeInteger(value.windowCount) && value.windowCount > 0 && value.windowCount <= 3) result.windowCount = value.windowCount;
    for (const key of ['startSpread', 'endSpread']) if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

export function normalizeSubtitleReview(value, currentText) {
  if (!value || value.version !== 1 || !Array.isArray(value.issues)) return undefined;
  const review = { version: 1, issues: value.issues.slice(0, 16).filter((issue) => ISSUE_CODES.has(issue?.code)).map((issue) => {
    const next = { code: issue.code };
    if (typeof issue.reason === 'string' && issue.reason.length <= 100) next.reason = issue.reason;
    for (const key of NUMBER_FIELDS) if (Number.isFinite(issue[key]) && issue[key] >= 0) next[key] = issue[key];
    if (issue.stage === 'processing' || issue.stage === 'export') next.stage = issue.stage;
    if (typeof issue.shortResponse === 'boolean') next.shortResponse = issue.shortResponse;
    return next;
  }) };
  for (const key of ['originalText', 'candidateText']) if (validText(value[key])) review[key] = value[key];
  if (value.textStatus === 'candidate' || value.textStatus === 'confirmed') review.textStatus = value.textStatus;
  if (review.textStatus === 'confirmed' && (typeof review.candidateText !== 'string' || (currentText !== undefined && review.candidateText !== currentText))) {
    review.textStatus = review.candidateText === undefined ? undefined : 'candidate';
  }
  const timingCandidate = normalizeTimingEvidence(value.timingCandidate);
  if (timingCandidate && (currentText === undefined || timingCandidate.matchingText === currentText)) review.timingCandidate = timingCandidate;
  if (validRange(value.originalTiming?.start, value.originalTiming?.end)) review.originalTiming = { start: value.originalTiming.start, end: value.originalTiming.end };
  const timingConfirmation = normalizeTimingEvidence(value.timingConfirmation, true);
  if (timingConfirmation && review.originalTiming && timingConfirmation.sourceStart === review.originalTiming.start
    && timingConfirmation.sourceEnd === review.originalTiming.end
    && (currentText === undefined || timingConfirmation.matchingText === currentText)) review.timingConfirmation = timingConfirmation;
  const localExclusion = normalizeLocalExclusion(value.localExclusion);
  if (localExclusion) review.localExclusion = localExclusion;
  const localStart = normalizeLocalStartEvidence(value.localStart);
  if (localStart) review.localStart = localStart;
  const correctionBinding = normalizeCorrectionBinding(value.correctionBinding);
  if (correctionBinding && ['cue_applied', 'held', 'restored'].includes(value.correctionStatus)) {
    review.correctionBinding = correctionBinding;
    review.correctionStatus = value.correctionStatus;
  }
  if (value.timingStatus === 'unverified' || review.textStatus || review.timingCandidate || review.timingConfirmation || review.originalTiming) review.timingStatus = 'unverified';
  return review;
}

// Explicit time confirmation is an edit even when the text stays unchanged.
export const subtitleEditSignature = (segments) => JSON.stringify(segments.map((segment) => ({
  start: segment.start, end: segment.end, text: segment.text ?? '', timingSource: segment.timingSource === 'manual' ? 'manual' : undefined,
  subtitleReview: normalizeSubtitleReview(segment.subtitleReview, segment.text),
  fixedCuePlan: normalizeFixedCuePlan(segment.fixedCuePlan),
})));

export function getSubtitleCorrectionStatus(segment) {
  if (hasSpeaker(segment) || !normalizeSubtitleReview(segment?.subtitleReview, segment?.text)?.correctionStatus) return undefined;
  const status = getBoundCorrectionStatus(segment);
  if (status === 'held') return status;
  return getBoundFixedCuePlan(segment) ? status : undefined;
}

function reviewBeforeContentChange(segment) {
  const prior = normalizeSubtitleReview(segment.subtitleReview, segment.text);
  if (!prior?.localStart && !prior?.correctionStatus && !prior?.correctionBinding && !prior?.issues.some((issue) => ['cue_window_correction_applied', 'source_boundary_preserved', 'finalization_candidate_held'].includes(issue.code))) return prior;
  const review = { ...prior };
  delete review.localStart;
  review.issues = review.issues.filter((issue) => !['cue_window_correction_applied', 'source_boundary_preserved', 'finalization_candidate_held'].includes(issue.code));
  if (review.correctionStatus === 'held' && review.textStatus !== 'confirmed') {
    delete review.candidateText;
    delete review.textStatus;
  }
  delete review.correctionStatus;
  delete review.correctionBinding;
  return review;
}

function discardFixedEvidence(segment, next) {
  if (segment.fixedCuePlan !== undefined) {
    delete next.fixedCuePlan;
    delete next.sourceWords;
    delete next.wordAlignedCues;
  }
  return next;
}

export function getSubtitleTimingCandidate(segment) {
  const candidate = normalizeSubtitleReview(segment?.subtitleReview, segment?.text)?.timingCandidate;
  return candidate && candidate.sourceStart === segment.start && candidate.sourceEnd === segment.end ? candidate : undefined;
}

export function getSubtitleTimingConfirmation(segment) {
  const confirmation = normalizeSubtitleReview(segment?.subtitleReview, segment?.text)?.timingConfirmation;
  return confirmation && confirmation.start === segment.start && confirmation.end === segment.end ? confirmation : undefined;
}

export function formatSubtitleTimeInput(value, { isStart = false } = {}) {
  if (!Number.isFinite(value) || value < 0) return '';
  const rounded = isStart ? Math.ceil(value * 1000) / 1000 : value;
  return Number.isFinite(rounded) ? rounded.toFixed(3) : '';
}

export function parseSubtitleTimeInput(value) {
  if (typeof value !== 'string') return NaN;
  const input = value.trim();
  if (/^\d+(?:\.\d{1,3})?$/.test(input)) {
    const seconds = Number(input);
    return Number.isFinite(seconds) ? seconds : NaN;
  }
  const parts = input.match(/^(\d{2,}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/);
  if (!parts) return NaN;
  const seconds = Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(`${parts[3]}.${parts[4] || '0'}`);
  return Number.isFinite(seconds) ? seconds : NaN;
}

export function validateSubtitleTiming(segments, index, start, end, { durationSeconds } = {}) {
  const segment = segments[index];
  if (!segment || !validRange(start, end)) return '발화 시작·끝을 밀리초 3자리 이내의 초 또는 HH:MM:SS.mmm로 입력하고, 끝을 시작보다 뒤로 맞춰 주세요.';
  if (Number.isFinite(segment.audioStartFloor) && start < segment.audioStartFloor) return '검증된 오디오 시작 하한보다 앞선 시간을 적용할 수 없습니다.';
  if (Number.isFinite(durationSeconds) && durationSeconds > 0 && end > durationSeconds) return '발화 끝은 연결한 원본 파일의 재생 길이를 넘을 수 없습니다.';
  const previous = segments[index - 1], next = segments[index + 1];
  if ((Number.isFinite(previous?.end) && start < previous.end) || (Number.isFinite(next?.start) && end > next.start)) return '앞뒤 자막의 발화 구간을 침범할 수 없습니다. 이웃 구간 시간을 먼저 확인해 주세요.';
  return null;
}

export function confirmSubtitleTiming(segment, start, end) {
  if (!validRange(start, end) || !validRange(segment?.start, segment?.end)
    || (Number.isFinite(segment.audioStartFloor) && start < segment.audioStartFloor)) return segment;
  const unchangedRange = start === segment.start && end === segment.end;
  const prior = unchangedRange ? normalizeSubtitleReview(segment.subtitleReview, segment.text) : reviewBeforeContentChange(segment);
  const originalTiming = prior?.originalTiming ?? { start: segment.start, end: segment.end };
  const review = { version: 1, issues: prior?.issues || [], ...prior,
    originalTiming,
    timingConfirmation: { sourceStart: originalTiming.start, sourceEnd: originalTiming.end, start, end, matchingText: segment.text, status: 'confirmed' },
    timingStatus: 'unverified' };
  delete review.timingCandidate;
  const next = { ...segment, start, end, timingSource: 'manual', subtitleReview: review };
  // These times describe the old range. Export must use the confirmed range,
  // falling back to text-based internal splitting rather than restoring them.
  delete next.sourceWords;
  delete next.wordAlignedCues;
  if (!unchangedRange) delete next.fixedCuePlan;
  return next;
}

export function getSubtitleReviewIssues(segment) {
  const correctionStatus = getSubtitleCorrectionStatus(segment);
  const fixedPlan = getBoundFixedCuePlan(segment);
  const issues = (normalizeSubtitleReview(segment.subtitleReview, segment.text)?.issues || []).filter((issue) => (
    (issue.code !== 'cue_window_correction_applied' || correctionStatus === 'cue_applied')
    && (issue.code !== 'finalization_candidate_held' || correctionStatus === 'held')
    && (issue.code !== 'source_boundary_preserved' || fixedPlan)
  ));
  const duration = Number.isFinite(segment.start) && Number.isFinite(segment.end) ? segment.end - segment.start : NaN;
  if (!Number.isFinite(duration) || duration <= 0) return issues;
  const characters = Array.from(String(segment.text ?? '').replace(/\s+/g, ' ').trim()).length;
  const add = (issue) => { if (!issues.some(({ code }) => code === issue.code)) issues.push(issue); };
  if (duration < 0.3) add({ code: 'short_cue', durationSeconds: duration, characters });
  if (characters / duration > 20) add({ code: 'high_reading_speed', durationSeconds: duration, characters, charactersPerSecond: characters / duration });
  return issues;
}

export function subtitleReviewIssueLabel(issue) {
  const reasons = { empty: '빈 교정 후보', numeric_change: '숫자·단위 변경 가능성', speech_deletion: '대사 누락 가능성', speech_insertion: '대사 추가 가능성', repetition_change: '반복·추임새 변경 가능성' };
  const labels = { short_cue: '0.3초 미만의 짧은 자막 구간', high_reading_speed: '구간 길이에 비해 글자가 많음', overlap_trim: '겹침 정리로 표시 구간이 줄어듦', word_timing_fallback: '단어 시간 근거가 불완전함', correction_alignment_rejected: '교정 문구와 단어 시간의 대응 미확인', correction_guard_rejected: `자동 교정 보류${reasons[issue.reason] ? ` · ${reasons[issue.reason]}` : ''}`,
    chunk_boundary_replanned: '전사 조각 경계를 단어 시간으로 다시 나눔', chunk_boundary_unverified: '전사 조각 경계 대조 필요', audio_recheck_word_timing: '같은 전사 모델로 시간 재측정 · 싱크 미확인', audio_recheck_inconclusive: '재측정 결과 불명확', audio_recheck_failed: '부분 오디오 재측정 실패',
    audio_boundary_estimate_updated: '모델 시간 추정 반영 · 발화 싱크 미확인', audio_boundary_candidate: '오디오 재측정 시간 후보 · 발화 싱크 미확인', audio_boundary_inconclusive: '오디오 재측정 시간 확인 불가 · 발화 싱크 미확인',
    cue_window_correction_applied: '기존 큐 시간을 유지해 문구 교정 · 단어별 싱크 미확인', source_boundary_preserved: '원전사 말차례 경계를 보존함 · 화자 전환 검증 아님', finalization_candidate_held: '문구 귀속이나 보존 근거가 불충분해 교정 후보 보류' };
  return labels[issue.code] || '원본 확인이 필요한 구간';
}

export function editSubtitleText(segment, text) {
  if (text === segment.text) return segment;
  const prior = reviewBeforeContentChange(segment);
  const review = { version: 1, issues: prior?.issues || [], ...prior,
    originalText: prior?.originalText ?? segment.text ?? '', timingStatus: 'unverified' };
  if (review.textStatus === 'confirmed') review.textStatus = review.candidateText === undefined ? undefined : 'candidate';
  return discardFixedEvidence(segment, { ...segment, text, subtitleReview: normalizeSubtitleReview(review, text) });
}

export function validateSubtitleCandidate(segments, index, candidate) {
  if (!segments[index] || typeof candidate !== 'string' || !candidate.trim()) return '적용할 정정 후보를 입력해 주세요.';
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return '정정 후보는 줄바꿈 없이 한 줄로 입력해 주세요.';
  if (candidate.length > 10_000) return '한 구간의 정정 후보는 10,000자 이내로 입력해 주세요.';
  if (segments.reduce((sum, segment, position) => sum + (position === index ? candidate.length : String(segment.text ?? '').length), 0) > 1_000_000) return '전체 자막은 1,000,000자 이내로 유지해 주세요.';
  return null;
}

export function confirmSubtitleCandidate(segment, candidate) {
  const prior = candidate === segment.text ? normalizeSubtitleReview(segment.subtitleReview, segment.text) : reviewBeforeContentChange(segment);
  const review = { version: 1, issues: prior?.issues || [], ...prior,
    originalText: prior?.originalText ?? segment.text ?? '', candidateText: candidate,
    textStatus: 'confirmed', timingStatus: 'unverified' };
  const next = { ...segment, text: candidate, subtitleReview: normalizeSubtitleReview(review, candidate) };
  return candidate === segment.text ? next : discardFixedEvidence(segment, next);
}

export function normalizeReviewMemory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => validText(entry?.originalText) && entry.originalText.trim()
    && validText(entry.candidateText) && entry.candidateText.trim() && !/[\r\n]/.test(entry.candidateText)
    && validText(entry.beforeText) && validText(entry.afterText)).slice(-50).map(({ originalText, candidateText, beforeText, afterText }) => ({ originalText, candidateText, beforeText, afterText }));
}

export function rememberSubtitleCandidate(memory, segments, index, candidate) {
  const entry = { originalText: segments[index].text, candidateText: candidate,
    beforeText: segments[index - 1]?.text ?? '', afterText: segments[index + 1]?.text ?? '' };
  return normalizeReviewMemory([...memory.filter((item) => item.originalText !== entry.originalText || item.beforeText !== entry.beforeText || item.afterText !== entry.afterText), entry]);
}

export function findRememberedSubtitle(memory, segments, index) {
  return memory.find((item) => item.originalText === segments[index].text
    && item.beforeText === (segments[index - 1]?.text ?? '') && item.afterText === (segments[index + 1]?.text ?? ''));
}
