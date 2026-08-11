import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('full-text editing never shifts subtitles onto the wrong timecodes', async () => {
  const page = await read('client/src/pages/ResultPage.jsx');

  // 줄 수가 자막 수와 정확히 같을 때만 반영한다.
  assert.match(page, /function canApplyFullText\(segments, editedText\)/);
  assert.match(page, /splitTextLines\(editedText\)\.length === segments\.length/);
  assert.match(page, /if \(canApplyFullText\(editedSegments, nextText\)\) \{/);

  // 넘치는 줄을 마지막 세그먼트에 몰아넣던 처리는 사라져야 한다.
  assert.doesNotMatch(page, /overflowText/);

  // textarea는 사용자가 친 원문을 그대로 보여준다(자막에서 되계산하지 않는다).
  assert.match(page, /value=\{fullTextDraft\}/);
});

test('mismatched line counts warn the user and block every download path', async () => {
  const page = await read('client/src/pages/ResultPage.jsx');

  assert.match(page, /const lineCountMismatch = /);
  assert.match(page, /role="alert"/);
  assert.match(page, /줄 수가 자막 수와 다릅니다/);
  assert.match(page, /disabled=\{downloading \|\| lineCountMismatch\}/);
  // 버튼 외의 경로로도 파일이 나가지 않아야 한다.
  assert.match(page, /if \(lineCountMismatch\) return;/);
});

test('edits and speaker colors survive a page refresh', async () => {
  const page = await read('client/src/pages/ResultPage.jsx');

  assert.match(page, /const EDITS_STORAGE_KEY = 'lastResultEdits';/);
  assert.match(page, /sessionStorage\.setItem\(EDITS_STORAGE_KEY/);
  assert.match(page, /readStoredEdits\(segments\)/);
  // 다른 변환 결과의 편집본이 섞이면 안 된다.
  assert.match(page, /parsed\?\.signature !== resultSignature\(segments\)/);
});

test('ASS controls speak the same 1080p coordinate system as the generator', async () => {
  const [page, subtitle] = await Promise.all([
    read('client/src/pages/ResultPage.jsx'),
    read('src/services/subtitle.js'),
  ]);

  assert.match(page, /const ASS_PLAY_RES_X = 1920;/);
  assert.match(page, /const ASS_DEFAULT_FONT_SIZE = 48;/);
  assert.match(subtitle, /export const ASS_DEFAULT_FONT_SIZE = 48;/);
  assert.match(page, /useState\(ASS_DEFAULT_FONT_SIZE\)/);
  // 슬라이더 상한이 서버 검증(200) 안에 들어와야 한다.
  assert.match(page, /max="96"/);
  assert.match(page, /min="24"/);
});
