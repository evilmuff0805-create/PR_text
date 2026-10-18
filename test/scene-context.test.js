import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildSceneContext, CAPTION_IDEA_MODES, SCENE_TEXT_MAX_CHARS, createCaptionRequestTracker } from '../client/src/utils/caption-ideas.js';

const segments = Array.from({ length: 6 }, (_, index) => ({ start: index, end: index + 0.5, text: `${index + 1}번째 대사` }));

test('scene context separates an intact focus from two nearby lines on each side', () => {
  const source = structuredClone(segments);
  const scene = buildSceneContext(source, 2);
  assert.equal(scene.text, '3번째 대사');
  assert.deepEqual(scene.context, { before: ['1번째 대사', '2번째 대사'], after: ['4번째 대사', '5번째 대사'] });
  assert.equal(scene.valid, true);
  assert.deepEqual(source, segments);
  assert.deepEqual(buildSceneContext(segments, 0).context.before, []);
  assert.deepEqual(buildSceneContext(segments, 5).context.after, []);
});

test('the 500 codepoint budget drops distant whole context lines without slicing the focus', () => {
  const source = [{ text: '가'.repeat(100) }, { text: '나'.repeat(100) }, { text: '초'.repeat(300) }, { text: '다'.repeat(100) }, { text: '라'.repeat(100) }];
  const scene = buildSceneContext(source, 2);
  assert.equal(scene.text, source[2].text);
  assert.deepEqual(scene.context, { before: [source[1].text], after: [source[3].text] });
  assert.equal(scene.totalChars, SCENE_TEXT_MAX_CHARS);
  assert.equal(scene.omittedBefore, 1);
  assert.equal(scene.omittedAfter, 1);
  const exact = buildSceneContext([{ text: '> ' + '😀'.repeat(498) }], 0);
  assert.equal(exact.text, '> ' + '😀'.repeat(498));
  assert.equal(exact.totalChars, 500);
  assert.equal(exact.valid, true);
});

test('long focus requires an explicit original substring and never truncates the source', () => {
  const text = '가'.repeat(250) + '조건은 그대로 유지해요' + '나'.repeat(250);
  const blocked = buildSceneContext([{ text }], 0);
  assert.equal(blocked.valid, false);
  assert.equal(blocked.requiresSelection, true);
  assert.equal(blocked.text, text);
  const selected = buildSceneContext([{ text }], 0, '조건은 그대로 유지해요');
  assert.equal(selected.valid, true);
  assert.equal(selected.text, '조건은 그대로 유지해요');
  assert.equal(selected.sourceText, text);
  assert.equal(buildSceneContext([{ text }], 0, '원문에 없는 내용').valid, false);
  assert.equal(buildSceneContext([{ text: '가'.repeat(501) }], 0, '가'.repeat(501)).valid, false);
});

test('empty selections are blocked and context line breaks are presentation-only normalized', () => {
  for (const index of [-1, 99, null]) assert.equal(buildSceneContext(segments, index).valid, false);
  assert.equal(buildSceneContext([], 0).valid, false);
  const source = [{ text: '앞\n대사' }, { text: '가  네네네 3.5kg' }, { text: '뒤\t대사' }];
  const before = structuredClone(source), scene = buildSceneContext(source, 1);
  assert.equal(scene.text, source[1].text);
  assert.deepEqual(scene.context, { before: ['앞 대사'], after: ['뒤 대사'] });
  assert.deepEqual(source, before);
});

test('request tracker reuses only an unresolved unchanged snapshot and rejects old generations', () => {
  const tracker = createCaptionRequestTracker();
  const first = { ownerId: 'owner', logId: 1, focusIndex: 0, mode: 'situation', text: '첫 대사', context: { before: [], after: [] } };
  tracker.sync(first);
  const a = tracker.begin(first);
  assert.equal(tracker.begin(first), null);
  assert.equal(tracker.finish(a), true);
  const retry = tracker.begin(first);
  assert.equal(retry.requestId, a.requestId);
  tracker.complete(retry); tracker.finish(retry);
  const next = tracker.begin(first);
  assert.notEqual(next.requestId, a.requestId);
  tracker.invalidate(); tracker.sync({ ...first, mode: 'emotion' }); tracker.sync(first);
  assert.equal(tracker.isCurrent(next), false);
  tracker.finish(next);
  const changed = tracker.begin(first);
  assert.notEqual(changed.requestId, next.requestId);
  tracker.sync({ ...first, ownerId: 'another-owner' });
  assert.equal(tracker.isCurrent(changed), false);
  assert.equal(tracker.begin(first), null);
});

test('both screens keep the four existing modes and use the shared tracker', async () => {
  assert.deepEqual(CAPTION_IDEA_MODES.map(({ id }) => id), ['entertainment', 'situation', 'emphasis', 'emotion']);
  for (const file of ['CaptionIdeasPage.jsx', 'ResultPage.jsx']) {
    const page = await readFile(new URL(`../client/src/pages/${file}`, import.meta.url), 'utf8');
    assert.match(page, /createCaptionRequestTracker/);
    assert.doesNotMatch(page, /function createRequestId/);
  }
});

test('the editor wires structured context into a dedicated route and keeps full-width presentation', async () => {
  const page = await readFile(new URL('../client/src/pages/ResultPage.jsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../client/src/global.css', import.meta.url), 'utf8');
  assert.match(page, /buildSceneContext\(editedSegments, ideaIndex, selectedFocus\)/);
  assert.match(page, /fetch\('\/api\/caption-ideas\/context'/);
  assert.match(page, /selectEditorMode\('segments'\)/);
  assert.match(page, /성공 5회당 변환 시간 1분이 차감됩니다/);
  const panel = css.slice(css.indexOf('.segment-idea-panel {'), css.indexOf('.segment-idea-panel__hint'));
  assert.match(panel, /grid-column: 1 \/ -1;/);
});
