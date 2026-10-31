// Shared with the editor. This module intentionally has no runtime imports.
export const MAX_FIXED_CUE_PLAN_CUES = 10_000;
const MAX_TEXT = 10_000;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const line = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

export function normalizeCorrectionBinding(value) {
  return value && typeof value.text === 'string' && value.text.trim() && value.text.length <= MAX_TEXT
    && finite(value.start) && finite(value.end) && value.end > value.start
    ? { text: value.text, start: value.start, end: value.end } : undefined;
}

function normalizePart(value) {
  const binding = normalizeCorrectionBinding(value);
  if (!binding || !Array.isArray(value.cues) || !value.cues.length
    || value.cues.length > Math.min(MAX_FIXED_CUE_PLAN_CUES, binding.text.length)) return undefined;
  let previousEnd = binding.start;
  const cues = [];
  for (const cue of value.cues) {
    if (!Array.isArray(cue) || cue.length !== 3 || !finite(cue[0]) || !finite(cue[1])
      || cue[1] <= cue[0] || cue[0] < previousEnd || cue[1] > binding.end
      || typeof cue[2] !== 'string' || !cue[2].trim() || cue[2] !== line(cue[2]) || cue[2].length > 28) return undefined;
    cues.push([cue[0], cue[1], cue[2]]);
    previousEnd = cue[1];
  }
  if (cues[0][0] !== binding.start || cues.at(-1)[1] !== binding.end
    || line(cues.map(cue => cue[2]).join(' ')) !== line(binding.text)) return undefined;
  return { ...binding, cues };
}

export function normalizeFixedCuePlan(value) {
  if (!value || value.version !== 1) return undefined;
  const part = normalizePart({ ...value.binding, cues: value.cues });
  if (!part) return undefined;
  const { cues, ...binding } = part;
  const original = value.original === undefined ? undefined : normalizePart(value.original);
  if (value.original !== undefined && !original) return undefined;
  if (original && (original.start !== binding.start || original.end !== binding.end || original.cues.length !== cues.length
    || original.cues.some((cue, index) => cue[0] !== cues[index][0] || cue[1] !== cues[index][1]))) return undefined;
  return { version: 1, binding, cues, ...(original ? { original } : {}) };
}

export function getBoundFixedCuePlan(segment) {
  if (segment?.speaker !== undefined && segment.speaker !== null && segment.speaker !== '') return undefined;
  const value = normalizeFixedCuePlan(segment?.fixedCuePlan);
  return value && value.binding.text === segment.text && value.binding.start === segment.start
    && value.binding.end === segment.end ? value : undefined;
}

export function getBoundCorrectionStatus(segment) {
  if (segment?.speaker !== undefined && segment.speaker !== null && segment.speaker !== '') return undefined;
  const review = segment?.subtitleReview;
  const binding = normalizeCorrectionBinding(review?.correctionBinding);
  return binding && binding.text === segment.text && binding.start === segment.start && binding.end === segment.end
    && ['cue_applied', 'held', 'restored'].includes(review?.correctionStatus) ? review.correctionStatus : undefined;
}

export function restoreFixedCuePlan(segment) {
  const plan = getBoundFixedCuePlan(segment);
  if (!plan?.original) return segment;
  const { sourceWords, wordAlignedCues, ...restored } = segment;
  const { cues, ...binding } = plan.original;
  return { ...restored, ...binding, timingSource: 'speech_window',
    fixedCuePlan: { version: 1, binding, cues, original: plan.original },
    subtitleReview: { version: 1, issues: [], ...segment.subtitleReview,
      correctionStatus: 'restored', correctionBinding: binding } };
}
