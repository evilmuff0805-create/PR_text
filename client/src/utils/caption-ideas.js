export const CAPTION_IDEA_MODES = [
  { id: 'entertainment', label: '예능', hint: '댓글 같은 구어체와 가벼운 반전으로 재미를 살립니다. 앞말과 행동에 근거한 웃음 포인트를 찾습니다.' },
  { id: 'situation', label: '상황', hint: '명사구와 자연스러운 한자어로 간결하게 정리합니다. 주체·목적·조건은 놓치지 않습니다.' },
  { id: 'emphasis', label: '강조', hint: '근거 있는 평가와 힘 있는 리듬으로 핵심을 짚습니다. 수량·조건·가능성은 그대로 살립니다.' },
  { id: 'emotion', label: '감성', hint: '따뜻함과 가벼운 시성을 살립니다. 관계·변화·상실·바람을 장면에 맞게 담습니다.' },
];

export const SCENE_TEXT_MAX_CHARS = 500;
const CONTEXT_LINES = 2;

export function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    const nibble = value === 'x' ? random : (random & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

// 초점은 자르지 않는다. 긴 편집 대사에서만 사용자가 고른 원문 일부를 받는다.
export function buildSceneContext(segments, focusIndex, selectedText = '') {
  const sourceText = Array.isArray(segments) && Number.isInteger(focusIndex)
    && focusIndex >= 0 && focusIndex < segments.length
    ? String(segments[focusIndex]?.text ?? '').trim() : '';
  const requiresSelection = Array.from(sourceText).length > SCENE_TEXT_MAX_CHARS;
  const selected = typeof selectedText === 'string' ? selectedText.trim() : '';
  const text = requiresSelection && selected ? selected : sourceText;
  const base = { text, sourceText, context: { before: [], after: [] }, requiresSelection,
    omittedBefore: 0, omittedAfter: 0, totalChars: Array.from(text).length };
  if (!sourceText) return { ...base, valid: false, reason: 'empty_focus' };
  if (requiresSelection && (!selected || !sourceText.includes(selected)
    || Array.from(selected).length > SCENE_TEXT_MAX_CHARS)) {
    return { ...base, valid: false, reason: 'focus_too_long' };
  }

  const before = [], after = [];
  for (let index = Math.max(0, focusIndex - CONTEXT_LINES);
    index <= Math.min(segments.length - 1, focusIndex + CONTEXT_LINES); index += 1) {
    if (index === focusIndex) continue;
    const value = String(segments[index]?.text ?? '').replace(/\s+/g, ' ').trim();
    if (value) (index < focusIndex ? before : after).push({ text: value, distance: Math.abs(index - focusIndex) });
  }
  const beforeCount = before.length, afterCount = after.length;
  let totalChars = Array.from(text).length
    + [...before, ...after].reduce((sum, row) => sum + Array.from(row.text).length, 0);
  while (totalChars > SCENE_TEXT_MAX_CHARS && (before.length || after.length)) {
    const previous = before[0], following = after[after.length - 1];
    const removed = following && (!previous || following.distance >= previous.distance)
      ? after.pop() : before.shift();
    totalChars -= Array.from(removed.text).length;
  }
  return { ...base, valid: true, totalChars,
    context: { before: before.map((row) => row.text), after: after.map((row) => row.text) },
    omittedBefore: beforeCount - before.length, omittedAfter: afterCount - after.length };
}

export function isCaptionIdeaResult(data) {
  return Array.isArray(data?.ideas) && data.ideas.length === 3
    && data.ideas.every((idea) => typeof idea === 'string' && idea.trim()
      && Array.from(idea).length <= 28) && new Set(data.ideas).size === 3;
}

// 입력은 메모리에만 둔다. 입력 변경 세대도 비교해 A→B→A 뒤의 옛 응답을 막는다.
export function createCaptionRequestTracker() {
  let scope = null, key = null, revision = 0, pending = null, inFlight = null;
  const tracker = {
    sync(snapshot) {
      const nextScope = JSON.stringify([snapshot.ownerId ?? null, snapshot.logId ?? null]);
      const nextKey = JSON.stringify(snapshot);
      if (nextScope !== scope) { scope = nextScope; inFlight = null; pending = null; revision += 1; }
      if (nextKey !== key) { key = nextKey; pending = null; revision += 1; }
      return key;
    },
    invalidate() { revision += 1; key = null; pending = null; },
    begin(snapshot) {
      if (JSON.stringify(snapshot) !== key || inFlight) return null;
      const ticket = { key, revision, requestId: pending?.key === key ? pending.requestId : createRequestId() };
      inFlight = ticket; pending = ticket;
      return ticket;
    },
    isCurrent(ticket) { return inFlight === ticket && ticket.key === key && ticket.revision === revision; },
    complete(ticket) { if (pending === ticket) pending = null; },
    finish(ticket) { if (inFlight !== ticket) return false; inFlight = null; return true; },
    reset() { revision += 1; key = null; scope = null; pending = null; inFlight = null; },
  };
  return tracker;
}
