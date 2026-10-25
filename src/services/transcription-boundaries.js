import { normalizeLanguage } from './language.js';
import { evaluateSpokenTextCorrection } from './postprocess.js';
import { providerSpeechCharacters } from './provider-word-spans.js';
import { withSubtitleReviewIssue } from './subtitle-review.js';

const EPSILON = 1e-9;
const MIN_CONTEXT_DIFFERENCE_SECONDS = .5;
const MAX_BOUNDARY_MOVEMENT_SECONDS = 2;
const MAX_WORDS = 2_000;

export const TRANSCRIPTION_BOUNDARY_LIMITS = Object.freeze({
  maxRequests: 3,
  maxWindowSeconds: 20,
  maxTotalSeconds: 60,
  consistencyToleranceSeconds: .12,
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const hasSpeaker = (value) => value?.speaker !== undefined && value.speaker !== null && value.speaker !== '';
const copyWords = (words) => Array.isArray(words)
  ? words.map((word) => word && typeof word === 'object' ? { ...word } : word) : undefined;
const copySource = (source) => ({ start: source.start, end: source.end,
  ...(Array.isArray(source.sourceWords) ? { sourceWords: copyWords(source.sourceWords) } : {}) });

function readBudget(budget) {
  if (budget === undefined) return { requests: 0, seconds: 0 };
  if (!budget || !Number.isSafeInteger(budget.requests) || budget.requests < 0
    || !finite(budget.seconds) || budget.seconds < 0) return null;
  return { requests: budget.requests, seconds: budget.seconds };
}

function eligibleSource(source) {
  return source && typeof source.text === 'string' && /[가-힣]/u.test(source.text.normalize('NFC'))
    && providerSpeechCharacters(source.text).length >= 5 && source.text.length <= 10_000
    && finite(source.start) && finite(source.end) && source.start >= 0
    // Genuine short replies and the existing compressed-duration path stay separate.
    && source.end - source.start >= .3 - EPSILON && !hasSpeaker(source);
}

function validWords(words, start, end) {
  if (!Array.isArray(words) || !words.length || words.length > MAX_WORDS) return false;
  let previousEnd = start;
  return words.every((word) => {
    if (!word || typeof word.word !== 'string' || !providerSpeechCharacters(word.word)
      || !finite(word.start) || !finite(word.end) || word.start < start || word.end > end
      || word.end <= word.start || word.start < previousEnd || hasSpeaker(word)) return false;
    previousEnd = word.end;
    return true;
  });
}

function sameDialogue(text, words) {
  const measured = words.map((word) => word.word).join(' ');
  return providerSpeechCharacters(text) === providerSpeechCharacters(measured)
    // Character matching alone conflates 3.5 with 35 and drops numeric signs.
    && evaluateSpokenTextCorrection(text, measured).accepted;
}

function reviewSignals(segments) {
  return segments.flatMap((source, index) => {
    if (!eligibleSource(source)) return [];
    const words = source.sourceWords;
    const complete = validWords(words, source.start, source.end) && sameDialogue(source.text, words);
    const first = Array.isArray(words) ? words[0] : null;
    const firstDuration = first && finite(first.start) && finite(first.end) ? first.end - first.start : 0;
    const reasons = [];
    if (Array.isArray(words) && !complete) reasons.push('word_coverage');
    if (firstDuration >= .8 - EPSILON) reasons.push('long_first_word');
    if (!reasons.length) return [];
    return [{ index, reasons, score: reasons.length * 3 + Math.min(Math.max(firstDuration, 0), 2) }];
  });
}

function supported(segments, language) {
  return Array.isArray(segments) && normalizeLanguage(language) === 'ko' && !segments.some(hasSpeaker);
}

function distinctContext(left, right) {
  return Math.abs(left.start - right.start) >= MIN_CONTEXT_DIFFERENCE_SECONDS - EPSILON
    || Math.abs(left.end - right.end) >= MIN_CONTEXT_DIFFERENCE_SECONDS - EPSILON;
}

function withinBudget(windows, budget) {
  const result = [];
  let requests = budget.requests;
  let seconds = budget.seconds;
  for (const window of windows) {
    const duration = window.end - window.start;
    if (requests >= TRANSCRIPTION_BOUNDARY_LIMITS.maxRequests
      || seconds + duration > TRANSCRIPTION_BOUNDARY_LIMITS.maxTotalSeconds + EPSILON) break;
    result.push(window);
    requests += 1;
    seconds += duration;
  }
  // One decode cannot establish agreement. Avoid spending the remaining request on it.
  return result.filter((window) => window.indices.some((index) => result.some((other) => (
    other.indices.includes(index) && distinctContext(window, other)
  ))));
}

/** Plan one bounded group; signals select review priority, never a timing change. */
export function planTranscriptionBoundaryWindows(segments, {
  language, durationSeconds, budget, indices,
} = {}) {
  const used = readBudget(budget);
  if (!supported(segments, language) || !used || !finite(durationSeconds) || durationSeconds <= 0) return [];
  const signals = reviewSignals(segments);
  let selected;
  if (indices !== undefined) {
    if (!Array.isArray(indices)) return [];
    selected = [...new Set(indices)].filter((index) => Number.isInteger(index)
      && eligibleSource(segments[index]) && segments[index].end <= durationSeconds).sort((a, b) => a - b);
  } else {
    const groups = [];
    for (const signal of signals) {
      const previous = groups.at(-1);
      const source = segments[signal.index];
      if (source.end > durationSeconds) continue;
      if (previous && signal.index === previous.indices.at(-1) + 1
        && source.start - segments[previous.indices.at(-1)].end <= 1.5 + EPSILON
        && source.end - segments[previous.indices[0]].start <= 14 + EPSILON) {
        previous.indices.push(signal.index);
        previous.score += signal.score;
      } else groups.push({ indices: [signal.index], score: signal.score });
    }
    groups.sort((a, b) => b.score - a.score || a.indices[0] - b.indices[0]);
    selected = groups[0]?.indices ?? [];
  }
  if (!selected.length) return [];
  const start = Math.min(...selected.map((index) => segments[index].start));
  const end = Math.max(...selected.map((index) => segments[index].end));
  if (end - start > 14 + EPSILON) return [];
  const windows = [[3, 3], [1.5, 4.5]].map(([before, after]) => ({
    start: Math.max(0, start - before),
    end: Math.min(durationSeconds, end + after),
    indices: [...selected],
  })).filter((window) => window.end - window.start <= TRANSCRIPTION_BOUNDARY_LIMITS.maxWindowSeconds + EPSILON);
  return withinBudget(windows, used);
}

function safeWindows(windows, segments, durationSeconds, budget) {
  if (!Array.isArray(windows) || !finite(durationSeconds) || durationSeconds <= 0) return [];
  const selected = [];
  for (const window of windows.slice(0, TRANSCRIPTION_BOUNDARY_LIMITS.maxRequests)) {
    if (!window || !finite(window.start) || !finite(window.end) || window.start < 0
      || window.end > durationSeconds || window.end <= window.start
      || window.end - window.start > TRANSCRIPTION_BOUNDARY_LIMITS.maxWindowSeconds + EPSILON
      || !Array.isArray(window.indices)) continue;
    const indices = [...new Set(window.indices)].filter((index) => Number.isInteger(index)
      && eligibleSource(segments[index]) && segments[index].start >= window.start && segments[index].end <= window.end);
    if (!indices.length || selected.some((other) => other.start === window.start && other.end === window.end)) continue;
    selected.push({ start: window.start, end: window.end, indices });
  }
  return withinBudget(selected, budget);
}

function responseWords(response, window) {
  if (!response || (response.model !== undefined && response.model !== 'whisper-1')
    || (response.language !== undefined && normalizeLanguage(response.language) !== 'ko')
    || hasSpeaker(response) || response.segments?.some?.(hasSpeaker)) return { reason: 'unsupported_response' };
  const words = response.words;
  if (!validWords(words, 0, window.end - window.start)) return { reason: 'invalid_word_timing' };
  if (typeof response.text === 'string' && !sameDialogue(response.text, words)) return { reason: 'incomplete_response_words' };
  return { words: words.map((word) => ({ word: word.word, start: word.start + window.start, end: word.end + window.start })) };
}

function uniqueExactMatch(source, words) {
  const expected = providerSpeechCharacters(source.text);
  const matches = [];
  for (let first = 0; first < words.length; first += 1) {
    let characters = '';
    for (let last = first; last < words.length; last += 1) {
      characters += providerSpeechCharacters(words[last].word);
      if (!expected.startsWith(characters)) break;
      if (characters === expected) {
        const selected = words.slice(first, last + 1);
        if (sameDialogue(source.text, selected)) matches.push({ first, last, sourceWords: selected });
        break;
      }
    }
    if (matches.length > 1) return { reason: 'ambiguous_dialogue' };
  }
  if (!matches.length) return { reason: 'dialogue_mismatch' };
  const match = matches[0];
  const start = match.sourceWords[0].start;
  const end = match.sourceWords.at(-1).end;
  // A new interjection inside the old/new utterance range must not be silently skipped.
  if (words.some((word, index) => (index < match.first || index > match.last)
    && word.start < Math.max(source.end, end) - EPSILON
    && word.end > Math.min(source.start, start) + EPSILON)) return { reason: 'unassigned_speech' };
  return { start, end, sourceWords: copyWords(match.sourceWords) };
}

function candidateDecision(source, index, segments, evidence) {
  const matched = evidence.filter((entry) => entry.outcome === 'matched');
  const inconclusive = evidence.find((entry) => entry.outcome !== 'matched');
  if (!matched.length) return { reason: inconclusive?.reason ?? 'insufficient_contexts' };
  // Select one complete word sequence. Mixing the latest start with another
  // response's end/words would invent a sequence that no recognizer returned.
  const representative = [...matched].sort((a, b) => b.start - a.start || a.window.start - b.window.start)[0];
  const proposal = { start: representative.start, end: representative.end, sourceWords: copyWords(representative.sourceWords) };
  const previous = segments[index - 1];
  const next = segments[index + 1];
  // Agreement cannot turn one unsafe context into acceptable evidence merely
  // because the representative happens to sit on the safe side of a boundary.
  for (const entry of matched) {
    if (Math.abs(entry.start - source.start) > MAX_BOUNDARY_MOVEMENT_SECONDS + EPSILON
      || Math.abs(entry.end - source.end) > MAX_BOUNDARY_MOVEMENT_SECONDS + EPSILON
      || entry.end <= entry.start) return { reason: 'outside_source_range' };
    if ((previous && (!finite(previous.end) || entry.start < previous.end - EPSILON))
      || (next && (!finite(next.start) || entry.end > next.start + EPSILON))) return { reason: 'neighbour_overlap' };
    if (finite(source.audioStartFloor) && entry.start < source.audioStartFloor - EPSILON) return { reason: 'below_audio_start_floor' };
  }
  if (Array.isArray(source.wordAlignedCues)) return { reason: 'compact_source' };
  if (typeof source.subtitleReview?.candidateText === 'string') return { reason: 'existing_text_review' };
  const summary = { representative: 'latest_start_complete_word_sequence' };
  const starts = matched.map((entry) => entry.start);
  const ends = matched.map((entry) => entry.end);
  if (!inconclusive) {
    summary.startSpread = Math.max(...starts) - Math.min(...starts);
    summary.endSpread = Math.max(...ends) - Math.min(...ends);
  }
  // A single exact match can be offered for explicit review, but an unmatched
  // or failed context is never discarded to manufacture automatic agreement.
  if (inconclusive) return { ...summary, suggestion: proposal, reason: inconclusive.reason };
  if (evidence.length < 2 || !evidence.some((entry, position) => evidence.slice(position + 1)
    .some((other) => distinctContext(entry.window, other.window)))) {
    return { ...summary, suggestion: proposal, reason: 'insufficient_contexts' };
  }
  const tolerance = TRANSCRIPTION_BOUNDARY_LIMITS.consistencyToleranceSeconds + EPSILON;
  if (summary.startSpread > tolerance || summary.endSpread > tolerance) {
    return { ...summary, suggestion: proposal, reason: 'inconsistent_boundaries' };
  }
  return { ...summary, proposal, reason: 'window_agreement' };
}

/**
 * Same-recognizer estimates are not phoneme ground truth. By default this only
 * annotates candidates; the caller must explicitly opt into applying agreement.
 * The injected callback must use whisper-1, without dialogue-answer hints.
 * budget is the already consumed SHARED compressed/boundary review allowance.
 */
export async function recheckTranscriptionBoundaries(segments, {
  language, durationSeconds, transcribeRange, signal, budget, indices, reviewWindows,
  applyConsistentEstimates = false,
} = {}) {
  signal?.throwIfAborted();
  const result = Array.isArray(segments) ? segments.map((source) => ({ ...source })) : [];
  const used = readBudget(budget);
  const candidates = [];
  const measurements = [];
  const scope = { coverage: 'selected_group', selectedIndices: [], reviewedIndices: [],
    signalCount: supported(segments, language) ? reviewSignals(segments).length : 0 };
  const finish = () => ({ segments: result, candidates, measurements,
    budget: used ?? { requests: TRANSCRIPTION_BOUNDARY_LIMITS.maxRequests, seconds: TRANSCRIPTION_BOUNDARY_LIMITS.maxTotalSeconds }, scope });
  if (!supported(segments, language)) { scope.coverage = 'none'; scope.reason = 'unsupported_source'; return finish(); }
  if (!used) { scope.reason = 'invalid_budget'; return finish(); }
  const windows = reviewWindows === undefined
    ? planTranscriptionBoundaryWindows(segments, { language, durationSeconds, budget: used, indices })
    : safeWindows(reviewWindows, segments, durationSeconds, used);
  scope.selectedIndices = [...new Set(windows.flatMap((window) => window.indices))].sort((a, b) => a - b);
  if (typeof transcribeRange !== 'function' || !windows.length) {
    scope.reason = typeof transcribeRange !== 'function' ? 'missing_transcriber' : 'no_review_windows';
    return finish();
  }
  const evidenceByIndex = new Map(scope.selectedIndices.map((index) => [index, []]));
  for (const window of windows) {
    signal?.throwIfAborted();
    used.requests += 1;
    used.seconds += window.end - window.start;
    let reviewed;
    try {
      const response = await transcribeRange({ ...window, indices: [...window.indices], model: 'whisper-1' });
      signal?.throwIfAborted();
      reviewed = responseWords(response, window);
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      reviewed = { reason: 'provider_error' };
    }
    measurements.push({ start: window.start, end: window.end, indices: [...window.indices],
      outcome: reviewed.words ? 'measured' : 'failed', ...(reviewed.reason ? { reason: reviewed.reason } : {}) });
    for (const index of window.indices) {
      const matched = reviewed.words ? uniqueExactMatch(segments[index], reviewed.words) : reviewed;
      evidenceByIndex.get(index).push({ window: { start: window.start, end: window.end },
        outcome: matched.sourceWords ? 'matched' : 'unverified', ...matched });
    }
  }
  scope.reviewedIndices = [...scope.selectedIndices];
  for (const index of scope.selectedIndices) {
    const source = segments[index];
    const evidence = evidenceByIndex.get(index);
    const decision = candidateDecision(source, index, segments, evidence);
    const accepted = Boolean(decision.proposal);
    const applied = accepted && applyConsistentEstimates === true;
    const suggested = decision.proposal ?? decision.suggestion;
    const timingCandidate = suggested ? {
      sourceStart: source.start, sourceEnd: source.end, start: suggested.start, end: suggested.end,
      matchingText: source.text, status: accepted ? 'consistent_estimate' : 'unverified', windowCount: evidence.length,
      ...(finite(decision.startSpread) ? { startSpread: decision.startSpread, endSpread: decision.endSpread } : {}),
    } : undefined;
    const candidate = { sourceIndex: index, original: copySource(source), ...decision,
      status: accepted ? 'consistent_estimate' : 'unverified', applied, evidence,
      ...(timingCandidate ? { timingCandidate } : {}) };
    candidates.push(candidate);
    const active = applied ? { ...source, ...decision.proposal } : source;
    // A new inconclusive measurement must not leave an older agreement badge
    // attached to the same row. Other text-review evidence is retained.
    const { timingCandidate: ignoredCandidate, ...priorReview } = active.subtitleReview ?? {};
    const reviewed = active.subtitleReview ? { ...active, subtitleReview: priorReview } : active;
    result[index] = withSubtitleReviewIssue(reviewed, {
      code: applied ? 'audio_boundary_estimate_updated' : accepted ? 'audio_boundary_candidate' : 'audio_boundary_inconclusive',
      reason: decision.reason, sourceIndex: index, sourceStart: source.start, sourceEnd: source.end,
      ...(accepted ? { cueStart: decision.proposal.start, cueEnd: decision.proposal.end } : {}),
    }, { timingStatus: 'unverified', ...(timingCandidate ? { timingCandidate } : {}) });
  }
  return finish();
}
