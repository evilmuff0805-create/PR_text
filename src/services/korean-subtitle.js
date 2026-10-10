const DEFAULT_MAX_CHARS = 28;

// These are conservative word-boundary rules, not a morphological parser.
// A boundary may still be necessary when the complete phrase exceeds the cap.
const QUOTED_END = /(?:라고|다고|냐고|자고)$/;
const CLAUSE_END = /(?:지만|는데|던데|더니|으니까|니까|므로|거나|든지|다면|으면|으며|면서|아서|어서|여서|해서|아도|어도|해도|면|고)$/;
const SENTENCE_END = /(?:습니다|습니까|니다|니까|어요|아요|해요|예요|이에요|세요|네요|데요|군요|지요|잖아요|거든요|더라고요|더라|죠|까요|이다|했다|한다|된다|있다|없다|겠다|였다|란다)$/;
const DEPENDENT_WORD = /^(?:누구|누가|누굴|누구를|누구에게|언제|어디|어디서|어디로|어떻게|왜|무엇|무엇을|뭐|뭘|무슨|어떤|어느|몇|얼마나)$/;
const LINKING_WORD = /^(?:그리고|그러고|그래서|그러면|그러므로|그러니까|하지만|그런데|그렇지만|또는|혹은|그래도|그럼|대해서|위해서|비해서|따라서|통해|의해)$/;
const DEPENDENT_ADVERB = /^(?:아주|매우|너무|정말|더|좀|조금|훨씬|다시|한번|천천히|함께|모두|특히|바로|미리)$/;
const ADNOMINAL_END = /(?:하는|되는|있는|없는|했던|됐던|있던|없던|로운|다운|적인|어진|였던|았던|었던|는|던|한|된|할|될|좋은|작은|높은|낮은|많은|짧은|넓은|좁은|깊은|큰|같은|다른|모든|고운|예쁜)$/;
const BOUND_NOUN = /^(?:수|것|거|데|바|지|중|때|대로|만큼|듯|뿐)(?:이|가|은|는|을|를|도|에|에는)?$/;
const PARTICLE = /^(?:은|는|이|가|을|를|에|의|와|과|도|로|으로|만|부터|까지|에게|께서|처럼|보다)$/;
const POSTPOSITION_END = /(?:은|는|이|가|을|를|에|도|로|에게|에서|부터|까지)$/;
const AUXILIARY_START = /^(?:되(?:면|고|는|기|지|게|겠|셨|었|세요|나요|다)|됩|돼|됐|하(?:고|는|기|지|면|게|겠|였|다|세요|나요)|합|해|했|있|없|않|못|싶|같|주(?:세|시|었|겠|는|기|지|고|다)|줘|드리|드릴|드렸|보(?:세|시|았|겠|는|기|지|고|다)|봐|버리|두(?:었|는|고|겠|세)|놓|내(?:었|는|고|겠|세)|아니|아닙|입니다|입니까|이었|였)/;
const PREDICATE_COMPLEMENT_END = /(?:으면|면|아야|어야|여야|해야|아도|어도|여도|해도|더라도|라도|라고|다고|냐고|자고|하지|되지|않지)$/;
const AUXILIARY_COMPLEMENT_END = /(?:아|어|해|고)$/;
const PREDICATE_BOUND_NOUN = /^(?:수|것|거|듯|뿐|중|법)(?:이|가|은|는|을|를|도)?$/;
const SHORT_RESPONSE = /^(?:네|예|아니|아니요|아뇨|응|어|음|그래|그래요|맞아|맞아요|좋아|좋아요)[.!?…]*$/;

function singleLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function bareWord(word) {
  return word.replace(/[.,!?…'"”’\)\]\}]+$/u, '');
}

function lastWord(text) {
  return bareWord(text.match(/\S+$/)?.[0] ?? '');
}

function firstWord(text) {
  return bareWord(text.match(/^\S+/)?.[0] ?? '');
}

function dependentPredicatePair(previousWord, nextWord) {
  if (!AUXILIARY_START.test(nextWord)) return false;
  if (/지$/.test(previousWord) && /^(?:않|못)/.test(nextWord)) return true;
  return PREDICATE_COMPLEMENT_END.test(previousWord)
    || AUXILIARY_COMPLEMENT_END.test(previousWord)
    || PREDICATE_BOUND_NOUN.test(previousWord);
}

/**
 * Identifies a short dependent predicate continuation only. The caller must
 * separately check timing, speaker identity, and whether source words exist.
 */
export function isKoreanDependentPredicateTail(previousText, tailText) {
  const previous = singleLine(previousText);
  const tail = singleLine(tailText);
  if (!/[가-힣]/.test(previous) || !/[가-힣]/.test(tail)) return false;
  if (/[.!?。！？]["”’'\)\]\}]*$/u.test(previous)) return false;
  if (!tail || tail.length > 16 || tail.split(' ').length > 3) return false;
  const previousWord = lastWord(previous);
  if (SENTENCE_END.test(previousWord)) return false;
  return dependentPredicatePair(previousWord, firstWord(tail));
}

function boundaryCost(before, after) {
  const word = lastWord(before);
  const next = firstWord(after);
  let cost = 0;
  const dependent = QUOTED_END.test(word) || DEPENDENT_WORD.test(word)
    || LINKING_WORD.test(word) || DEPENDENT_ADVERB.test(word) || ADNOMINAL_END.test(word);
  if (dependent) cost += 120;
  if (BOUND_NOUN.test(next) || PARTICLE.test(next)) cost += 120;
  if (dependentPredicatePair(word, next)) cost += 160;

  if (/[.!?。！？]["”’'\)\]\}]*$/u.test(before)) cost -= 150;
  else if (!dependent && SENTENCE_END.test(word)) cost -= 60;
  else if (!dependent && CLAUSE_END.test(word)) cost -= 30;
  else if (!dependent && POSTPOSITION_END.test(word)) cost -= 15;
  return cost;
}

function lineCost(text, maxChars, isFirst) {
  const unused = maxChars - text.length;
  let cost = unused * unused / 4;
  if (!isFirst && text.length < Math.min(6, maxChars)
    && !text.includes(' ') && !SHORT_RESPONSE.test(text)) cost += 120;
  return cost;
}

function validateMaxChars(maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError('자막 최대 글자 수는 1 이상의 정수여야 합니다.');
  }
}

function planCuts(text, maxChars) {
  const plans = new Array(text.length + 1);
  plans[text.length] = { count: 0, cost: 0, end: text.length, next: text.length };

  // Only word starts are reachable, except fixed-width cuts inside an overlong
  // word. Planning every character repeats work for states no cue can use.
  const starts = [];
  for (let wordStart = 0; wordStart < text.length;) {
    const space = text.indexOf(' ', wordStart);
    const wordEnd = space === -1 ? text.length : space;
    for (let start = wordStart; start < wordEnd; start += maxChars) starts.push(start);
    wordStart = wordEnd + 1;
  }

  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index];
    const candidates = [];
    const limit = Math.min(start + maxChars, text.length);
    for (let end = start + 1; end <= limit; end += 1) {
      if (end === text.length || text[end] === ' ') candidates.push(end);
    }
    // A single unspaced word can exceed the product cap. Split only that word
    // when there is no usable word boundary, retaining every source character.
    if (candidates.length === 0) candidates.push(limit);

    let best;
    for (const end of candidates) {
      const wordBoundary = text[end] === ' ';
      const next = wordBoundary ? end + 1 : end;
      const rest = plans[next];
      const front = text.slice(start, end);
      const candidate = {
        count: rest.count + 1,
        cost: rest.cost + lineCost(front, maxChars, start === 0)
          + (wordBoundary ? boundaryCost(front, text.slice(next)) : 0),
        end,
        next,
      };
      // Prefer the smallest cue count, then choose useful phrase boundaries and
      // balanced lengths instead of filling the first cue and orphaning a tail.
      if (!best || candidate.count < best.count
        || (candidate.count === best.count && candidate.cost < best.cost)) best = candidate;
    }
    plans[start] = best;
  }
  return plans;
}

/** Returns one-line parts; whitespace is normalized and other text is untouched. */
export function splitKoreanSubtitleText(text, maxChars = DEFAULT_MAX_CHARS) {
  validateMaxChars(maxChars);
  const source = singleLine(text);
  if (!source) return [];
  if (source.length <= maxChars) return [source];
  const plans = planCuts(source, maxChars);
  const parts = [];
  for (let start = 0; start < source.length;) {
    const { end, next } = plans[start];
    parts.push(source.slice(start, end));
    start = next;
  }
  return parts;
}

/**
 * The caller supplies the same normalized one-line text used for slicing.
 * For multiple cuts, call splitKoreanSubtitleText once instead of replanning
 * every remaining suffix with this convenience helper.
 */
export function findKoreanSubtitleCutAt(text, maxChars = DEFAULT_MAX_CHARS) {
  validateMaxChars(maxChars);
  const source = singleLine(text);
  if (source.length <= maxChars) return source.length;
  return planCuts(source, maxChars)[0].end;
}
