import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { llmsTxt, publicPageByPath, publicPages } from '../client/src/public-pages.js';
import { supportFaqs } from '../client/src/content/support-faqs.js';
import { guideSteps } from '../client/src/content/guide-steps.js';

const schemaFor = (path) => publicPageByPath.get(path).structuredData;

test('every structured data block declares a schema.org context and type', () => {
  for (const page of publicPages) {
    if (!page.structuredData) continue;
    assert.equal(page.structuredData['@context'], 'https://schema.org', page.path);
    assert.ok(page.structuredData['@type'], `${page.path} needs an @type`);
  }
});

test('FAQ schema questions and anchors match the shared support answers', () => {
  const faq = schemaFor('/support');

  assert.equal(faq['@type'], 'FAQPage');
  assert.equal(faq['@id'], 'https://pr-text.com/support#faq');
  assert.equal(faq.url, 'https://pr-text.com/support');
  assert.equal(faq.mainEntity.length, supportFaqs.length);
  assert.equal(new Set(supportFaqs.map((item) => item.id)).size, supportFaqs.length);
  for (const [index, entry] of faq.mainEntity.entries()) {
    const source = supportFaqs[index];
    const itemUrl = `https://pr-text.com/support#${source.id}`;

    assert.equal(entry['@type'], 'Question');
    assert.equal(entry['@id'], itemUrl);
    assert.equal(entry.url, itemUrl);
    assert.equal(entry.name, source.question);
    assert.equal(entry.acceptedAnswer.text, source.answer);
    assert.ok(source.id.length > 0);
    assert.ok(source.relatedLinks.length > 0);
    for (const link of source.relatedLinks) {
      const destination = new URL(link.href, 'https://pr-text.com');
      assert.equal(destination.origin, 'https://pr-text.com');
      assert.ok(publicPages.some((page) => page.path === destination.pathname), link.href);
      if (destination.pathname === '/support') {
        assert.ok(supportFaqs.some((item) => item.id === destination.hash.slice(1)), link.href);
      }
      assert.ok(link.label.length > 0);
    }
  }
});

test('public server rendering includes shared answers on support, guide, and landing pages', async () => {
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../client/vite.config.js', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });

  try {
    const { renderPublicPage } = await vite.ssrLoadModule('/src/entry-server.jsx');
    const supportHtml = renderPublicPage('/support');
    for (const faq of supportFaqs) {
      assert.ok(supportHtml.includes(`id="${faq.id}"`), `support anchor ${faq.id} is missing`);
      assert.ok(supportHtml.includes(faq.question), `support question ${faq.id} is missing`);
      assert.ok(supportHtml.includes(faq.answer), `support answer ${faq.id} is missing`);
    }

    const guideHtml = renderPublicPage('/guide');
    for (const id of ['create-subtitles', 'output-formats', 'premiere-pro', 'edit-subtitles', 'source-language-translation']) {
      const faq = supportFaqs.find((item) => item.id === id);
      assert.ok(guideHtml.includes(faq.question), `guide question ${id} is missing`);
      assert.ok(guideHtml.includes(faq.answer), `guide answer ${id} differs from support`);
    }

    const landingHtml = renderPublicPage('/');
    for (const id of ['create-subtitles', 'premiere-pro', 'edit-subtitles']) {
      const faq = supportFaqs.find((item) => item.id === id);
      assert.ok(landingHtml.includes(faq.question), `landing question ${id} is missing`);
      assert.ok(landingHtml.includes(faq.answer), `landing answer ${id} differs from support`);
      assert.ok(landingHtml.includes(`/support#${id}`), `landing support link ${id} is missing`);
    }
  } finally {
    await vite.close();
  }
});

test('support hash navigation opens and scrolls to a public FAQ anchor', async () => {
  const source = await readFile(new URL('../client/src/pages/SupportPage.jsx', import.meta.url), 'utf8');
  const guideSource = await readFile(new URL('../client/src/pages/GuidePage.jsx', import.meta.url), 'utf8');
  const introSource = await readFile(new URL('../client/src/pages/IntroPage.jsx', import.meta.url), 'utf8');

  assert.match(source, /useLocation\(\)/);
  assert.match(source, /document\.getElementById\(hash\.slice\(1\)\)/);
  assert.match(source, /target\.open = true/);
  assert.match(source, /target\.scrollIntoView\(\{ block: 'start' \}\)/);
  assert.match(source, /id=\{faq\.id\}/);
  assert.match(source, /<a href=\{link\.href\}>/);
  assert.match(guideSource, /<a href=\{`\/support#\$\{faq\.id\}`\}>/);
  assert.match(introSource, /<Link to=\{`\/support#\$\{faq\.id\}`\}>/);
});

test('HowTo schema follows the guide steps in order and links each anchor', () => {
  const howTo = schemaFor('/guide');

  assert.equal(howTo['@type'], 'HowTo');
  assert.equal(howTo.step.length, guideSteps.length);
  for (const [index, step] of howTo.step.entries()) {
    const source = guideSteps[index];
    assert.equal(step.position, index + 1);
    assert.equal(step.name, source.title);
    assert.equal(step.url, `https://pr-text.com/guide#${source.id}`);
    // The step text must be the visible summary plus its detail lines.
    assert.equal(step.text, [source.summary, ...source.details].join(' '));
  }
});

test('the guide page renders the shared step list instead of its own copy', async () => {
  const source = await readFile(new URL('../client/src/pages/GuidePage.jsx', import.meta.url), 'utf8');

  assert.match(source, /from '\.\.\/content\/guide-steps\.js'/);
  assert.doesNotMatch(source, /const steps = \[/);
});

test('the home application schema names the operating business', () => {
  // The footer's business identity is also available in structured data.
  const home = schemaFor('/');

  assert.equal(home['@type'], 'WebApplication');
  assert.equal(home.publisher['@type'], 'Organization');
  assert.equal(home.publisher.name, '코드밋(CodeMeet)');
  assert.equal(home.publisher.email, 'codemeet@naver.com');
  assert.equal(home.publisher.address.addressCountry, 'KR');
});

test('the business identity in the schema matches the footer', async () => {
  const layout = await readFile(new URL('../client/src/components/Layout.jsx', import.meta.url), 'utf8');
  const home = schemaFor('/');

  assert.match(layout, new RegExp(home.publisher.name.replace(/[()]/g, '\\$&')));
  assert.match(layout, new RegExp(home.publisher.email));
});

test('llms.txt lists public pages, current product facts, and FAQ anchors without stale claims', () => {
  const text = llmsTxt();

  for (const page of publicPages) {
    assert.ok(text.includes(page.canonicalUrl), `llms.txt is missing ${page.canonicalUrl}`);
  }
  // Numbers a generative engine could cite must match what the code enforces.
  assert.match(text, /최대 28자/);
  assert.match(text, /150MB/);
  assert.match(text, /500MB/);
  assert.match(text, /최대 20분/);
  assert.match(text, /영어 번역 TXT를 선택적으로/);
  assert.match(text, /최소 1분/);
  assert.doesNotMatch(text, /최소 표시 시간 0\.8초|다른 언어로 번역하지 않음/);
  for (const faq of supportFaqs) {
    assert.ok(text.includes(`/support#${faq.id}`), `llms.txt is missing FAQ ${faq.id}`);
    assert.ok(text.includes(faq.answer), `llms.txt answer differs for ${faq.id}`);
  }
  assert.match(text, /pr-text\.com/);
});

test('llms.txt avoids unsupported source attribution and AI visibility promises', () => {
  const text = llmsTxt();

  assert.doesNotMatch(text, /이 문서가 원출처|검색 노출을 보장/);
  assert.match(text, /노출이나 인용은 보장되지 않습니다/);
});

test('robots.txt names AI crawlers across training, search, and live fetch', async () => {
  const robots = (await readFile(new URL('../client/public/robots.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

  for (const agent of [
    'GPTBot', 'ClaudeBot', 'Google-Extended',
    'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot',
    'ChatGPT-User', 'Claude-User', 'Perplexity-User',
  ]) {
    assert.match(robots, new RegExp(`User-agent: ${agent}\\nAllow: /`), `${agent} must be allowed`);
  }
  // Private routes stay blocked for everyone.
  assert.match(robots, /Disallow: \/settings/);
  assert.match(robots, /Sitemap: https:\/\/pr-text\.com\/sitemap\.xml/);
});
