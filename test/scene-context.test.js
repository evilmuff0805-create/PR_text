import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSceneText,
  CAPTION_IDEA_MODES,
  SCENE_TEXT_MAX_CHARS,
} from '../client/src/utils/caption-ideas.js';

const segments = [
  { text: '첫 번째 대사' },
  { text: '두 번째 대사' },
  { text: '세 번째 대사' },
  { text: '네 번째 대사' },
  { text: '다섯 번째 대사' },
  { text: '여섯 번째 대사' },
];

test('scene text surrounds the focused line with nearby dialogue', () => {
  const scene = buildSceneText(segments, 2);

  assert.equal(scene, [
    '첫 번째 대사',
    '두 번째 대사',
    '> 세 번째 대사',
    '네 번째 대사',
    '다섯 번째 대사',
  ].join('\n'));
});

test('the focused line is marked so the model knows what to caption', () => {
  const scene = buildSceneText(segments, 0);

  assert.match(scene, /^> 첫 번째 대사$/m);
  assert.equal((scene.match(/^> /gm) || []).length, 1);
});

test('context is clipped at the edges without breaking', () => {
  assert.match(buildSceneText(segments, 0), /^> 첫 번째 대사/);
  assert.match(buildSceneText(segments, segments.length - 1), /> 여섯 번째 대사$/);
});

test('long dialogue is trimmed to the server input limit, keeping the focus line', () => {
  const long = Array.from({ length: 9 }, (_, index) => ({ text: `${index}${'가'.repeat(200)}` }));
  const scene = buildSceneText(long, 4);

  assert.ok(Array.from(scene).length <= SCENE_TEXT_MAX_CHARS);
  assert.match(scene, /^> 4/m);
});

test('empty or out of range selections produce nothing to send', () => {
  assert.equal(buildSceneText(segments, -1), '');
  assert.equal(buildSceneText(segments, 99), '');
  assert.equal(buildSceneText([{ text: '   ' }], 0), '');
  assert.equal(buildSceneText([], 0), '');
});

test('the editor offers the same modes as the standalone page', () => {
  assert.deepEqual(
    CAPTION_IDEA_MODES.map((mode) => mode.id),
    ['entertainment', 'situation', 'emphasis', 'emotion'],
  );
});

test('the editor wires each segment to the existing caption idea endpoint', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../client/src/pages/ResultPage.jsx', import.meta.url), 'utf8');

  assert.match(page, /buildSceneText\(editedSegments, ideaIndex\)/);
  assert.match(page, /fetch\('\/api\/caption-ideas'/);
  assert.match(page, /requestId: createRequestId\(\)/);
  assert.match(page, /자막 아이디어\s*<\/button>/);
  // 과금 규칙을 화면에서 알려준다.
  assert.match(page, /성공 5회당 변환 시간 1분이 차감됩니다/);
});

test('the full text tab points to where the idea button lives', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../client/src/pages/ResultPage.jsx', import.meta.url), 'utf8');

  // 버튼이 구간별 편집에만 있어 전체 텍스트 탭에서 그냥 지나치기 쉬웠다.
  assert.match(page, /result-editor-tip/);
  assert.match(page, /setEditorMode\('segments'\)/);
});

test('both screens share one mode list and request id helper', async () => {
  const { readFile } = await import('node:fs/promises');
  const standalone = await readFile(new URL('../client/src/pages/CaptionIdeasPage.jsx', import.meta.url), 'utf8');

  assert.match(standalone, /from '\.\.\/utils\/caption-ideas\.js'/);
  // 모드 목록과 requestId 생성이 페이지마다 따로 있으면 어긋난다.
  assert.doesNotMatch(standalone, /function createRequestId/);
  assert.doesNotMatch(standalone, /const MODES = \[/);
});
