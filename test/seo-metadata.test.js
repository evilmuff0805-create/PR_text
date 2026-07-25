import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../client/index.html', import.meta.url);
const introUrl = new URL('../client/src/pages/IntroPage.jsx', import.meta.url);
const guideUrl = new URL('../client/src/pages/GuidePage.jsx', import.meta.url);
const ogImageUrl = new URL('../client/public/og-image.jpg', import.meta.url);
const robotsUrl = new URL('../client/public/robots.txt', import.meta.url);
const sitemapUrl = new URL('../client/public/sitemap.xml', import.meta.url);

test('landing metadata matches the no-translation product behavior', async () => {
  const html = await readFile(indexUrl, 'utf8');

  assert.match(html, /원문의 말투를 지킨 자막/);
  assert.doesNotMatch(html, /영어 번역 지원|자동 번역/);
  assert.equal((html.match(/name="naver-site-verification"/g) || []).length, 1);
  assert.equal((html.match(/name="google-site-verification"/g) || []).length, 1);
});

test('public guidance documents verified CapCut SRT compatibility', async () => {
  const [html, intro, guide] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(introUrl, 'utf8'),
    readFile(guideUrl, 'utf8'),
  ]);

  assert.match(html, /CapCut SRT/);
  assert.match(intro, /CapCut 타임코드 호환 확인/);
  assert.match(guide, /CapCut에서 자막과 타임코드 호환을 확인했습니다/);
});

test('social metadata references a real 1200 by 630 JPEG preview', async () => {
  const [html, image] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    stat(ogImageUrl),
  ]);

  assert.ok(image.size > 0);
  assert.match(html, /property="og:image" content="https:\/\/pr-text\.com\/og-image\.jpg"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /property="og:image:alt"/);
  assert.match(html, /name="twitter:image:alt"/);

  const structuredData = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(structuredData);
  const application = JSON.parse(structuredData[1]);
  assert.equal(application['@type'], 'WebApplication');
  assert.equal(application.url, 'https://pr-text.com/');
});

test('crawler files avoid redirect and private workflow URLs', async () => {
  const [robots, sitemap] = await Promise.all([
    readFile(robotsUrl, 'utf8'),
    readFile(sitemapUrl, 'utf8'),
  ]);

  assert.doesNotMatch(sitemap, /https:\/\/pr-text\.com\/intro/);
  assert.match(robots, /Disallow: \/settings/);
  assert.match(robots, /Disallow: \/usage/);
  assert.match(robots, /Disallow: \/redownload/);
  assert.match(robots, /Disallow: \/auth\//);
});
