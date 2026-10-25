import { providerSpeechCharacters } from './provider-word-spans.js';
import { withSubtitleReviewIssue } from './subtitle-review.js';
import { evaluateSpokenTextCorrection } from './postprocess.js';

const MAX_WINDOWS = 3;
const MAX_WINDOW_SECONDS = 20;
const MAX_TOTAL_SECONDS = 60;
const hasSpeaker = (segment) => segment.speaker !== undefined && segment.speaker !== null && segment.speaker !== '';

export function buildTranscriptionReviewWindows(segments, { durationSeconds } = {}) {
  if (!Array.isArray(segments) || segments.some(hasSpeaker)) return [];
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds
    : Math.max(0, ...segments.map((segment) => Number.isFinite(segment.end) ? segment.end : 0));
  const windows = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const length = segment.end - segment.start;
    if (!/[가-힣]/u.test(String(segment.text ?? '')) || !Number.isFinite(segment.start)
      || !Number.isFinite(segment.end) || segment.start < 0 || !(length > 0 && length < .3 - 1e-9)
      || Array.from(providerSpeechCharacters(segment.text)).length < 5) continue;
    const start = Math.max(0, segment.start - 3);
    const end = Math.min(duration, segment.end + 3);
    if (!(end > start)) continue;
    const previous = windows.at(-1);
    if (previous && start <= previous.end && end - previous.start <= MAX_WINDOW_SECONDS) {
      previous.end = Math.max(previous.end, end);
      previous.indices.push(index);
    } else if (windows.length < MAX_WINDOWS) windows.push({ start, end, indices: [index] });
  }
  let total = 0;
  return windows.filter((window) => {
    total += window.end - window.start;
    return window.end - window.start <= MAX_WINDOW_SECONDS && total <= MAX_TOTAL_SECONDS;
  });
}

function uniqueWordMatch(text, words, windowSeconds) {
  const expected = providerSpeechCharacters(text);
  if (!expected || !Array.isArray(words) || words.length > 2_000) return null;
  const matches = [];
  for (let first = 0; first < words.length; first += 1) {
    let characters = '';
    let previousEnd = -Infinity;
    for (let last = first; last < words.length; last += 1) {
      const word = words[last];
      if (!word || typeof word.word !== 'string' || typeof word.start !== 'number' || typeof word.end !== 'number'
        || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0
        || word.end <= word.start || word.end > windowSeconds + 1e-9 || word.start < previousEnd - 1e-9) break;
      const value = providerSpeechCharacters(word.word);
      if (!value) break;
      previousEnd = word.end;
      characters += value;
      if (!expected.startsWith(characters)) break;
      if (characters === expected) { matches.push(words.slice(first, last + 1)); break; }
    }
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0] : null;
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j += 1) next.push(Math.min(next[j] + 1, previous[j + 1] + 1,
      previous[j] + (left[i] === right[j] ? 0 : 1)));
    previous = next;
  }
  return previous.at(-1);
}

// Alternatives are review candidates only. Neither similarity nor agreement
// with a second decode is authorization to rewrite the active dialogue.
export function findAudioReviewCandidate(source, words, window) {
  const original = Array.from(providerSpeechCharacters(source.text));
  if (original.length < 5 || original.length > 80 || !Array.isArray(words) || words.length > 2_000) return null;
  const candidates = [];
  for (let first = 0; first < words.length; first += 1) {
    let previousEnd = -Infinity;
    for (let last = first; last < Math.min(words.length, first + 12); last += 1) {
      const selected = words.slice(first, last + 1);
      const word = words[last];
      if (!word || typeof word.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < 0 || word.end <= word.start || word.start < previousEnd - 1e-9
        || word.end > window.end - window.start + 1e-9) break;
      previousEnd = word.end;
      const text = selected.map((value) => value.word.trim()).join(' ');
      const characters = Array.from(providerSpeechCharacters(text));
      if (characters.length > original.length * 1.5) break;
      if (characters.length < original.length * .5 || !characters.length) continue;
      const start = selected[0].start + window.start;
      const end = selected.at(-1).end + window.start;
      if (start < source.start - 2 || start > source.end + 2 || end < source.start - 2 || end > source.end + 2) continue;
      const distance = editDistance(original, characters);
      if (!distance || distance > Math.floor(Math.max(original.length, characters.length) * .5)) continue;
      if (!evaluateSpokenTextCorrection(source.text, text).accepted) continue;
      candidates.push({ text, distance, start, end });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  if (!candidates.length || (candidates[1] && candidates[1].distance === candidates[0].distance)) return null;
  return candidates[0];
}

function safeReviewWindows(windows, segments, durationSeconds) {
  if (!Array.isArray(windows) || segments.some(hasSpeaker)) return [];
  const selected = [];
  let total = 0;
  for (const window of windows.slice(0, MAX_WINDOWS)) {
    if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start < 0
      || window.end <= window.start || window.end - window.start > MAX_WINDOW_SECONDS
      || (Number.isFinite(durationSeconds) && window.end > durationSeconds) || !Array.isArray(window.indices)) continue;
    const indices = [...new Set(window.indices)].filter((index) => Number.isInteger(index) && index >= 0 && index < segments.length
      && /[가-힣]/u.test(String(segments[index].text ?? ''))
      && !hasSpeaker(segments[index]) && segments[index].start >= window.start && segments[index].end <= window.end);
    if (!indices.length || total + window.end - window.start > MAX_TOTAL_SECONDS) continue;
    selected.push({ start: window.start, end: window.end, indices });
    total += window.end - window.start;
  }
  return selected;
}

// Bounded second measurement with the SAME recognizer. A disagreement never
// replaces dialogue. Even an accepted estimate is not human-verified timing.
export async function recheckCompressedTranscriptionSegments(segments, {
  durationSeconds, transcribeRange, signal, reviewWindows,
} = {}) {
  const windows = reviewWindows === undefined ? buildTranscriptionReviewWindows(segments, { durationSeconds })
    : safeReviewWindows(reviewWindows, segments, durationSeconds);
  let result = segments.map((segment) => ({ ...segment }));
  const measurements = [];
  if (typeof transcribeRange !== 'function') return { segments: result, measurements };
  for (const window of windows) {
    signal?.throwIfAborted();
    let response;
    try { response = await transcribeRange(window); }
    catch (error) {
      signal?.throwIfAborted();
      for (const index of window.indices) result[index] = withSubtitleReviewIssue(result[index], {
        code: 'audio_recheck_failed', reason: 'provider_error', sourceIndex: index,
      }, { timingStatus: 'unverified' });
      measurements.push({ start: window.start, end: window.end, count: window.indices.length, outcome: 'failed' });
      continue;
    }
    for (const index of window.indices) {
      const source = result[index];
      const matched = uniqueWordMatch(source.text, response?.words, window.end - window.start);
      const words = matched?.map((word) => ({ ...word, start: word.start + window.start, end: word.end + window.start }));
      const start = words?.[0]?.start;
      const end = words?.at(-1)?.end;
      const previousEnd = index > 0 ? result[index - 1].end : 0;
      const nextStart = index + 1 < result.length ? result[index + 1].start : durationSeconds ?? Infinity;
      const accepted = words && start >= previousEnd - 1e-9 && end <= nextStart + 1e-9
        && end - start > source.end - source.start + 1e-9;
      const candidate = !matched ? findAudioReviewCandidate(source, response?.words, window) : null;
      result[index] = withSubtitleReviewIssue(accepted ? { ...source, start, end, sourceWords: words } : source, {
        code: accepted ? 'audio_recheck_word_timing' : 'audio_recheck_inconclusive', sourceIndex: index,
        originalDurationSeconds: source.end - source.start,
      }, { timingStatus: 'unverified', ...(candidate ? { originalText: source.text, candidateText: candidate.text, textStatus: 'candidate' } : {}) });
      measurements.push({ start: window.start, end: window.end, sourceIndex: index, outcome: accepted ? 'word_estimate_updated' : 'unverified' });
    }
  }
  return { segments: result, measurements };
}

// Whisper's prompt limit is 224 tokens. A <=192 UTF-8-byte term list also
// bounds byte-level token count without adding a tokenizer dependency.
export function buildTranscriptionVocabularyPrompt(terms) {
  if (!Array.isArray(terms)) return undefined;
  const selected = [];
  for (const term of terms.slice(0, 10)) {
    if (typeof term !== 'string') continue;
    const clean = term.replace(/[\r\n\t]/g, ' ').trim();
    if (!clean || Array.from(clean).length > 16) continue;
    const next = [...selected, clean].join(', ');
    if (Buffer.byteLength(next, 'utf8') <= 192) selected.push(clean);
  }
  return selected.length ? selected.join(', ') : undefined;
}
