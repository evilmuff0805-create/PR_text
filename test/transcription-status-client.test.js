import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readClient = (path) => readFile(new URL(`../client/src/${path}`, import.meta.url), 'utf8');

test('transcription state stays mounted above app routes', async () => {
  const [main, provider, home] = await Promise.all([
    readClient('main.jsx'),
    readClient('contexts/TranscriptionContext.jsx'),
    readClient('pages/HomePage.jsx'),
  ]);

  assert.match(main, /<TranscriptionProvider>[\s\S]*<App \/>[\s\S]*<\/TranscriptionProvider>/);
  assert.match(provider, /pendingDiarizationJob:/);
  assert.match(provider, /\/api\/transcribe\/jobs\/\$\{job\.activeJobId\}/);
  assert.match(provider, /window\.setInterval\(pollJob, 5_000\)/);
  assert.match(provider, /locationRef\.current === '\/transcribe'/);
  assert.match(provider, /locationRef\.current !== '\/transcribe'/);
  assert.match(home, /useTranscription\(\)/);
  assert.doesNotMatch(home, /estimatedDiarizationSeconds|estimatedProgress|elapsedSeconds/);
});

test('processing and completion UI is indeterminate, announced, and non-disruptive', async () => {
  const [provider, home, styles] = await Promise.all([
    readClient('contexts/TranscriptionContext.jsx'),
    readClient('pages/HomePage.jsx'),
    readClient('global.css'),
  ]);

  assert.match(home, />PROCESSING</);
  assert.match(home, /transcription-processing__spinner/);
  assert.match(home, /변환이 완료되면 알림을 보내드립니다/);
  assert.match(home, /다른 메뉴로 이동해도 변환은 계속됩니다/);
  assert.doesNotMatch(home, /role="progressbar"|예상 진행 상태|경과 \{/);
  assert.match(provider, /className=\{`transcription-notice/);
  assert.match(provider, /aria-live=\{notice\.type === 'error' \? 'assertive' : 'polite'\}/);
  assert.match(provider, />\s*결과 보기\s*</);
  assert.match(provider, /aria-label="변환 알림 닫기"/);
  assert.match(styles, /@keyframes processing-spin/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('ordinary upload stays owned by the app-level provider across route changes', async () => {
  const provider = await readClient('contexts/TranscriptionContext.jsx');

  assert.match(provider, /new XMLHttpRequest\(\)/);
  assert.match(provider, /const startTranscription = useCallback/);
  assert.match(provider, /shouldWarn = job\.status === 'uploading'/);
  assert.match(provider, /job\.status === 'processing' && !job\.activeJobId/);
});
