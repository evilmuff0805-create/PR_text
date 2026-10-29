import { buildSubtitleCues } from './subtitle.js';
import { normalizeLanguage } from './language.js';

export const POLISH_MODES = new Set(['preserve', 'grammar']);
const MAX_CUES_PER_GROUP = 12;
const MAX_GROUPS_PER_CALL = 6;
const MAX_TOTAL_CUES = 120;
const MAX_INPUT_CHARS = 3_360;
const MAX_CUE_CHARS = 28;
// Real dialogue benchmarking showed that rewrite + independent review can
// exceed 12s for a 12-window batch. Keep a 30s per-batch ceiling and the
// existing 60s whole-file budget.
const CALL_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 60_000;
const NUMBER = /[+\-−±∓＋－]?\p{N}+(?:[.,:/~–—-]\p{N}+)*/gu;
const ENGLISH = /[A-Za-z]+(?:[.'’-][A-Za-z]+)*/gu;

function sameCueTimeline(before, after) {
  return before.length === after.length && before.every((cue, index) => {
    const next = after[index];
    return cue.start === next.start && cue.end === next.end && cue.speaker === next.speaker;
  });
}

function signature(text, pattern) {
  return [...String(text ?? '').matchAll(new RegExp(pattern.source, 'gu'))].map((match) => match[0]);
}

function isDiarized(cues) {
  return cues.some((cue) => cue.speaker !== undefined && cue.speaker !== null && cue.speaker !== '');
}

function canJoinCueWindow(previous, next, diarized) {
  if (diarized && previous.speaker !== next.speaker) return false;
  const gap = Number(next.start) - Number(previous.end);
  if (!Number.isFinite(gap) || gap < -1e-9) return false;
  // Diarized speech never groups across a positive silence. Ordinary speech
  // follows the existing 0.3s dependency-tail bound; larger pauses start a
  // new sentence window and are never filled by the rewrite.
  return diarized ? gap <= 1e-9 : gap <= 0.3 + 1e-9;
}

function makeGroups(cues) {
  const groups = [];
  const diarized = isDiarized(cues);
  for (let index = 0; index < cues.length;) {
    const group = [index];
    while (index + 1 < cues.length && group.length < MAX_CUES_PER_GROUP
      && canJoinCueWindow(cues[index], cues[index + 1], diarized)) {
      index += 1;
      group.push(index);
    }
    groups.push(group);
    index += 1;
  }
  return groups;
}

function validCandidate(source, candidate) {
  if (typeof candidate !== 'string') return false;
  const cleaned = candidate.replace(/\s+/gu, ' ').trim();
  if (!cleaned || cleaned !== candidate || /[\r\n\t\u0000-\u001f\u007f]/u.test(candidate)) return false;
  if (Array.from(candidate).length > MAX_CUE_CHARS) return false;
  if (hasFormalKoreanEnding(source) && !hasFormalKoreanEnding(candidate)) return false;
  if (JSON.stringify(signature(source, NUMBER)) !== JSON.stringify(signature(candidate, NUMBER))) return false;
  if (JSON.stringify(signature(source, ENGLISH)) !== JSON.stringify(signature(candidate, ENGLISH))) return false;
  return true;
}

function hasFormalKoreanEnding(text) {
  return /(?:니다|니까|십시오)[.!?…。、」』"”’)]*$/u.test(String(text ?? '').trim());
}

function koreanEojeolCounts(text) {
  const counts = new Map();
  for (const eojeol of String(text ?? '').match(/[가-힣]+/gu) || []) {
    counts.set(eojeol, (counts.get(eojeol) || 0) + 1);
  }
  return counts;
}

function preservesKoreanEojeolOwnership(sourceGroup, candidateGroup) {
  const sourceCounts = sourceGroup.map(koreanEojeolCounts);
  const candidateCounts = candidateGroup.map(koreanEojeolCounts);
  for (let sourceIndex = 0; sourceIndex < sourceCounts.length; sourceIndex += 1) {
    for (const [eojeol, sourceCount] of sourceCounts[sourceIndex]) {
      if ((candidateCounts[sourceIndex].get(eojeol) || 0) >= sourceCount) continue;
      for (let candidateIndex = 0; candidateIndex < candidateCounts.length; candidateIndex += 1) {
        if (candidateIndex === sourceIndex) continue;
        if ((candidateCounts[candidateIndex].get(eojeol) || 0)
          > (sourceCounts[candidateIndex].get(eojeol) || 0)) return false;
      }
    }
  }
  return true;
}

function addUsage(total, usage = {}) {
  for (const key of Object.keys(total)) {
    total[key] += Number.isSafeInteger(usage[key]) && usage[key] > 0 ? usage[key] : 0;
  }
}

function summarizeStatuses(statuses) {
  return statuses.reduce((counts, status) => {
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

/** Rewrites Korean subtitle windows as an opt-in post-processing stage.
 * The same cue count, cue ownership, speaker, and times are mandatory.
 * Any failed mapping or meaning/timing review rolls back the entire window. */
export async function polishKoreanSegments(segments, language, {
  rewriteLines,
  verifyLines,
  polishLines,
  signal,
  buildCues = buildSubtitleCues,
} = {}) {
  const startedAt = Date.now();
  let calls = 0;
  let model;
  let requestedModel;
  let fallbackUsed = false;
  const usage = { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, totalTokens: 0 };
  const metrics = () => ({ wallMs: Date.now() - startedAt, calls, ...(model ? { model } : {}), ...(requestedModel ? { requestedModel } : {}), fallbackUsed, usage });
  const normalized = normalizeLanguage(language);
  if (normalized !== 'ko') {
    return { segments, applied: 0, skipped: segments.length, unavailable: false, metrics: metrics() };
  }

  const cues = buildCues(segments, { holdShortGaps: false }).map((cue) => ({ ...cue }));
  if (cues.length > 5_000) {
    return { segments, applied: 0, skipped: cues.length, unavailable: false, limited: true,
      summary: { statuses: { limit: cues.length } }, metrics: metrics() };
  }
  const beforeCues = buildCues(cues, { holdShortGaps: false });
  if (!sameCueTimeline(cues, beforeCues)) {
    return { segments, applied: 0, skipped: cues.length, unavailable: true, limited: false,
      summary: { statuses: { timeline_fallback: cues.length } }, metrics: metrics() };
  }
  const baseline = cues.map((cue) => ({ ...cue }));
  const statuses = Array(cues.length).fill('skipped');
  const groups = makeGroups(cues);
  const reviewRanges = segments.filter((segment) => segment.subtitleReview?.candidateText
    || segment.subtitleReview?.timingCandidate).map((segment) => [Number(segment.start), Number(segment.end)]);
  const eligibleGroups = [];
  let selectedCues = 0;
  let selectedChars = 0;
  let limited = false;

  for (const group of groups) {
    const groupCues = group.map((index) => cues[index]);
    if (groupCues.some((cue) => reviewRanges.some(([start, end]) => (
      Number(cue.start) < end && Number(cue.end) > start
    )))) {
      for (const index of group) statuses[index] = 'review_pending';
      continue;
    }
    if (groupCues.some((cue) => typeof cue.text !== 'string' || !cue.text.trim()
      || Array.from(cue.text).length > MAX_CUE_CHARS || !/[가-힣]/u.test(cue.text))) {
      for (const index of group) statuses[index] = 'unsupported_cue';
      continue;
    }
    const length = groupCues.reduce((sum, cue) => sum + Array.from(cue.text).length, 0);
    if (selectedCues + group.length > MAX_TOTAL_CUES || selectedChars + length > MAX_INPUT_CHARS) {
      limited = true;
      for (const index of group) statuses[index] = 'limit';
      continue;
    }
    selectedCues += group.length;
    selectedChars += length;
    eligibleGroups.push(group);
  }

  const rewriter = typeof rewriteLines === 'function' ? rewriteLines : polishLines;
  if (!eligibleGroups.length || typeof rewriter !== 'function' || typeof verifyLines !== 'function') {
    const unavailable = typeof verifyLines !== 'function';
    if (unavailable) for (const group of eligibleGroups) for (const index of group) statuses[index] = 'verifier_unavailable';
    return { segments, applied: 0, skipped: segments.length, unavailable, limited,
      summary: { statuses: summarizeStatuses(statuses) }, metrics: metrics() };
  }

  let unavailable = false;
  let applied = 0;
  for (let offset = 0; offset < eligibleGroups.length; offset += MAX_GROUPS_PER_CALL) {
    if (signal?.aborted || Date.now() - startedAt >= TOTAL_BUDGET_MS) {
      unavailable = true;
      for (const group of eligibleGroups.slice(offset).flat()) statuses[group] = 'timeout';
      break;
    }
    const groupBatch = eligibleGroups.slice(offset, offset + MAX_GROUPS_PER_CALL);
    const sourceGroups = groupBatch.map((group) => group.map((index) => cues[index].text));
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('문장 다듬기 시간 초과')),
      Math.min(CALL_TIMEOUT_MS, remaining));
    const request = async (fn) => {
      calls += 1;
      const result = await fn(sourceGroups, { signal: controller.signal });
      model ||= result?.model;
      requestedModel ||= result?.requestedModel;
      fallbackUsed ||= result?.fallbackUsed === true;
      addUsage(usage, result?.usage);
      return result;
    };
    let rewritten;
    let verdict;
    let apiError;
    try {
      let rejectOnAbort;
      const abortPromise = new Promise((_, reject) => { rejectOnAbort = reject; });
      const reject = () => rejectOnAbort(controller.signal.reason || new Error('문장 다듬기 취소'));
      if (controller.signal.aborted) reject();
      else controller.signal.addEventListener('abort', reject, { once: true });
      try {
        rewritten = await Promise.race([request(rewriter), abortPromise]);
        const candidateGroups = rewritten?.groups;
        if (!Array.isArray(candidateGroups) || candidateGroups.length !== sourceGroups.length
          || candidateGroups.some((candidate, index) => !Array.isArray(candidate)
            || candidate.length !== sourceGroups[index].length
            || candidate.some((line) => typeof line !== 'string' || !line.trim()))) {
          apiError = 'invalid_response';
        } else {
          const structurallySafe = candidateGroups.map((candidateGroup, groupIndex) => (
            candidateGroup.every((line, lineIndex) => validCandidate(sourceGroups[groupIndex][lineIndex], line))
              && preservesKoreanEojeolOwnership(sourceGroups[groupIndex], candidateGroup)
          ));
          const reviewGroups = candidateGroups.map((candidateGroup, groupIndex) => (
            structurallySafe[groupIndex] ? candidateGroup : sourceGroups[groupIndex]
          ));
          if (candidateGroups.some((group, index) => group.some((line, lineIndex) => line !== sourceGroups[index][lineIndex]))) {
            verdict = await Promise.race([request((input, options) => verifyLines(sourceGroups, reviewGroups, options)), abortPromise]);
          } else {
            verdict = { accepted: sourceGroups.map(() => true), model: rewritten.model,
              usage: { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, totalTokens: 0 } };
          }
          if (!Array.isArray(verdict?.accepted) || verdict.accepted.length !== sourceGroups.length
            || verdict.accepted.some((accepted) => typeof accepted !== 'boolean')) apiError = 'invalid_response';
        }
      } finally {
        controller.signal.removeEventListener('abort', reject);
      }
    } catch {
      apiError = controller.signal.aborted ? 'timeout' : 'api_error';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }

    if (apiError) {
      unavailable = true;
      for (const group of groupBatch) for (const index of group) statuses[index] = apiError;
      if (apiError === 'timeout' || apiError === 'api_error') {
        for (const group of eligibleGroups.slice(offset + groupBatch.length)) {
          for (const index of group) statuses[index] = apiError;
        }
        break;
      }
      continue;
    }

    const candidateGroups = rewritten.groups;
    for (let groupIndex = 0; groupIndex < groupBatch.length; groupIndex += 1) {
      const group = groupBatch[groupIndex];
      const candidateGroup = candidateGroups[groupIndex];
      const structurallySafe = candidateGroup.every((line, lineIndex) => validCandidate(sourceGroups[groupIndex][lineIndex], line))
        && preservesKoreanEojeolOwnership(sourceGroups[groupIndex], candidateGroup);
      const accepted = structurallySafe && verdict.accepted[groupIndex] === true;
      if (!accepted) {
        for (const index of group) statuses[index] = structurallySafe ? 'meaning_or_timing_rejected' : 'unsafe_candidate';
        continue;
      }
      for (let lineIndex = 0; lineIndex < group.length; lineIndex += 1) {
        const cueIndex = group[lineIndex];
        const candidate = candidateGroup[lineIndex];
        if (candidate !== baseline[cueIndex].text) {
          const { wordAlignedCues: ignoredWordCues, timingSource: ignoredTimingSource, ...safeCue } = baseline[cueIndex];
          baseline[cueIndex] = { ...safeCue, text: candidate, timingSource: 'speech_window' };
          applied += 1;
          statuses[cueIndex] = 'applied';
        } else statuses[cueIndex] = 'unchanged';
      }
    }
  }

  if (applied) {
    const afterCues = buildCues(baseline, { holdShortGaps: false });
    if (!sameCueTimeline(beforeCues, afterCues)) {
      return { segments, applied: 0, skipped: cues.length, unavailable: true, limited, metrics: metrics() };
    }
    const annotated = baseline.map((cue, index) => {
      const status = statuses[index] || 'skipped';
      if (status === 'applied') return { ...cue, grammarPolish: {
        originalText: cues[index].text,
        originalTimingSource: cues[index].timingSource,
        status,
      } };
      return { ...cue, grammarPolish: { status } };
    });
    return { segments: annotated, applied, skipped: cues.length - applied,
      unavailable, limited, summary: { statuses: summarizeStatuses(statuses) }, metrics: metrics() };
  }

  // If nothing was rewritten, return the original editor rows byte-for-byte.
  // This keeps an opt-in no-op from changing the saved row layout.
  return { segments, applied: 0, skipped: cues.length, unavailable, limited,
    summary: { statuses: summarizeStatuses(statuses) }, metrics: metrics() };
}
