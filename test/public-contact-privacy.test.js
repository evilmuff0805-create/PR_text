import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientFile = (path) => readFile(new URL(`../client/src/${path}`, import.meta.url), 'utf8');
const koreanMobileNumber = /010[- .]?\d{3,4}[- .]?\d{4}/;

test('public footer exposes the registered contact while privacy keeps email-only contact', async () => {
  const [layout, privacy] = await Promise.all([
    clientFile('components/Layout.jsx'),
    clientFile('pages/PrivacyPage.jsx'),
  ]);

  assert.match(layout, /연락처: 010-4901-1421/);
  assert.doesNotMatch(privacy, koreanMobileNumber);
  assert.match(layout, /이메일: codemeet@naver\.com/);
  assert.match(privacy, /이메일: codemeet@naver\.com/);
});
