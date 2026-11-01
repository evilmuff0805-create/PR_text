// Shared with the editor. Evidence changes an exported cue start, never its row.
export const MAX_LOCAL_START_CUES = 10_000;
const MAX_TEXT = 10_000;
const finiteTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const statuses = new Set(['automatic', 'restored', 'unavailable']);
const methods = new Set(['native_wav', 'mp3_f64']);
const token = /^[a-z][a-z0-9_-]{0,95}$/;
const line = value => value.replace(/\s+/gu, ' ').trim();

export function normalizeLocalStartEvidence(value) {
  if (!value || value.version !== 1 || !statuses.has(value.status)) return undefined;
  const binding = value.binding;
  if (!binding || typeof binding.text !== 'string' || !binding.text.trim() || binding.text.length > MAX_TEXT
    || !finiteTime(binding.start) || !finiteTime(binding.end) || binding.end <= binding.start
    || !Array.isArray(value.cues) || value.cues.length > Math.min(MAX_LOCAL_START_CUES, binding.text.length)) return undefined;
  const verified = value.status !== 'unavailable';
  if (verified && (!value.cues.length || !Number.isSafeInteger(value.sampleRate) || value.sampleRate < 1 || value.sampleRate > 384_000
    || !Number.isSafeInteger(value.channels) || value.channels < 1 || value.channels > 64 || !methods.has(value.method))) return undefined;
  if (!verified && (value.cues.length || typeof value.reason !== 'string' || !token.test(value.reason))) return undefined;
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !token.test(value.reason))) return undefined;
  const cues = [];
  let previousEnd = binding.start;
  for (const cue of value.cues) {
    if (!Array.isArray(cue) || cue.length !== 4 || !finiteTime(cue[0]) || !finiteTime(cue[1]) || !finiteTime(cue[3])
      || cue[0] < previousEnd || cue[1] > binding.end || cue[0] >= cue[3] || cue[3] >= cue[1]
      || typeof cue[2] !== 'string' || !cue[2] || cue[2] !== line(cue[2]) || cue[2].length > 28) return undefined;
    cues.push([...cue]);
    previousEnd = cue[1];
  }
  return { version: 1, status: value.status, binding: { text: binding.text, start: binding.start, end: binding.end }, cues,
    ...(verified ? { sampleRate: value.sampleRate, channels: value.channels, method: value.method } : {}),
    ...(value.reason !== undefined ? { reason: value.reason } : {}) };
}

export function getBoundLocalStartEvidence(segment) {
  if (segment?.speaker !== undefined && segment.speaker !== null && segment.speaker !== '') return undefined;
  const evidence = normalizeLocalStartEvidence(segment?.subtitleReview?.localStart);
  return evidence && evidence.binding.text === segment.text && evidence.binding.start === segment.start
    && evidence.binding.end === segment.end ? evidence : undefined;
}

export function getLocalStartCueMinimum(segment, cue) {
  const evidence = getBoundLocalStartEvidence(segment);
  if (evidence?.status !== 'automatic') return undefined;
  const match = evidence.cues.find(value => value[0] === cue?.start && value[1] === cue?.end && value[2] === cue?.text);
  return match?.[3];
}

// Restoration is a choice about this evidence only. Original content stays intact.
export function setLocalStartEvidenceStatus(segment, status) {
  const evidence = getBoundLocalStartEvidence(segment);
  if (!['automatic', 'restored'].includes(status) || !['automatic', 'restored'].includes(evidence?.status)
    || status === evidence.status) return segment;
  return { ...segment, subtitleReview: { ...segment.subtitleReview, localStart: { ...segment.subtitleReview.localStart, status } } };
}
