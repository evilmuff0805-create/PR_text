import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientFile = (path) => readFile(new URL(`../client/src/${path}`, import.meta.url), 'utf8');

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16) / 255);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

test('login modal exposes dialog semantics and keyboard-operable controls', async () => {
  const [authModal, dialogHook] = await Promise.all([
    clientFile('components/AuthModal.jsx'),
    clientFile('utils/use-dialog-accessibility.js'),
  ]);

  assert.match(authModal, /role="dialog"/);
  assert.match(authModal, /aria-modal="true"/);
  assert.match(authModal, /aria-label="로그인 창 닫기"/);
  assert.match(authModal, /htmlFor="auth-email"/);
  assert.match(authModal, /htmlFor="auth-password"/);
  assert.doesNotMatch(authModal, /<span onClick=/);
  assert.match(authModal, /role="alert"/);
  assert.match(authModal, /role="status"/);

  assert.match(dialogHook, /event\.key === 'Escape'/);
  assert.match(dialogHook, /event\.key !== 'Tab'/);
  assert.match(dialogHook, /restoreTarget\.focus\(\)/);
});

test('application shell and mobile menu provide accessible navigation landmarks', async () => {
  const [layout, header, sidebar] = await Promise.all([
    clientFile('components/Layout.jsx'),
    clientFile('components/Header.jsx'),
    clientFile('components/Sidebar.jsx'),
  ]);

  assert.match(layout, /className="skip-link" href="#main-content"/);
  assert.match(layout, /aria-controls="app-sidebar"/);
  assert.match(layout, /aria-expanded=\{sidebarOpen\}/);
  assert.match(layout, /id="main-content" tabIndex=\{-1\}/);
  assert.match(header, /aria-label="주요 페이지"/);
  assert.match(sidebar, /aria-label="메뉴 닫기"/);
  assert.match(sidebar, /role=\{isMobile \? 'dialog' : undefined\}/);
  assert.match(sidebar, /inert=\{isMobile && !isOpen \? '' : undefined\}/);
  assert.match(sidebar, /aria-label="작업 메뉴"/);
  assert.match(sidebar, /restoreFocusRef=\{isMobile \? triggerRef : undefined\}/);
  assert.doesNotMatch(sidebar, /<h1/);
});

test('editor tabs and async messages include keyboard and announcement support', async () => {
  const [result, home, payment, paymentSuccess, usage, redownload] = await Promise.all([
    clientFile('pages/ResultPage.jsx'),
    clientFile('pages/HomePage.jsx'),
    clientFile('pages/PaymentPage.jsx'),
    clientFile('pages/PaymentSuccessPage.jsx'),
    clientFile('pages/UsagePage.jsx'),
    clientFile('pages/RedownloadPage.jsx'),
  ]);

  assert.match(result, /event\.key === 'ArrowRight'/);
  assert.match(result, /event\.key === 'ArrowLeft'/);
  assert.match(result, /tabIndex=\{editorMode === mode\.id \? 0 : -1\}/);
  assert.match(home, /role="alert"/);
  assert.match(payment, /role=\{error \? 'alert' : 'status'\}/);
  assert.match(paymentSuccess, /aria-atomic="true"/);
  assert.match(usage, /className="usage-state" role="status"/);
  assert.match(redownload, /className="usage-state usage-state--error" role="alert"/);
});

test('muted text meets normal-text contrast on shared dark surfaces', () => {
  const muted = '8790a0';
  for (const background of ['0c0f14', '151922', '202630']) {
    assert.ok(contrastRatio(muted, background) >= 4.5);
  }
});
