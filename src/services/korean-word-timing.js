import { splitKoreanSubtitleText } from './korean-subtitle.js';

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const LETTERS_AND_NUMBERS = /[\p{L}\p{N}]/gu;
const GRAPHEMES = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const PAUSE_EPSILON = 1e-9;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Keep source spelling, punctuation, and Unicode representation in the output.
// Normalized characters are used only to match provider tokens to source spans.
function sourceCharacterMap(text) {
  const characters = [];
  const starts = [];
  const ends = [];
  for (const { segment, index } of GRAPHEMES.segment(text)) {
    for (const character of segment.normalize('NFC')) {
      if (!LETTER_OR_NUMBER.test(character)) continue;
      characters.push(character);
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  return { characters, starts, ends };
}

function wordCuts(text, characterMap, wordLengths) {
  const cuts = [0];
  let matchedCharacters = 0;
  for (let index = 0; index < wordLengths.length - 1; index += 1) {
    matchedCharacters += wordLengths[index];
    const left = characterMap.ends[matchedCharacters - 1];
    const right = characterMap.starts[matchedCharacters];
    // A provider boundary inside a Unicode grapheme has no safe text slice.
    if (left > right) return null;
    const gap = text.slice(left, right);
    const space = gap.indexOf(' ');
    // Closing punctuation stays with the preceding word; an opening quote
    // after a space stays with the following word. No punctuation is discarded.
    cuts.push(space === -1 ? right : left + space);
  }
  cuts.push(text.length);
  return cuts;
}

function splitsInternalDot(text, cut) {
  // Exporters trim a cue's decorative trailing period. A timed cut must not
  // expose a decimal/domain/abbreviation's internal dot as that trailing dot.
  return /[A-Za-z0-9]\.[A-Za-z0-9]/u.test(text.slice(Math.max(0, cut - 2), cut + 1))
    || /[A-Za-z0-9]\.[A-Za-z0-9]/u.test(text.slice(Math.max(0, cut - 1), cut + 2));
}

function semanticCuts(text, maxChars, offset) {
  const parts = splitKoreanSubtitleText(text, maxChars);
  const cuts = [];
  let position = 0;
  for (let index = 0; index < parts.length - 1; index += 1) {
    position += parts[index].length;
    cuts.push(offset + position);
    if (text[position] === ' ') position += 1;
  }
  return cuts;
}

function distanceToCut(position, preferredCuts) {
  let low = 0;
  let high = preferredCuts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (preferredCuts[middle] < position) low = middle + 1;
    else high = middle;
  }
  return Math.min(
    low < preferredCuts.length ? Math.abs(position - preferredCuts[low]) : Infinity,
    low > 0 ? Math.abs(position - preferredCuts[low - 1]) : Infinity,
  );
}

function planWordBoundaries(text, cuts, safeCuts, firstWord, afterLastWord, maxChars) {
  const textStart = cuts[firstWord] + (text[cuts[firstWord]] === ' ' ? 1 : 0);
  const groupText = text.slice(textStart, cuts[afterLastWord]);
  if (groupText.length <= maxChars) return [afterLastWord];

  const preferredCuts = semanticCuts(groupText, maxChars, textStart);
  const wordAtCut = new Map();
  for (let index = firstWord + 1; index < afterLastWord; index += 1) {
    if (safeCuts[index]) wordAtCut.set(cuts[index], index);
  }
  // Preserve the existing semantic plan exactly whenever it uses timed edges.
  if (preferredCuts.every((cut) => wordAtCut.has(cut))) {
    return [...preferredCuts.map((cut) => wordAtCut.get(cut)), afterLastWord];
  }

  // Some API tokens contain several eojeol, while other tokens are subwords.
  // Plan only real token edges, preferring edges near the semantic plan. With
  // the default cap each state visits at most 28 source characters, rather
  // than repeatedly planning every remaining suffix of a long input.
  const plans = new Array(afterLastWord - firstWord + 1);
  plans[afterLastWord - firstWord] = { count: 0, cost: 0 };
  for (let start = afterLastWord - 1; start >= firstWord; start -= 1) {
    const sliceStart = cuts[start] + (text[cuts[start]] === ' ' ? 1 : 0);
    let best = null;
    for (let end = start + 1; end <= afterLastWord; end += 1) {
      const length = cuts[end] - sliceStart;
      if (length > maxChars) break;
      if (!safeCuts[end]) continue;
      const rest = plans[end - firstWord];
      if (!rest) continue;
      const distance = end === afterLastWord ? 0 : distanceToCut(cuts[end], preferredCuts);
      const unused = maxChars - length;
      const candidate = {
        count: rest.count + 1,
        cost: rest.cost + distance * distance + unused * unused / 4,
        next: end,
      };
      if (!best || candidate.count < best.count
        || (candidate.count === best.count && candidate.cost < best.cost)) best = candidate;
    }
    plans[start - firstWord] = best;
  }
  if (!plans[0]) return null;
  const boundaries = [];
  for (let index = firstWord; index < afterLastWord;) {
    index = plans[index - firstWord].next;
    boundaries.push(index);
  }
  return boundaries;
}

/**
 * Align corrected Korean text only when every spoken character matches the
 * provider's complete word sequence. Failure returns the original object.
 * The caller owns speaker policy, cross-source joining, and persistence flags.
 */
export function alignKoreanSegmentWithWordTimings(
  segment,
  { maxChars = 28, maxPauseSeconds = 0.3 } = {},
) {
  const fallback = (reason) => ({ aligned: false, segments: [segment], reason });
  if (!Number.isSafeInteger(maxChars) || maxChars < 1
    || !finiteNumber(maxPauseSeconds) || maxPauseSeconds < 0) return fallback('invalid-options');
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)
    || typeof segment.text !== 'string'
    || !finiteNumber(segment.start) || !finiteNumber(segment.end)
    || segment.start < 0 || segment.end <= segment.start) return fallback('invalid-source');

  const text = segment.text.replace(/\s+/gu, ' ').trim();
  if (!/[가-힣]/u.test(text.normalize('NFC'))) return fallback('not-korean');
  const words = segment.sourceWords;
  if (!Array.isArray(words) || words.length === 0) return fallback('missing-words');

  const characterMap = sourceCharacterMap(text);
  const wordCharacters = [];
  const wordLengths = [];
  let characterCount = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word || typeof word !== 'object' || Array.isArray(word)
      || typeof word.word !== 'string'
      || !finiteNumber(word.start) || !finiteNumber(word.end)
      || word.end <= word.start || word.start < segment.start || word.end > segment.end
      || (index > 0 && word.start < words[index - 1].end)) return fallback('invalid-word-timing');
    const characters = word.word.normalize('NFC').match(LETTERS_AND_NUMBERS) ?? [];
    // Punctuation-only tokens do not identify a spoken span unambiguously.
    if (characters.length === 0) return fallback('unmapped-word');
    characterCount += characters.length;
    if (characterCount > characterMap.characters.length) return fallback('text-mismatch');
    wordCharacters.push(characters.join(''));
    wordLengths.push(characters.length);
  }
  if (characterMap.characters.join('') !== wordCharacters.join('')) return fallback('text-mismatch');

  const cuts = wordCuts(text, characterMap, wordLengths);
  if (!cuts) return fallback('unmapped-word-boundary');
  const safeCuts = cuts.map((cut) => !splitsInternalDot(text, cut));
  const segments = [];
  let groupStart = 0;
  for (let groupEnd = 1; groupEnd <= words.length; groupEnd += 1) {
    if (groupEnd < words.length
      && words[groupEnd].start - words[groupEnd - 1].end <= maxPauseSeconds + PAUSE_EPSILON) continue;
    if (!safeCuts[groupEnd]) return fallback('unsafe-internal-dot-boundary');
    const boundaries = planWordBoundaries(text, cuts, safeCuts, groupStart, groupEnd, maxChars);
    if (!boundaries) return fallback('no-safe-boundary');
    let firstWord = groupStart;
    for (const afterLastWord of boundaries) {
      segments.push({
        start: words[firstWord].start,
        end: words[afterLastWord - 1].end,
        text: text.slice(cuts[firstWord], cuts[afterLastWord]).trim(),
      });
      firstWord = afterLastWord;
    }
    groupStart = groupEnd;
  }
  return { aligned: true, segments };
}
