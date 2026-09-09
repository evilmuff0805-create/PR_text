import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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

test('FAQ schema repeats the answers the support page renders, character for character', () => {
  // A schema that says something the visitor cannot see is treated as spam, so
  // both sides read the same module rather than keeping separate copies.
  const faq = schemaFor('/support');

  assert.equal(faq['@type'], 'FAQPage');
  assert.equal(faq.mainEntity.length, supportFaqs.length);
  for (const [index, entry] of faq.mainEntity.entries()) {
    assert.equal(entry['@type'], 'Question');
    assert.equal(entry.name, supportFaqs[index].question);
    assert.equal(entry.acceptedAnswer.text, supportFaqs[index].answer);
  }
});

test('the support page renders the shared FAQ list instead of its own copy', async () => {
  const source = await readFile(new URL('../client/src/pages/SupportPage.jsx', import.meta.url), 'utf8');

  assert.match(source, /from '\.\.\/content\/support-faqs\.js'/);
  assert.doesNotMatch(source, /const faqs = \[/);
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
  // Answer engines weigh who is behind a claim, so the footer's business identity
  // is exposed as structured data rather than being text only.
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

test('llms.txt lists every public page and the limits the service enforces', () => {
  const text = llmsTxt();

  for (const page of publicPages) {
    assert.ok(text.includes(page.canonicalUrl), `llms.txt is missing ${page.canonicalUrl}`);
  }
  // Numbers a generative engine could cite must match what the code enforces.
  assert.match(text, /최대 28자/);
  assert.match(text, /0\.8초/);
  assert.match(text, /150MB/);
  assert.match(text, /500MB/);
  assert.match(text, /최대 20분/);
  assert.match(text, /pr-text\.com/);
});

test('llms.txt does not promise translation the product refuses to do', () => {
  // The product corrects Korean spelling only and never translates. Telling a
  // generative engine otherwise would put a false claim into AI answers.
  const text = llmsTxt();

  assert.match(text, /번역하지 않는다|번역하지 않음/);
});

test('robots.txt names AI crawlers across training, search, and live fetch', async () => {
  const robots = await readFile(new URL('../client/public/robots.txt', import.meta.url), 'utf8');

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
