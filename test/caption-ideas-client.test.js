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

test('caption ideas page shows the optimized three-mode example image', async () => {
  const [page, asset] = await Promise.all([
    read('client/src/pages/CaptionIdeasPage.jsx'),
    readFile(new URL('../client/public/caption-ideas-example.webp', import.meta.url)),
  ]);

  assert.match(page, /src="\/caption-ideas-example\.webp"/);
  assert.match(page, /alt="밤 11시 야근 장면을 예능, 상황, 감성 자막으로 다르게 표현한 예시"/);
  assert.match(page, /width="1600"/);
  assert.match(page, /height="893"/);
  assert.equal(asset.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(asset.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.ok(asset.byteLength < 100_000, `example image is too large: ${asset.byteLength} bytes`);
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

test('terms and privacy disclose pack billing and 90-day result history retention', async () => {
  const [terms, privacy, usage] = await Promise.all([
    read('client/src/pages/TermsPage.jsx'),
    read('client/src/pages/PrivacyPage.jsx'),
    read('client/src/pages/UsagePage.jsx'),
  ]);

  assert.match(terms, /생성 5회를 한 묶음/);
  assert.match(terms, /실패한[\s\S]*차감하지 않습니다/);
  assert.match(privacy, /서비스 데이터베이스에 저장하지 않습니다/);
  assert.match(privacy, /생성 결과 3개는[\s\S]*최대 90일 보관한 뒤 삭제/);
  assert.match(usage, /action === 'caption_ideas'/);
});

test('usage page exposes user-scoped caption idea history with copy controls', async () => {
  const [page, route, store] = await Promise.all([
    read('client/src/pages/UsagePage.jsx'),
    read('src/routes/caption-ideas.js'),
    read('src/services/caption-idea-store.js'),
  ]);

  assert.match(route, /router\.get\('\/history', featureEnabled, authMiddleware/);
  assert.match(route, /listCaptionIdeaHistory\(req\.user\.id/);
  assert.match(store, /\.eq\('user_id', userId\)/);
  assert.match(store, /\.gt\('ideas_expires_at'/);
  assert.match(page, /자막 아이디어 내역/);
  assert.match(page, /최근 90일 동안 생성한/);
  assert.match(page, /navigator\.clipboard\.writeText\(idea\)/);
  assert.match(page, /getCaptionModeLabel/);
});
