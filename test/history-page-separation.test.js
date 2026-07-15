import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('../client/src/App.jsx', import.meta.url);
const sidebarUrl = new URL('../client/src/components/Sidebar.jsx', import.meta.url);
const usagePageUrl = new URL('../client/src/pages/UsagePage.jsx', import.meta.url);
const redownloadPageUrl = new URL('../client/src/pages/RedownloadPage.jsx', import.meta.url);

test('usage and transcription history have separate routes and navigation', async () => {
  const [app, sidebar] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(sidebarUrl, 'utf8'),
  ]);

  assert.match(app, /path="\/usage" element=\{<UsagePage \/>\}/);
  assert.match(app, /path="\/redownload" element=\{<RedownloadPage \/>\}/);
  assert.match(sidebar, /to="\/usage"[\s\S]*?사용 내역/);
  assert.match(sidebar, /to="\/redownload"[\s\S]*?변환_재다운로드/);
});

test('each history page requests only the records it renders', async () => {
  const [usagePage, redownloadPage] = await Promise.all([
    readFile(usagePageUrl, 'utf8'),
    readFile(redownloadPageUrl, 'utf8'),
  ]);

  assert.match(usagePage, /type=usage/);
  assert.doesNotMatch(usagePage, /type=all|type=transcription|transcriptionLogs/);

  assert.match(redownloadPage, /type=transcription/);
  assert.doesNotMatch(redownloadPage, /type=all|type=usage/);
  assert.match(redownloadPage, /\/api\/auth\/transcription\/\$\{logId\}/);
  assert.match(redownloadPage, /fetch\('\/api\/download'/);
  assert.match(redownloadPage, /\['srt', 'txt', 'ass'\]/);
});
