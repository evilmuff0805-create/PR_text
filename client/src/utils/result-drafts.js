export const resultDraftKey = (ownerId, logId) => `resultEdits:v2:${ownerId}:${logId}`;
export const lastResultKey = (ownerId) => `lastResult:v2:${ownerId}`;
export const isTranscriptionLogId = (value) => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
export const segmentText = (segments) => segments.map((segment) => segment.text ?? '').join('\n');
export const draftLines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '').split('\n');

export function readResultDraft(storage, ownerId, logId, segments) {
  if (!ownerId || !logId || !Array.isArray(segments)) return null;
  try {
    const draft = JSON.parse(storage.getItem(resultDraftKey(ownerId, logId)) || 'null');
    if (draft?.ownerId !== ownerId || draft.logId !== logId || !Array.isArray(draft.segments) || draft.segments.length !== segments.length) return null;
    if (draft.segments.some((segment, index) => segment.start !== segments[index].start || segment.end !== segments[index].end || typeof segment.text !== 'string')) return null;
    const serverText = segmentText(segments);
    if (draft.baseText !== serverText && segmentText(draft.segments) !== serverText) return null;
    return { ...draft, segments: segments.map((segment, index) => ({ ...segment, text: draft.segments[index].text })) };
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
    if (segmentText(draft.segments) !== segmentText(log.segments || [])) await saveLog(item.transcriptionLogId, draft.segments);
    writeResultDraft(storage, ownerId, item.transcriptionLogId, { ...draft, baseText: segmentText(draft.segments) });
  }
}
