const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const GRAPHEMES = new Intl.Segmenter('ko', { granularity: 'grapheme' });
export const providerSpeechCharacters = (text) => String(text ?? '').normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');

function validWord(word) {
  return word && typeof word.word === 'string'
    && typeof word.start === 'number' && Number.isFinite(word.start)
    && typeof word.end === 'number' && Number.isFinite(word.end)
    && word.start >= 0 && word.end > word.start;
}

// A unique, complete text match is required. Time proximity alone must not
// assign a neighbouring utterance to a segment with missing provider words.
export function completeProviderWordSpans(segment, words, { edgeTolerance = 0.5 } = {}) {
  if (!segment || typeof segment.text !== 'string' || !Number.isFinite(segment.start)
    || !Number.isFinite(segment.end) || segment.end <= segment.start || !Array.isArray(words)) return null;
  const text = segment.text;
  const expected = providerSpeechCharacters(text);
  if (!expected || expected.length > 10_000) return null;
  const candidates = words.filter((word) => validWord(word) && providerSpeechCharacters(word.word)
    && word.start >= segment.start - edgeTolerance && word.end <= segment.end + edgeTolerance);
  const matches = [];
  for (let first = 0; first < candidates.length; first += 1) {
    let value = '';
    let previousEnd = -Infinity;
    for (let last = first; last < candidates.length; last += 1) {
      const word = candidates[last];
      if (word.start < previousEnd - 1e-9) break;
      previousEnd = word.end;
      value += providerSpeechCharacters(word.word);
      if (!expected.startsWith(value)) break;
      if (value === expected) { matches.push(candidates.slice(first, last + 1)); break; }
    }
    if (matches.length > 1) return null;
  }
  if (matches.length !== 1) return null;
  const selected = matches[0];
  const starts = [];
  const ends = [];
  for (const grapheme of GRAPHEMES.segment(text)) {
    for (const char of grapheme.segment.normalize('NFC')) {
      if (!LETTER_OR_NUMBER.test(char)) continue;
      starts.push(grapheme.index);
      ends.push(grapheme.index + grapheme.segment.length);
    }
  }
  const cuts = [0];
  let characters = 0;
  for (const word of selected.slice(0, -1)) {
    characters += Array.from(providerSpeechCharacters(word.word)).length;
    const left = ends[characters - 1];
    const right = starts[characters];
    if (left > right) return null;
    const gap = text.slice(left, right);
    const space = gap.search(/\s/u);
    cuts.push(space === -1 ? right : left + space);
  }
  cuts.push(text.length);
  return { words: selected, cuts };
}
