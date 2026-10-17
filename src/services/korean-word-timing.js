import { splitKoreanSubtitleText } from './korean-subtitle.js';

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const LETTERS_AND_NUMBERS = /[\p{L}\p{N}]/gu;
const GRAPHEMES = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const PAUSE_EPSILON = 1e-9;
const MAX_CORRECTION_EDITS = 64;
const MAX_CORRECTION_CHARACTERS = 10_000;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function audioStartFloor(segment) {
  const floor = segment?.audioStartFloor;
  return finiteNumber(floor) && floor >= 0 && finiteNumber(segment?.start)
    && finiteNumber(segment?.end) && segment.end > segment.start && floor < segment.end
    && (segment.speaker === undefined || segment.speaker === null || segment.speaker === '')
    && typeof segment.text === 'string' && /[가-힣]/u.test(segment.text.normalize('NFC')) ? floor : null;
}

function sourceWithAudioFloor(segment) {
  const floor = audioStartFloor(segment);
  return floor !== null && floor > segment.start
    ? { ...segment, start: floor, timingSource: 'audio-range' } : segment;
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

function alignValidatedText(segment, text, words, wordLengths, maxChars, maxPauseSeconds, characterMap = sourceCharacterMap(text)) {
  const fallback = (reason) => ({ aligned: false, segments: [sourceWithAudioFloor(segment)], reason });
  const cuts = wordCuts(text, characterMap, wordLengths);
  if (!cuts) return fallback('unmapped-word-boundary');
  const safeCuts = cuts.map((cut) => !splitsInternalDot(text, cut));
  const floor = audioStartFloor(segment) ?? 0;
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
      const start = Math.max(words[firstWord].start, floor);
      const end = words[afterLastWord - 1].end;
      // A cue entirely before verified audio cannot receive an invented end or
      // be deleted. Keep the complete text in the bounded source fallback.
      if (end <= start) return fallback('audio-floor-outside-word-range');
      segments.push({
        start,
        end,
        text: text.slice(cuts[firstWord], cuts[afterLastWord]).trim(),
      });
      firstWord = afterLastWord;
    }
    groupStart = groupEnd;
  }
  return { aligned: true, segments };
}

// A bounded edit alignment identifies word edges; character counts alone do
// not pair different words. Only local Hangul spelling edits may differ.
function correctedWordLengths(sourceCharacters, candidateCharacters, wordLengths) {
  const sourceLength = sourceCharacters.length;
  const candidateLength = candidateCharacters.length;
  if (Math.max(sourceLength, candidateLength) > MAX_CORRECTION_CHARACTERS) return null;
  const budget = Math.min(MAX_CORRECTION_EDITS, Math.max(2, Math.floor(Math.max(sourceLength, candidateLength) / 4)));
  if (Math.abs(sourceLength - candidateLength) > budget) return null;
  const width = budget * 2 + 1;
  const infinity = budget + 1;
  const forward = new Uint8Array((sourceLength + 1) * width).fill(infinity);
  const backward = new Uint8Array((sourceLength + 1) * width).fill(infinity);
  const parts = (character) => /^[가-힣]$/u.test(character) ? character.normalize('NFD') : null;
  const sourceParts = sourceCharacters.map(parts);
  const candidateParts = candidateCharacters.map(parts);
  const substitutionCost = (sourceIndex, candidateIndex) => {
    if (sourceCharacters[sourceIndex] === candidateCharacters[candidateIndex]) return 0;
    const left = sourceParts[sourceIndex];
    const right = candidateParts[candidateIndex];
    if (!left || !right) return infinity;
    const shared = Number(left[0] === right[0]) + Number(left[1] === right[1])
      + Number((left[2] ?? '') === (right[2] ?? ''));
    return shared >= 2 ? 1 : infinity;
  };
  const get = (table, sourceIndex, candidateIndex) => {
    const diagonal = candidateIndex - sourceIndex + budget;
    if (sourceIndex < 0 || sourceIndex > sourceLength || candidateIndex < 0 || candidateIndex > candidateLength
      || diagonal < 0 || diagonal >= width) return infinity;
    return table[sourceIndex * width + diagonal];
  };
  for (let sourceIndex = 0; sourceIndex <= sourceLength; sourceIndex += 1) {
    for (let candidateIndex = Math.max(0, sourceIndex - budget); candidateIndex <= Math.min(candidateLength, sourceIndex + budget); candidateIndex += 1) {
      const cost = sourceIndex === 0 && candidateIndex === 0 ? 0 : Math.min(
        sourceIndex > 0 && sourceParts[sourceIndex - 1] ? get(forward, sourceIndex - 1, candidateIndex) + 1 : infinity,
        candidateIndex > 0 && candidateParts[candidateIndex - 1] ? get(forward, sourceIndex, candidateIndex - 1) + 1 : infinity,
        sourceIndex > 0 && candidateIndex > 0
          ? get(forward, sourceIndex - 1, candidateIndex - 1) + substitutionCost(sourceIndex - 1, candidateIndex - 1) : infinity,
      );
      forward[sourceIndex * width + candidateIndex - sourceIndex + budget] = Math.min(cost, infinity);
    }
  }
  const distance = get(forward, sourceLength, candidateLength);
  if (distance > budget) return null;
  for (let sourceIndex = sourceLength; sourceIndex >= 0; sourceIndex -= 1) {
    for (let candidateIndex = Math.min(candidateLength, sourceIndex + budget); candidateIndex >= Math.max(0, sourceIndex - budget); candidateIndex -= 1) {
      const cost = sourceIndex === sourceLength && candidateIndex === candidateLength ? 0 : Math.min(
        sourceIndex < sourceLength && sourceParts[sourceIndex] ? get(backward, sourceIndex + 1, candidateIndex) + 1 : infinity,
        candidateIndex < candidateLength && candidateParts[candidateIndex] ? get(backward, sourceIndex, candidateIndex + 1) + 1 : infinity,
        sourceIndex < sourceLength && candidateIndex < candidateLength
          ? get(backward, sourceIndex + 1, candidateIndex + 1) + substitutionCost(sourceIndex, candidateIndex) : infinity,
      );
      backward[sourceIndex * width + candidateIndex - sourceIndex + budget] = Math.min(cost, infinity);
    }
  }
  const sourceEdges = [0];
  for (const length of wordLengths) sourceEdges.push(sourceEdges.at(-1) + length);
  const candidateEdges = [];
  for (const sourceIndex of sourceEdges) {
    let edge = null;
    for (let candidateIndex = Math.max(0, sourceIndex - budget); candidateIndex <= Math.min(candidateLength, sourceIndex + budget); candidateIndex += 1) {
      if (get(forward, sourceIndex, candidateIndex) + get(backward, sourceIndex, candidateIndex) !== distance) continue;
      if (edge !== null) return null;
      edge = candidateIndex;
    }
    if (edge === null || (candidateEdges.length > 0 && edge <= candidateEdges.at(-1))) return null;
    candidateEdges.push(edge);
  }
  if (candidateEdges[0] !== 0 || candidateEdges.at(-1) !== candidateLength) return null;
  // Opposing delete/insert operations must not bypass local spelling checks.
  // Each already mapped token may contract OR expand, with local substitutions;
  // this rejects questionable text without deriving any new word timestamps.
  let validatedCost = 0;
  for (let index = 0; index < wordLengths.length; index += 1) {
    const sourceSize = wordLengths[index];
    const candidateSize = candidateEdges[index + 1] - candidateEdges[index];
    const difference = Math.abs(sourceSize - candidateSize);
    if (difference > budget) return null;
    if (difference === 0) {
      for (let offset = 0; offset < sourceSize; offset += 1) {
        validatedCost += substitutionCost(sourceEdges[index] + offset, candidateEdges[index] + offset);
        if (validatedCost > budget) return null;
      }
      continue;
    }
    const sourceLonger = sourceSize > candidateSize;
    const smallerSize = Math.min(sourceSize, candidateSize);
    let previous = new Uint8Array(difference + 1).fill(infinity);
    for (let matched = 0; matched <= smallerSize; matched += 1) {
      const current = new Uint8Array(difference + 1).fill(infinity);
      for (let extra = 0; extra <= difference; extra += 1) {
        if (matched === 0 && extra === 0) {
          current[extra] = 0;
          continue;
        }
        const sourceIndex = sourceEdges[index] + (sourceLonger ? matched + extra : matched) - 1;
        const candidateIndex = candidateEdges[index] + (sourceLonger ? matched : matched + extra) - 1;
        const matchCost = matched > 0
          ? previous[extra] + substitutionCost(sourceIndex, candidateIndex) : infinity;
        const longerIsHangul = sourceLonger ? sourceParts[sourceIndex] : candidateParts[candidateIndex];
        const extraCost = extra > 0 && longerIsHangul ? current[extra - 1] + 1 : infinity;
        current[extra] = Math.min(matchCost, extraCost, infinity);
      }
      previous = current;
    }
    validatedCost += previous[difference];
    if (validatedCost > budget) return null;
  }
  return wordLengths.map((_, index) => candidateEdges[index + 1] - candidateEdges[index]);
}

/**
 * Align corrected Korean text only when every spoken character matches the
 * provider's complete word sequence. Failure retains the source, except for a
 * separately verified digital-prefix bound on its start.
 * The caller owns speaker policy, cross-source joining, and persistence flags.
 */
export function alignKoreanSegmentWithWordTimings(
  segment,
  { maxChars = 28, maxPauseSeconds = 0.3 } = {},
) {
  const fallback = (reason) => ({ aligned: false, segments: [sourceWithAudioFloor(segment)], reason });
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

  return alignValidatedText(segment, text, words, wordLengths, maxChars, maxPauseSeconds, characterMap);
}

/**
 * Preserve validated pre-correction word times through unambiguous spelling
 * edits. Ambiguous edits restore the original timed cues, not padded sources.
 * Provider words and their timestamps are never rewritten to fit new text.
 */
export function alignCorrectedKoreanSegmentWithWordTimings(original, corrected, options = {}) {
  const prior = alignKoreanSegmentWithWordTimings(original, options);
  let candidate = corrected;
  if (candidate && typeof candidate === 'object' && candidate.audioStartFloor !== original?.audioStartFloor) {
    candidate = { ...candidate };
    if (Object.hasOwn(original ?? {}, 'audioStartFloor')) candidate.audioStartFloor = original.audioStartFloor;
    else delete candidate.audioStartFloor;
  }
  if (!prior.aligned) return { aligned: false, segments: [sourceWithAudioFloor(candidate)], reason: prior.reason };
  const originalText = original.text.replace(/\s+/gu, ' ').trim();
  const preserve = (reason) => ({ ...prior, text: originalText, correctionRetained: false, reason });
  if (!corrected || typeof corrected.text !== 'string'
    || corrected.start !== original.start || corrected.end !== original.end) return preserve('invalid-corrected-source');
  const text = corrected.text.replace(/\s+/gu, ' ').trim();
  if (!text) return preserve('empty-correction');
  const sourceCharacters = sourceCharacterMap(originalText).characters;
  const characterMap = sourceCharacterMap(text);
  const originalLengths = original.sourceWords.map((word) => (word.word.normalize('NFC').match(LETTERS_AND_NUMBERS) ?? []).length);
  const lengths = sourceCharacters.join('') === characterMap.characters.join('')
    ? originalLengths : correctedWordLengths(sourceCharacters, characterMap.characters, originalLengths);
  if (!lengths) return preserve('ambiguous-correction-boundary');
  const { maxChars = 28, maxPauseSeconds = 0.3 } = options;
  const aligned = alignValidatedText(candidate, text, original.sourceWords, lengths, maxChars, maxPauseSeconds, characterMap);
  return aligned.aligned ? { ...aligned, text, correctionRetained: true } : preserve(aligned.reason);
}
