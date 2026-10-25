const MAX_ISSUES = 16;
const MAX_REVIEW_TEXT = 10_000;
const TOKEN = /^[a-z][a-z0-9_-]{0,95}$/;
const NUMBER_FIELDS = [
  'durationSeconds', 'characters', 'charactersPerSecond', 'originalEnd',
  'clippedEnd', 'trimmedSeconds', 'originalDurationSeconds', 'remainingDurationSeconds',
  'sourceIndex', 'wordCount', 'assignedWordCount', 'excludedWordCount',
  'cueStart', 'cueEnd',
  'chunkIndex', 'sourceStart', 'sourceEnd', 'ownedStart', 'ownedEnd',
];
const SHORT_RESPONSE = /^(?:네|예|아니|아니요|아뇨|응|어|음|그래|그래요|맞아|맞아요|좋아|좋아요)[.!?…]*$/u;
const INTEGER_FIELDS = new Set(['characters', 'sourceIndex', 'chunkIndex', 'wordCount', 'assignedWordCount', 'excludedWordCount']);
const DENSITY_ISSUES = new Set(['short_cue', 'high_reading_speed']);

function hasSpeaker(segment) {
  return segment?.speaker !== undefined && segment.speaker !== null && segment.speaker !== '';
}

function issueValue(value) {
  if (!value || typeof value !== 'object' || typeof value.code !== 'string' || !TOKEN.test(value.code)) return null;
  const issue = { code: value.code };
  for (const key of ['reason', 'stage']) {
    if (typeof value[key] === 'string' && TOKEN.test(value[key])) issue[key] = value[key];
  }
  for (const key of NUMBER_FIELDS) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0
      && (!INTEGER_FIELDS.has(key) || Number.isSafeInteger(value[key]))) issue[key] = value[key];
  }
  if (typeof value.shortResponse === 'boolean') issue.shortResponse = value.shortResponse;
  return issue;
}

/** Bounded, data-only review metadata. Never changes the active text or times. */
export function mergeSubtitleReviews(...reviews) {
  const issues = new Map();
  const fields = {};
  for (const review of reviews) {
    if (!review || review.version !== 1 || !Array.isArray(review.issues)) continue;
    for (const raw of review.issues) {
      const issue = issueValue(raw);
      if (!issue) continue;
      const key = `${issue.code}:${issue.reason ?? ''}:${issue.stage ?? ''}:${issue.sourceIndex ?? ''}:${issue.cueStart ?? ''}`;
      if (issues.has(key)) issues.delete(key);
      issues.set(key, issue);
    }
    for (const key of ['originalText', 'candidateText']) {
      if (typeof review[key] === 'string' && review[key].length <= MAX_REVIEW_TEXT) fields[key] = review[key];
    }
    if (review.textStatus === 'candidate' || review.textStatus === 'confirmed') fields.textStatus = review.textStatus;
    if (review.timingStatus === 'unverified') fields.timingStatus = 'unverified';
  }
  if (issues.size === 0 && Object.keys(fields).length === 0) return undefined;
  const values = [...issues.values()];
  // A compact row can contain thousands of brief cues. Keep why a correction
  // was withheld even when repeated readability signals exceed the metadata cap.
  const decisions = values.filter(issue => !DENSITY_ISSUES.has(issue.code)).slice(0, MAX_ISSUES);
  const room = MAX_ISSUES - decisions.length;
  const density = room > 0 ? values.filter(issue => DENSITY_ISSUES.has(issue.code)).slice(-room) : [];
  return { version: 1, issues: [...decisions, ...density], ...fields };
}

export function withSubtitleReviewIssue(segment, issue, fields = {}) {
  const subtitleReview = mergeSubtitleReviews(segment?.subtitleReview, { version: 1, issues: [issue], ...fields });
  return subtitleReview ? { ...segment, subtitleReview } : { ...segment };
}

export function overlapTrimReview(segment, nextStart, stage = 'export') {
  const originalDurationSeconds = segment.end - segment.start;
  const remainingDurationSeconds = nextStart - segment.start;
  const trimmedSeconds = segment.end - nextStart;
  if (!(originalDurationSeconds > 0 && remainingDurationSeconds > 0 && trimmedSeconds > 1e-9)
    || !(remainingDurationSeconds < .3 - 1e-9 || trimmedSeconds >= .3
      || remainingDurationSeconds / originalDurationSeconds < .5)) return segment;
  return withSubtitleReviewIssue(segment, {
    code: 'overlap_trim', stage, originalEnd: segment.end, clippedEnd: nextStart,
    trimmedSeconds, originalDurationSeconds, remainingDurationSeconds,
  }, { timingStatus: 'unverified' });
}

/** Review signals, not a minimum duration or an audio/phoneme correctness test. */
export function annotateSubtitleReviews(segments, { stage = 'processing' } = {}) {
  if (!Array.isArray(segments)) return [];
  const ordinary = segments.every(segment => !hasSpeaker(segment));
  if (!ordinary) return segments.map(segment => ({ ...segment }));
  const nextStarts = [...new Set(segments.filter(segment => (
    typeof segment.start === 'number' && Number.isFinite(segment.start)
      && typeof segment.end === 'number' && Number.isFinite(segment.end) && segment.end > segment.start
      && typeof segment.text === 'string' && segment.text.trim()
  )).map(segment => segment.start))].sort((left, right) => left - right);
  const nextByStart = new Map(nextStarts.slice(0, -1).map((start, index) => [start, nextStarts[index + 1]]));
  return segments.map(segment => {
    let result = { ...segment };
    const text = typeof segment.text === 'string' ? segment.text.replace(/\s+/gu, ' ').trim() : '';
    const durationSeconds = segment.end - segment.start;
    if (!/[가-힣]/u.test(text) || typeof segment.start !== 'number' || typeof segment.end !== 'number'
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return result;
    const characters = Array.from(text).length;
    if (durationSeconds < .3 - 1e-9) {
      result = withSubtitleReviewIssue(result, {
        code: 'short_cue', stage, durationSeconds, characters, cueStart: segment.start, cueEnd: segment.end,
        shortResponse: SHORT_RESPONSE.test(text),
      }, { timingStatus: 'unverified' });
    }
    const charactersPerSecond = characters / durationSeconds;
    if (charactersPerSecond > 20 + 1e-9) {
      result = withSubtitleReviewIssue(result, {
        code: 'high_reading_speed', stage, durationSeconds, characters, charactersPerSecond,
        cueStart: segment.start, cueEnd: segment.end,
      }, { timingStatus: 'unverified' });
    }
    const nextStart = nextByStart.get(segment.start);
    if (nextStart !== undefined) result = overlapTrimReview(result, nextStart, stage);
    return result;
  });
}
