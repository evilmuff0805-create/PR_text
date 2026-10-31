import { normalizeLanguage } from './language.js';
import { alignKoreanSegmentWithWordTimings, alignCorrectedKoreanSegmentWithWordTimings } from './korean-word-timing.js';
import { evaluateSpokenTextCorrection } from './postprocess.js';
import { mergeSubtitleReviews } from './subtitle-review.js';
import { normalizeFixedCuePlan, getBoundCorrectionStatus } from './fixed-cue-plan.js';
import { validateSubtitleSegments } from './subtitle-payload.js';

export const CONTEXT_FINALIZATION_LIMITS = Object.freeze({
  // The server accepts 50 MiB JSON. Leave room for the existing request wrapper.
  maxJsonBytes: 49 * 1024 * 1024,
  maxAddedJsonBytes: 4 * 1024 * 1024,
});

const line = text => String(text ?? '').replace(/[,，]/gu, '').replace(/\s+/gu, ' ').trim();
const spoken = text => Array.from(line(text).normalize('NFC').replace(/[^\p{L}\p{N}]/gu, ''));
const hasSpeaker = row => row?.speaker !== undefined && row.speaker !== null && row.speaker !== '';
const binding = row => ({ text: row.text, start: row.start, end: row.end });
const validRange = row => typeof row?.start === 'number' && Number.isFinite(row.start) && row.start >= 0
  && typeof row.end === 'number' && Number.isFinite(row.end) && row.end > row.start;
const cueList = rows => rows.map(row => [row.start, row.end, line(row.text)]);

function negationMarkers(text) {
  // A quoted letter/word and a substring such as 안내 or 연못 are not an
  // independent negator. This is a conservative lexical guard, not a parser.
  const unquoted = line(text).replace(/"[^"\s]+"|'[^'\s]+'|“[^”\s]+”|‘[^’\s]+’|「[^」\s]+」|『[^』\s]+』/gu, ' ');
  return (unquoted.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(word => {
    if (word === '안' || word === '못') return [word];
    if (/^않/u.test(word)) return ['않'];
    if (/^없(?:다|어|었|는|던|을|지|고|으|습|게|겠|음|네|죠|소|나|냐)/u.test(word)) return ['없'];
    if (/^(?:아니$|아니(?:다|고|라|면|에|었|예|죠|네|냐|오|잖|겠|군)|아닌|아닐)/u.test(word)) return ['아니다'];
    return [];
  });
}

function preservesNegation(before, after) {
  const original = negationMarkers(before), corrected = negationMarkers(after);
  return original.length === corrected.length && original.every((marker, index) => marker === corrected[index]);
}

const ONSET_FAMILIES = ['ᄀᄁᄏ', 'ᄃᄄᄐ', 'ᄇᄈᄑ', 'ᄉᄊ', 'ᄌᄍᄎ'];
const VOWEL_FAMILIES = ['ᅡᅣᅪ', 'ᅥᅧᅯ', 'ᅩᅭ', 'ᅮᅲ', 'ᅵᅱᅴ', 'ᅢᅦᅤᅨᅬᅫᅰ', 'ᅳᅴ'];
const relatedJamo = (left, right, families) => families.some(family => family.includes(left) && family.includes(right));

function hasLocalSpellingEvidence(before, after) {
  const left = spoken(before), right = spoken(after);
  // The strict mapper still handles validated contractions/expansions. A cue
  // fallback does not gain permission to insert/delete speech merely because
  // its complete sentence has a small edit ratio.
  if (left.length !== right.length) return false;
  let totalCost = 0;
  for (let index = 0; index < left.length;) {
    if (left[index] === right[index]) { index++; continue; }
    const start = index;
    let localCost = 0;
    while (index < left.length && left[index] !== right[index]) {
      if (index - start >= 2 || !/^[가-힣]$/u.test(left[index]) || !/^[가-힣]$/u.test(right[index])) return false;
      const original = Array.from(left[index].normalize('NFD'));
      const candidate = Array.from(right[index].normalize('NFD'));
      const changes = [0, 1, 2].filter(part => (original[part] ?? '') !== (candidate[part] ?? ''));
      // One changed jamo has the existing strict spelling evidence. For two,
      // retain the coda and require a nearby onset or vowel family as well;
      // a common final consonant alone cannot authorize another verb stem.
      if (changes.length > 2 || (changes.length === 2 && ((original[2] ?? '') !== (candidate[2] ?? '')
        || (!relatedJamo(original[0], candidate[0], ONSET_FAMILIES)
          && !relatedJamo(original[1], candidate[1], VOWEL_FAMILIES))))) return false;
      localCost += changes.length;
      if (localCost > 2) return false;
      index++;
    }
    totalCost += localCost;
    if (totalCost > 4) return false;
  }
  return totalCost > 0;
}

function boundedEdits(before, after) {
  const left = spoken(before), right = spoken(after);
  const budget = Math.min(4, Math.max(2, Math.floor(Math.max(left.length, right.length) / 4)));
  if (!left.length || Math.abs(left.length - right.length) > budget) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let index = 1; index <= left.length; index++) {
    const current = [index];
    for (let other = 1; other <= right.length; other++) current.push(Math.min(current[other - 1] + 1, previous[other] + 1,
      previous[other - 1] + (left[index - 1] === right[other - 1] ? 0 : 1)));
    previous = current;
  }
  if (previous.at(-1) > budget || previous.at(-1) > Math.max(left.length, right.length) * .4) return false;
  const tone = text => /(?:니다|니까|십시오)[.!?…]*$/u.test(text) ? 'formal' : /(?:요|죠)[.!?…]*$/u.test(text) ? 'polite' : 'plain';
  return tone(line(before)) === tone(line(after));
}

/** Only one existing cue may own the edit; unchanged neighbouring cues anchor it. */
export function planCueWindowCorrection(original, corrected) {
  const prior = alignKoreanSegmentWithWordTimings(original);
  const candidate = line(corrected?.text);
  if (!prior.aligned || !validRange(corrected) || original.start !== corrected.start || original.end !== corrected.end
    || !candidate || !evaluateSpokenTextCorrection(original.text, candidate).accepted) return { accepted: false, reason: 'unverified_source_or_guard' };
  if (!preservesNegation(original.text, candidate)) return { accepted: false, reason: 'negation_changed' };
  const baseline = prior.segments.map(cue => ({ ...cue, text: line(cue.text) }));
  if (baseline.some(cue => !cue.text || cue.text.length > 28)) return { accepted: false, reason: 'invalid_existing_cue' };
  const possibilities = [];
  let spellingRejected = false;
  for (let index = 0; index < baseline.length; index++) {
    const prefix = baseline.slice(0, index).map(cue => cue.text).join(' ');
    const suffix = baseline.slice(index + 1).map(cue => cue.text).join(' ');
    if ((prefix && !candidate.startsWith(prefix + ' ')) || (suffix && !candidate.endsWith(' ' + suffix))) continue;
    const start = prefix ? prefix.length + 1 : 0;
    const end = suffix ? candidate.length - suffix.length - 1 : candidate.length;
    const text = candidate.slice(start, end);
    if (!text || text !== line(text) || text.length > 28 || text === baseline[index].text
      || !evaluateSpokenTextCorrection(baseline[index].text, text).accepted || !boundedEdits(baseline[index].text, text)) continue;
    if (!hasLocalSpellingEvidence(baseline[index].text, text)) { spellingRejected = true; continue; }
    const cues = baseline.map((cue, position) => position === index ? { ...cue, text } : cue);
    if (line(cues.map(cue => cue.text).join(' ')) === candidate) possibilities.push(cues);
  }
  return possibilities.length === 1 ? { accepted: true, cues: possibilities[0], originalCues: baseline }
    : { accepted: false, reason: spellingRejected ? 'spelling_evidence_missing' : 'cue_ownership_ambiguous' };
}

function fixedRow(cues, originalCues, metadata, { issue, reason, status, grammarWithheld = false } = {}) {
  if (!cues.length) return undefined;
  const current = { text: line(cues.map(cue => cue.text).join(' ')), start: cues[0].start, end: cues.at(-1).end };
  const original = originalCues?.length ? { text: line(originalCues.map(cue => cue.text).join(' ')),
    start: originalCues[0].start, end: originalCues.at(-1).end, cues: cueList(originalCues) } : undefined;
  const plan = normalizeFixedCuePlan({ version: 1, binding: current, cues: cueList(cues), ...(original ? { original } : {}) });
  if (!plan) return undefined;
  const { sourceWords, wordAlignedCues, fixedCuePlan, ...safe } = metadata ?? {};
  const review = mergeSubtitleReviews(safe.subtitleReview, { version: 1,
    issues: issue ? [{ code: issue, ...(reason ? { reason } : {}) }] : [],
    ...(status ? { correctionStatus: status, correctionBinding: current } : {}),
    ...(original ? { originalText: original.text, originalTiming: { start: original.start, end: original.end } } : {}),
  });
  // An applied candidate is not a pending or manually confirmed correction.
  if (status === 'cue_applied' && review) { delete review.candidateText; delete review.textStatus; }
  return { ...safe, ...current, timingSource: 'speech_window', fixedCuePlan: plan,
    ...(review ? { subtitleReview: review } : {}),
    ...(grammarWithheld ? { grammarPolish: { status: 'boundary_withheld' } } : {}),
  };
}

function rawOwners(source, originals) {
  const matches = [];
  for (let index = 0; index < originals.length; index++) {
    const first = originals[index];
    if (first.start !== source.start) continue;
    if (first.end === source.end && line(first.text) === line(source.text)) matches.push([index]);
    const next = originals[index + 1];
    if (next && next.end === source.end && line(first.text + ' ' + next.text) === line(source.text)) matches.push([index, index + 1]);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function fallbackTrace(sources, corrected) {
  return { compact: false, blocks: sources.map((source, index) => {
    const aligned = alignCorrectedKoreanSegmentWithWordTimings(source, corrected[index]);
    return { sourceStartIndex: index, sourceEndIndex: index,
      flatCount: aligned.subtitleReview?.candidateText && aligned.segments.length > 1 ? 1 : aligned.segments.length };
  }) };
}

/** Consumes only this invocation's in-memory AI observations, after ALL AI work. */
export function finalizeTranscriptionContext({ sourceSegments = [], correctionSourceSegments = [], correctedSegments = [],
  baseSegments, segments = [], trace, language, limits = CONTEXT_FINALIZATION_LIMITS } = {}) {
  const summary = { cueCorrectionsApplied: 0, sourceBoundariesRestored: 0, heldCandidates: 0, grammarWithheld: 0, limited: false };
  const finish = result => {
    if (result === segments) {
      summary.cueCorrectionsApplied = 0;
      summary.sourceBoundariesRestored = 0;
      summary.heldCandidates = 0;
      summary.grammarWithheld = 0;
    }
    return { segments: result, summary };
  };
  if (normalizeLanguage(language) !== 'ko' || segments.some(hasSpeaker)
    || correctedSegments.length !== correctionSourceSegments.length) return finish(segments);
  const sources = correctionSourceSegments;
  const base = baseSegments ?? segments;
  const observed = trace?.blocks ? trace : fallbackTrace(sources, correctedSegments);
  if (observed.blocks.reduce((count, block) => count + (observed.compact ? 1 : block.flatCount), 0) !== base.length) {
    summary.limited = true;
    return finish(segments);
  }
  const replacements = new Map();
  let offset = 0;
  for (const block of observed.blocks) {
    const count = observed.compact ? 1 : block.flatCount;
    const baseline = base.slice(offset, offset + count);
    const baseOffset = offset;
    offset += count;
    const indices = Array.from({ length: block.sourceEndIndex - block.sourceStartIndex + 1 }, (_, index) => block.sourceStartIndex + index);
    const originalOwners = indices.map(index => rawOwners(sources[index], sourceSegments));
    const joinedAcrossSources = indices.length > 1 && originalOwners.every(Boolean)
      && new Set(originalOwners.flat()).size > 1;
    const splitInitialSources = indices.length === 1 && originalOwners[0]?.length > 1;
    const plans = indices.map((index, position) => {
      const original = sources[index], corrected = correctedSegments[index];
      const strict = alignCorrectedKoreanSegmentWithWordTimings(original, corrected);
      const freshCandidate = corrected.text !== original.text && strict.correctionRetained === false;
      return { index, original, corrected, strict, freshCandidate,
        window: freshCandidate ? originalOwners[position]
          ? planCueWindowCorrection(original, corrected) : { accepted: false, reason: 'source_ownership_ambiguous' } : undefined };
    });
    const hasFallback = plans.some(plan => plan.window?.accepted);
    const hasHeld = plans.some(plan => plan.freshCandidate && !plan.window?.accepted);
    if (!joinedAcrossSources && !splitInitialSources && !hasFallback && !hasHeld) continue;

    let currentIndices;
    if (segments === base) currentIndices = Array.from({ length: count }, (_, index) => baseOffset + index);
    else {
      const start = Math.min(...baseline.map(row => row.start)), end = Math.max(...baseline.map(row => row.end));
      const competingBase = base.some((row, index) => (index < baseOffset || index >= baseOffset + count)
        && row.end > start && row.start < end);
      const touching = segments.flatMap((row, index) => row.end > start && row.start < end ? [index] : []);
      currentIndices = touching.filter(index => segments[index].start >= start && segments[index].end <= end);
      if (competingBase || touching.length !== currentIndices.length || !currentIndices.length
        || Math.min(...currentIndices.map(index => segments[index].start)) !== start
        || Math.max(...currentIndices.map(index => segments[index].end)) !== end
        || currentIndices.some((index, position) => position > 0 && index !== currentIndices[position - 1] + 1)) {
        summary.limited = true; continue;
      }
    }
    const current = currentIndices.map(index => segments[index]);
    const grammarChanged = line(current.map(row => row.text).join(' ')) !== line(baseline.map(row => row.text).join(' '))
      || current.some(row => row.grammarPolish?.status === 'applied');
    if (grammarChanged && !joinedAcrossSources && !splitInitialSources) {
      summary.heldCandidates++;
      const held = current.map(row => {
        // The previous basic candidate belongs to the pre-grammar text/range.
        // Do not make it appear current by attaching a new binding to it.
        const { candidateText, textStatus, ...review } = row.subtitleReview ?? {};
        return { ...row, subtitleReview: mergeSubtitleReviews(review,
          { version: 1, issues: [{ code: 'finalization_candidate_held', reason: 'grammar_binding_changed' }],
            correctionStatus: 'held', correctionBinding: binding(row) }) };
      });
      replacements.set(currentIndices[0], { end: currentIndices.at(-1), rows: held });
      continue;
    }

    let desired = [];
    let blockApplied = 0;
    let blockBoundaries = 0;
    if (splitInitialSources) {
      const correctionUnassigned = grammarChanged
        || line(plans[0].corrected.text) !== line(plans[0].original.text);
      for (const owner of originalOwners[0]) {
        const raw = sourceSegments[owner];
        const aligned = alignKoreanSegmentWithWordTimings(raw);
        const cues = aligned.aligned ? aligned.segments : raw.text.trim().length <= 28 ? [{ start: raw.start, end: raw.end, text: line(raw.text) }] : [];
        const row = fixedRow(cues, undefined, raw, { issue: 'source_boundary_preserved', reason: 'unknown_speaker_boundary', grammarWithheld: grammarChanged });
        if (row) {
          if (correctionUnassigned) {
            // One corrected merged line cannot be copied into two source
            // windows. Record the withheld edit without duplicating a stale
            // candidate or presenting either raw row as the correction owner.
            const { candidateText, textStatus, ...review } = row.subtitleReview ?? {};
            row.subtitleReview = mergeSubtitleReviews(review, { version: 1,
              issues: [{ code: 'finalization_candidate_held', reason: 'split_source_correction_unassigned' }],
              correctionStatus: 'held', correctionBinding: binding(row) });
          }
          desired.push(row);
        }
      }
      if (desired.length !== originalOwners[0].length) { summary.limited = true; continue; }
      if (correctionUnassigned) summary.heldCandidates++;
      blockBoundaries = originalOwners[0].length - 1;
    } else if (joinedAcrossSources || hasFallback) {
      for (const plan of plans) {
        const candidate = !grammarChanged && plan.window?.accepted;
        const cues = candidate ? plan.window.cues : plan.strict.segments;
        if (!plan.strict.aligned && !candidate) { desired = []; break; }
        const row = fixedRow(cues, candidate ? plan.window.originalCues : undefined,
          joinedAcrossSources ? plan.strict.segments[0] : baseline[0], {
            issue: candidate ? 'cue_window_correction_applied' : 'source_boundary_preserved',
            reason: candidate ? 'word_mapping_ambiguous' : 'unknown_speaker_boundary',
            status: candidate ? 'cue_applied' : undefined, grammarWithheld: grammarChanged });
        if (!row) { desired = []; break; }
        desired.push(row);
        if (candidate) blockApplied++;
      }
      if (!desired.length) { summary.limited = true; continue; }
      if (joinedAcrossSources) blockBoundaries = indices.length - 1;
    } else {
      summary.heldCandidates++;
      desired = current.map(row => ({ ...row, subtitleReview: mergeSubtitleReviews(row.subtitleReview,
        { version: 1, issues: [{ code: 'finalization_candidate_held', reason: plans.find(plan => plan.freshCandidate)?.window?.reason ?? 'cue_ownership_ambiguous' }],
          correctionStatus: 'held', correctionBinding: binding(row) }) }));
    }
    if (grammarChanged) summary.grammarWithheld++;
    summary.cueCorrectionsApplied += blockApplied;
    summary.sourceBoundariesRestored += blockBoundaries;
    replacements.set(currentIndices[0], { end: currentIndices.at(-1), rows: desired });
  }
  if (!replacements.size) return finish(segments);
  let result = [];
  for (let index = 0; index < segments.length; index++) {
    const replacement = replacements.get(index);
    if (replacement) { result.push(...replacement.rows); index = replacement.end; }
    else result.push(segments[index]);
  }
  if (result.length > 5_000) {
    result = [];
    for (let index = 0; index < segments.length; index++) {
      const replacement = replacements.get(index);
      if (!replacement) { result.push(segments[index]); continue; }
      const cues = replacement.rows.flatMap(row => row.fixedCuePlan?.cues?.map(([start, end, text]) => ({ start, end, text })) ?? [row]);
      const hasOriginal = replacement.rows.some(row => row.fixedCuePlan?.original);
      const originals = hasOriginal ? replacement.rows.flatMap(row => (row.fixedCuePlan?.original?.cues ?? row.fixedCuePlan?.cues)
        ?.map(([start, end, text]) => ({ start, end, text })) ?? [row]) : undefined;
      const applied = replacement.rows.some(row => getBoundCorrectionStatus(row) === 'cue_applied');
      const held = replacement.rows.some(row => getBoundCorrectionStatus(row) === 'held');
      const compact = fixedRow(cues, originals, replacement.rows[0], {
        issue: applied ? 'cue_window_correction_applied' : 'source_boundary_preserved', reason: 'compact_boundary_plan',
        status: applied ? 'cue_applied' : held ? 'held' : undefined,
        grammarWithheld: replacement.rows.some(row => row.grammarPolish?.status === 'boundary_withheld'),
      });
      if (!compact) { summary.limited = true; return finish(segments); }
      result.push(compact); index = replacement.end;
    }
  }
  if (validateSubtitleSegments(result)) { summary.limited = true; return finish(segments); }
  const cap = key => Number.isFinite(limits?.[key]) && limits[key] >= 0
    ? Math.min(limits[key], CONTEXT_FINALIZATION_LIMITS[key]) : CONTEXT_FINALIZATION_LIMITS[key];
  try {
    const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const baselineBytes = Buffer.byteLength(JSON.stringify(segments), 'utf8');
    if (resultBytes > cap('maxJsonBytes') || resultBytes - baselineBytes > cap('maxAddedJsonBytes')) {
      summary.limited = true;
      return finish(segments);
    }
  } catch {
    summary.limited = true;
    return finish(segments);
  }
  return finish(result);
}
