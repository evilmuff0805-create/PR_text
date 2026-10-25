import { normalizeReviewMemory, normalizeSubtitleReview, subtitleEditSignature } from './subtitle-review.js';

export const resultDraftKey = (ownerId, logId) => `resultEdits:v2:${ownerId}:${logId}`;
export const lastResultKey = (ownerId) => `lastResult:v2:${ownerId}`;
export const isTranscriptionLogId = (value) => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
export const segmentText = (segments) => segments.map((segment) => segment.text ?? '').join('\n');
export const draftLines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '').split('\n');

const ownsResult = (record, ownerId) => Boolean(ownerId && record?.ownerId === ownerId && isTranscriptionLogId(record.transcriptionLogId) && Array.isArray(record.segments));
export const resultSnapshotSignature = (record) => JSON.stringify(record?.segments ?? []);

// An acknowledged local save may supersede only its exact original route/context snapshot.
// Explicitly fetched server records and batch overrides remain authoritative.
export function resolveSavedResult(storage, ownerId, incoming, serverVerified = false) {
  let cached;
  try { cached = JSON.parse(storage.getItem(lastResultKey(ownerId)) || 'null'); } catch { cached = null; }
  if (!ownsResult(cached, ownerId)) cached = null;
  if (!incoming) return cached;
  if (!ownsResult(incoming, ownerId)) return null;
  if (serverVerified || !cached || String(cached.transcriptionLogId) !== String(incoming.transcriptionLogId)) return incoming;
  const anchor = cached.savedEditCache;
  if (anchor?.version === 1 && anchor.sourceSignature === resultSnapshotSignature(incoming)
    && anchor.savedSignature === resultSnapshotSignature(cached)) return cached;
  return incoming;
}

export function cacheSavedResult(storage, ownerId, logId, incoming, segments, expectedCacheSignature) {
  if (!ownsResult(incoming, ownerId) || String(incoming.transcriptionLogId) !== String(logId)) return null;
  try {
    const raw = storage.getItem(lastResultKey(ownerId));
    const cached = raw ? JSON.parse(raw) : incoming;
    if (!ownsResult(cached, ownerId) || String(cached.transcriptionLogId) !== String(logId)
      || resultSnapshotSignature(cached) !== expectedCacheSignature) return null;
    if (!Array.isArray(segments) || segments.length !== cached.segments.length
      || segments.some((segment, index) => segment.start !== cached.segments[index].start || segment.end !== cached.segments[index].end)) return null;
    const prior = cached.savedEditCache;
    const sourceSignature = prior?.version === 1 && prior.savedSignature === resultSnapshotSignature(cached)
      ? prior.sourceSignature : resultSnapshotSignature(incoming);
    const saved = { ...cached, segments, text: segmentText(segments) };
    saved.savedEditCache = { version: 1, sourceSignature, savedSignature: resultSnapshotSignature(saved) };
    storage.setItem(lastResultKey(ownerId), JSON.stringify(saved));
    return saved;
  } catch { return null; }
}

export function readResultDraft(storage, ownerId, logId, segments) {
  if (!ownerId || !logId || !Array.isArray(segments)) return null;
  try {
    const draft = JSON.parse(storage.getItem(resultDraftKey(ownerId, logId)) || 'null');
    if (draft?.ownerId !== ownerId || draft.logId !== logId || !Array.isArray(draft.segments) || draft.segments.length !== segments.length) return null;
    if (draft.segments.some((segment, index) => segment.start !== segments[index].start || segment.end !== segments[index].end || typeof segment.text !== 'string')) return null;
    const serverText = segmentText(segments);
    if (draft.baseSignature !== undefined) {
      const serverSignature = subtitleEditSignature(segments);
      if (draft.baseSignature !== serverSignature && subtitleEditSignature(draft.segments) !== serverSignature) return null;
    } else if (draft.baseText !== serverText && segmentText(draft.segments) !== serverText) return null;
    return { ...draft, reviewMemory: normalizeReviewMemory(draft.reviewMemory), segments: segments.map((segment, index) => {
      const edited = draft.segments[index];
      const review = normalizeSubtitleReview(edited.subtitleReview ?? segment.subtitleReview, edited.text);
      return { ...segment, text: edited.text, ...(review ? { subtitleReview: review } : {}) };
    }) };
  } catch { return null; }
}

export function writeResultDraft(storage, ownerId, logId, draft) {
  if (!ownerId || !logId) return false;
  try { storage.setItem(resultDraftKey(ownerId, logId), JSON.stringify({ ...draft, ownerId, logId })); return true; }
  catch { return false; }
}

export async function flushStoredBatchDrafts({ items, storage, ownerId, fetchLog, saveLog }) {
  for (const item of items) {
    if (item.status !== 'completed' || !item.transcriptionLogId) continue;
    let raw;
    try { raw = storage.getItem(resultDraftKey(ownerId, item.transcriptionLogId)); } catch { continue; }
    if (!raw) continue;
    const log = await fetchLog(item.transcriptionLogId);
    const draft = readResultDraft(storage, ownerId, item.transcriptionLogId, log.segments || []);
    if (!draft) continue;
    if (draft.fullTextDraft !== undefined && draftLines(draft.fullTextDraft).length !== draft.segments.length) {
      throw new Error(`${item.label || item.filename}: 편집한 줄 수가 자막 수와 다릅니다. 해당 결과에서 먼저 수정해 주세요.`);
    }
    if (subtitleEditSignature(draft.segments) !== subtitleEditSignature(log.segments || [])) await saveLog(item.transcriptionLogId, draft.segments);
    writeResultDraft(storage, ownerId, item.transcriptionLogId, { ...draft, baseText: segmentText(draft.segments), baseSignature: subtitleEditSignature(draft.segments) });
  }
}
