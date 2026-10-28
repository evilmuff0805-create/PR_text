import { buildSubtitleCues } from './subtitle.js';
import { normalizeLanguage } from './language.js';
import { evaluateSpokenTextCorrection } from './postprocess.js';

export const POLISH_MODES = new Set(['preserve', 'grammar']);
const MAX_LINES = 12;
const MAX_TOTAL_LINES = 120;
const MAX_INPUT_CHARS = MAX_TOTAL_LINES * 28;
const TIMEOUT_MS = 12_000;
const TOTAL_BUDGET_MS = 60_000;
const PARTICLE_GROUPS = [['은', '는'], ['이', '가'], ['을', '를'], ['과', '와'], ['으로', '로']];
const TOKEN = /[가-힣]+|[A-Za-z]+|\d+(?:[.,]\d+)*/gu;
const NUMBER = /[+\-−±∓＋－]?\p{N}+(?:[.,:/~–—-]\p{N}+)*/gu;
const NEGATION = /안|못|않|없|아니|말고/gu;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

function splitParticle(word) {
  for (const group of PARTICLE_GROUPS) {
    for (const particle of group) {
      const stem = word.endsWith(particle) ? word.slice(0, -particle.length) : '';
      if (stem) return { stem, particle, group };
    }
  }
  return { stem: word, particle: '', group: null };
}

function particleFits(stem, particle) {
  const lastCode = stem.charCodeAt(stem.length - 1);
  const final = lastCode >= 0xac00 && lastCode <= 0xd7a3 ? (lastCode - 0xac00) % 28 : 0;
  if (particle === '은' || particle === '이' || particle === '을' || particle === '과') return final !== 0;
  if (particle === '는' || particle === '가' || particle === '를' || particle === '와') return final === 0;
  if (particle === '으로') return final !== 0 && final !== 8;
  if (particle === '로') return final === 0 || final === 8;
  return false;
}

function matchesIn(text, regex) {
  return [...text.matchAll(regex)].map((match) => match[0]);
}

function punctuationSignature(text) {
  return [...text.matchAll(new RegExp(PUNCTUATION.source, 'gu'))]
    .map((match) => `${(text.slice(0, match.index).match(TOKEN) || []).length}:${match[0]}`);
}

function safeKoreanEdit(original, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 28
    || /[\r\n\t\u0000-\u001f\u007f]/u.test(candidate)) return false;
  if (!evaluateSpokenTextCorrection(original, candidate).accepted) return false;
  if (JSON.stringify(matchesIn(original, new RegExp(NUMBER.source, 'gu'))) !== JSON.stringify(matchesIn(candidate, new RegExp(NUMBER.source, 'gu')))) return false;
  if (JSON.stringify(matchesIn(original, new RegExp(NEGATION.source, 'gu'))) !== JSON.stringify(matchesIn(candidate, new RegExp(NEGATION.source, 'gu')))) return false;
  if (JSON.stringify(punctuationSignature(original)) !== JSON.stringify(punctuationSignature(candidate))) return false;
  const before = original.match(TOKEN) || [];
  const after = candidate.match(TOKEN) || [];
  if (before.length !== after.length) return false;
  let particleChanges = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === after[index]) continue;
    if (!/[가-힣]/u.test(before[index]) || !/[가-힣]/u.test(after[index])) return false;
    const left = splitParticle(before[index]);
    const right = splitParticle(after[index]);
    if (left.stem.length < 2 || left.stem !== right.stem || !left.group || left.group !== right.group
      || particleFits(left.stem, left.particle) || !particleFits(right.stem, right.particle)) return false;
    particleChanges += 1;
  }
  // Changing several grammatical roles in one line can reverse who did what.
  return particleChanges <= 1;
}

function sameCueTimeline(before, after) {
  return before.length === after.length && before.every((cue, index) => {
    const next = after[index];
    return cue.start === next.start && cue.end === next.end && cue.speaker === next.speaker;
  });
}

function annotate(segments, statuses, originalSegments = segments) {
  return segments.map((segment, index) => ({ ...segment,
    grammarPolish: { originalText: originalSegments[index]?.text, status: statuses[index] || 'skipped' },
  }));
}

/** Applies optional Korean grammar edits after spelling correction and alignment.
 * Any uncertainty leaves the complete corrected baseline in place. */
export async function polishKoreanSegments(segments, language, { polishLines, signal, buildCues = buildSubtitleCues } = {}) {
  const startedAt = Date.now();
  let calls = 0;
  let model;
  const usage = { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, totalTokens: 0 };
  const metrics = () => ({ wallMs: Date.now() - startedAt, calls, ...(model ? { model } : {}), usage });
  const normalized = normalizeLanguage(language);
  const isKorean = normalized === 'ko';
  if (!isKorean) return { segments: annotate(segments, Array(segments.length).fill('unsupported_language')), applied: 0, skipped: segments.length, unavailable: false, metrics: metrics() };

  const eligible = [];
  const baseline = segments.map((segment) => ({ ...segment }));
  const statuses = Array(segments.length).fill('skipped');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (typeof segment.text !== 'string' || !segment.text.trim()) { statuses[index] = 'empty_line'; continue; }
    if (Array.from(segment.text).length > 28) { statuses[index] = 'long_line'; continue; }
    if (segment.wordAlignedCues) { statuses[index] = 'word_timing'; continue; }
    if (segment.subtitleReview?.candidateText || segment.subtitleReview?.timingCandidate) { statuses[index] = 'review_pending'; continue; }
    if (!/[가-힣]/u.test(segment.text)) { statuses[index] = 'non_korean_row'; continue; }
    eligible.push(index);
  }
  const selected = [];
  let selectedChars = 0;
  for (const index of eligible) {
    const length = Array.from(segments[index].text).length;
    if (selected.length >= MAX_TOTAL_LINES || selectedChars + length > MAX_INPUT_CHARS) break;
    selected.push(index);
    selectedChars += length;
  }
  const limited = selected.length < eligible.length;
  for (const index of eligible.slice(selected.length)) statuses[index] = 'limit';
  if (!selected.length || typeof polishLines !== 'function') {
    return { segments: annotate(baseline, statuses), applied: 0, skipped: baseline.length, unavailable: false, limited, metrics: metrics() };
  }

  let applied = 0;
  let unavailable = false;
  for (let offset = 0; offset < selected.length; offset += MAX_LINES) {
    if (signal?.aborted || Date.now() - startedAt >= TOTAL_BUDGET_MS) {
      unavailable = true;
      for (const index of selected.slice(offset)) statuses[index] = 'timeout';
      break;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const timer = setTimeout(() => controller.abort(new Error('문법 다듬기 시간 초과')), Math.min(TIMEOUT_MS, remaining));
    let abortReject;
    const abortPromise = new Promise((_, reject) => { abortReject = reject; });
    const rejectOnAbort = () => abortReject(controller.signal.reason || new Error('문법 다듬기 중단'));
    if (controller.signal.aborted) rejectOnAbort();
    else controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    let candidates;
    try {
      const chunk = selected.slice(offset, offset + MAX_LINES);
      calls += 1;
      const response = await Promise.race([polishLines(chunk.map((index) => segments[index].text), { signal: controller.signal }), abortPromise]);
      if (Array.isArray(response)) candidates = response;
      else if (response && Array.isArray(response.lines)) {
        candidates = response.lines;
        model ||= typeof response.model === 'string' ? response.model : undefined;
        for (const key of Object.keys(usage)) usage[key] += Number.isSafeInteger(response.usage?.[key]) && response.usage[key] > 0 ? response.usage[key] : 0;
      }
    } catch {
      unavailable = true;
      for (const index of selected.slice(offset)) statuses[index] = 'timeout';
      break;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectOnAbort);
      signal?.removeEventListener('abort', abort);
    }
    const chunk = selected.slice(offset, offset + MAX_LINES);
    if (!Array.isArray(candidates) || candidates.length !== chunk.length) {
      unavailable = true;
      for (const index of chunk) statuses[index] = 'invalid_response';
      continue;
    }
    for (let position = 0; position < chunk.length; position += 1) {
      const index = chunk[position];
      const original = segments[index].text;
      const candidate = candidates[position];
      if (safeKoreanEdit(original, candidate)) {
        baseline[index] = { ...baseline[index], text: candidate };
        applied += Number(candidate !== original);
        statuses[index] = candidate === original ? 'unchanged' : 'applied';
      } else {
        statuses[index] = 'unsafe_candidate';
      }
    }
  }
  if (applied && !sameCueTimeline(buildCues(segments, { holdShortGaps: false }), buildCues(baseline, { holdShortGaps: false }))) {
    return { segments: annotate(segments, Array(segments.length).fill('timeline_fallback'), segments), applied: 0, skipped: segments.length, unavailable: true, limited, metrics: metrics() };
  }

  return { segments: annotate(baseline, statuses, segments), applied, skipped: segments.length - applied, unavailable, limited, metrics: metrics() };
}
