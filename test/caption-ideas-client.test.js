import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('caption ideas route and sidebar entry are wired into the application', async () => {
  const [app, sidebar, authRoute] = await Promise.all([
    read('client/src/App.jsx'),
    read('client/src/components/Sidebar.jsx'),
    read('src/routes/auth.js'),
  ]);

  assert.match(app, /path="\/caption-ideas" element=\{<CaptionIdeasPage \/>\}/);
  assert.match(sidebar, /to="\/caption-ideas"/);
  assert.match(sidebar, /자막_아이디어/);
  assert.match(authRoute, /'\/caption-ideas'/);
});

test('caption ideas UI exposes the agreed five-use flow and accessible controls', async () => {
  const page = await read('client/src/pages/CaptionIdeasPage.jsx');

  assert.match(page, /maxLength=\{500\}/);
  assert.match(page, /useState\('entertainment'\)/);
  assert.match(page, /role="radiogroup"/);
  assert.match(page, /role="radio"/);
  assert.match(page, /event\.key === 'ArrowRight'/);
  assert.match(page, /event\.key !== 'ArrowLeft'/);
  assert.match(page, /1분으로 생성 5회 시작/);
  assert.match(page, /1분 사용하고 시작/);
  assert.match(page, /자막 아이디어 3개가 완성되었습니다/);
  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /returnPath="\/caption-ideas"/);
  assert.match(page, /statusUserId !== user\.id/);
  assert.match(page, /generationError\.status === 409/);
});

test('server rate limits only generation requests and completes billing after model success', async () => {
  const [server, route, store] = await Promise.all([
    read('src/server.js'),
    read('src/routes/caption-ideas.js'),
    read('src/services/caption-idea-store.js'),
  ]);

  assert.match(server, /const captionIdeasLimiter = rateLimit\([\s\S]*max: 5/);
  assert.match(server, /app\.post\('\/api\/caption-ideas', captionIdeasLimiter\)/);
  assert.ok(
    route.indexOf('generateCaptionIdeas(text, mode)')
      < route.indexOf('completeCaptionIdeaRequest({'),
    'billing completion must run only after a valid model response',
  );
  assert.match(store, /ideas_expires_at/);
  assert.match(route, /expiresAt > Date\.now\(\)/);
  assert.doesNotMatch(route, /console\.[a-z]+\([^\n]*(req\.body|normalizedText|generation\.ideas)/i);
});

test('terms and privacy disclose pack billing and temporary result retention', async () => {
  const [terms, privacy, usage] = await Promise.all([
    read('client/src/pages/TermsPage.jsx'),
    read('client/src/pages/PrivacyPage.jsx'),
    read('client/src/pages/UsagePage.jsx'),
  ]);

  assert.match(terms, /생성 5회를 한 묶음/);
  assert.match(terms, /실패한[\s\S]*차감하지 않습니다/);
  assert.match(privacy, /서비스 데이터베이스에 저장하지 않습니다/);
  assert.match(privacy, /24시간 보관한 뒤 삭제/);
  assert.match(usage, /action === 'caption_ideas'/);
});
