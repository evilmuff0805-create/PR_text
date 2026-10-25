const ISSUE_CODES = new Set(['short_cue', 'high_reading_speed', 'overlap_trim', 'word_timing_fallback', 'correction_alignment_rejected', 'correction_guard_rejected', 'chunk_boundary_replanned', 'chunk_boundary_unverified', 'audio_recheck_word_timing', 'audio_recheck_inconclusive', 'audio_recheck_failed']);
const NUMBER_FIELDS = ['durationSeconds', 'characters', 'charactersPerSecond', 'cueStart', 'cueEnd', 'originalEnd', 'clippedEnd', 'trimmedSeconds', 'originalDurationSeconds', 'remainingDurationSeconds', 'sourceIndex', 'wordCount', 'assignedWordCount', 'excludedWordCount', 'chunkIndex', 'sourceStart', 'sourceEnd', 'ownedStart', 'ownedEnd'];
const validText = (value) => typeof value === 'string' && value.length <= 10_000;

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
  if (value.timingStatus === 'unverified' || review.textStatus) review.timingStatus = 'unverified';
  return review;
}

// Only the editable text and known review metadata make an edit dirty. Timing stays immutable.
export const subtitleEditSignature = (segments) => JSON.stringify(segments.map((segment) => ({
  text: segment.text ?? '', subtitleReview: normalizeSubtitleReview(segment.subtitleReview, segment.text),
})));

export function getSubtitleReviewIssues(segment) {
  const issues = [...(normalizeSubtitleReview(segment.subtitleReview, segment.text)?.issues || [])];
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
    chunk_boundary_replanned: '전사 조각 경계를 단어 시간으로 다시 나눔', chunk_boundary_unverified: '전사 조각 경계 대조 필요', audio_recheck_word_timing: '같은 전사 모델로 시간 재측정 · 싱크 미확인', audio_recheck_inconclusive: '재측정 결과 불명확', audio_recheck_failed: '부분 오디오 재측정 실패' };
  return labels[issue.code] || '원본 확인이 필요한 구간';
}

export function editSubtitleText(segment, text) {
  if (text === segment.text) return segment;
  const prior = normalizeSubtitleReview(segment.subtitleReview, segment.text);
  const review = { version: 1, issues: prior?.issues || [], ...prior,
    originalText: prior?.originalText ?? segment.text ?? '', timingStatus: 'unverified' };
  if (review.textStatus === 'confirmed') review.textStatus = review.candidateText === undefined ? undefined : 'candidate';
  return { ...segment, text, subtitleReview: review };
}

export function validateSubtitleCandidate(segments, index, candidate) {
  if (!segments[index] || typeof candidate !== 'string' || !candidate.trim()) return '적용할 정정 후보를 입력해 주세요.';
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return '정정 후보는 줄바꿈 없이 한 줄로 입력해 주세요.';
  if (candidate.length > 10_000) return '한 구간의 정정 후보는 10,000자 이내로 입력해 주세요.';
  if (segments.reduce((sum, segment, position) => sum + (position === index ? candidate.length : String(segment.text ?? '').length), 0) > 1_000_000) return '전체 자막은 1,000,000자 이내로 유지해 주세요.';
  return null;
}

export function confirmSubtitleCandidate(segment, candidate) {
  const prior = normalizeSubtitleReview(segment.subtitleReview, segment.text);
  return { ...segment, text: candidate, subtitleReview: { version: 1, issues: prior?.issues || [], ...prior,
    originalText: prior?.originalText ?? segment.text ?? '', candidateText: candidate,
    textStatus: 'confirmed', timingStatus: 'unverified' } };
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
