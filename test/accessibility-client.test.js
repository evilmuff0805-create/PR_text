import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import test from 'node:test';

const clientFile = (path) => readFile(new URL(`../client/src/${path}`, import.meta.url), 'utf8');

async function clientSourceFiles(directory = new URL('../client/src/', import.meta.url)) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return clientSourceFiles(entryUrl);
    return /\.[jt]sx?$/.test(entry.name) ? [entryUrl] : [];
  }));
  return files.flat();
}

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
  assert.match(payment, /role=\{\(error \|\| configError\) \? 'alert' : 'status'\}/);
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

test('payment pages keep a single top-level heading and touch targets stay usable', async () => {
  const [payment, paymentSuccess, paymentFail, styles] = await Promise.all([
    clientFile('pages/PaymentPage.jsx'),
    clientFile('pages/PaymentSuccessPage.jsx'),
    clientFile('pages/PaymentFailPage.jsx'),
    clientFile('global.css'),
  ]);

  assert.match(payment, /<h1 id="payment-title"/);
  assert.match(payment, /<h2>\{plan\.name\}<\/h2>/);
  assert.match(payment, /<h2 id="payment-orders-title">/);
  assert.doesNotMatch(payment, /<h3/);
  assert.doesNotMatch(paymentSuccess, /<h2/);
  assert.doesNotMatch(paymentFail, /<h2/);
  assert.match(paymentSuccess, /<h1>결제 처리 중<\/h1>/);
  assert.match(paymentFail, /<h1 className="payment-status-card__title--error">/);
  assert.match(paymentFail, /role="alert"/);
  assert.match(paymentFail, /aria-atomic="true"/);
  assert.match(styles, /\.icon-button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  assert.match(styles, /\.mobile-menu-button\s*\{[\s\S]*?flex:\s*0 0 44px;/);
});

test('result summary and download copy stay legible without horizontal overflow', async () => {
  const styles = await clientFile('global.css');

  assert.match(styles, /\.result-summary dt\s*\{[\s\S]*?font-size:\s*0\.875rem;/);
  assert.match(styles, /\.result-summary dd\s*\{[\s\S]*?font-size:\s*1rem;/);
  assert.match(styles, /\.result-tool-heading h2\s*\{[\s\S]*?font-size:\s*1\.25rem;/);
  assert.match(styles, /\.export-option__copy strong\s*\{[\s\S]*?font-size:\s*1rem;/);
  assert.match(styles, /\.export-option__copy small\s*\{[\s\S]*?font-size:\s*0\.875rem;/);
  assert.match(
    styles,
    /\.export-option__copy strong,\s*\.export-option__copy small\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.match(styles, /\.export-option__copy\s*\{[\s\S]*?min-width:\s*0;/);
});

test('history timestamps stay inside their columns on both history pages', async () => {
  const [usage, redownload, dateTime, styles] = await Promise.all([
    clientFile('pages/UsagePage.jsx'),
    clientFile('pages/RedownloadPage.jsx'),
    clientFile('components/HistoryDateTime.jsx'),
    clientFile('global.css'),
  ]);

  assert.match(usage, /<HistoryDateTime value=\{log\.created_at\} \/>/);
  assert.match(redownload, /<HistoryDateTime value=\{log\.created_at\} \/>/);
  assert.match(dateTime, /className="usage-date-time"/);
  assert.match(dateTime, /<span>\{dateText\}<\/span>[\s\S]*<span>\{timeText\}<\/span>/);
  assert.match(styles, /\.usage-table__date\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(
    styles,
    /\.usage-date-time\s*\{[\s\S]*?display:\s*grid;[\s\S]*?max-width:\s*100%;[\s\S]*?white-space:\s*nowrap;/,
  );
  const mediumBreakpoint = styles.indexOf('@media (max-width: 1100px)');
  const mobileBreakpoint = styles.indexOf('@media (max-width: 768px)');
  const responsiveHistoryLayout = styles.indexOf('.usage-table--ledger tr,', mediumBreakpoint);
  assert.ok(responsiveHistoryLayout > mediumBreakpoint);
  assert.ok(responsiveHistoryLayout < mobileBreakpoint);
});

test('shared app typography never drops below the result-screen readability floor', async () => {
  const styles = await clientFile('global.css');
  const sizes = [...styles.matchAll(/font-size:\s*([0-9.]+)(rem|px)(?:\s*!important)?;/g)]
    .map((match) => (match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1])));
  const sourceFiles = await clientSourceFiles();
  const sourceEntries = await Promise.all(sourceFiles.map(async (file) => ({
    file,
    source: await readFile(file, 'utf8'),
  })));
  const undersizedInlineStyles = sourceEntries.flatMap(({ file, source }) => (
    [...source.matchAll(/fontSize:\s*['"]([0-9.]+)(rem|px)['"]/g)]
      .filter((match) => (match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1])) < 14)
      .map((match) => `${file.pathname}:${match[0]}`)
  ));

  assert.ok(sizes.length > 0);
  assert.deepEqual(sizes.filter((size) => size < 14), []);
  assert.deepEqual(undersizedInlineStyles, []);
});

test('guide publishes the complete visual manual and a downloadable PDF', async () => {
  const guide = await clientFile('pages/GuidePage.jsx');
  const manualTitles = guide.match(/const manualPages = \[([\s\S]*?)\]\.map/);

  assert.ok(manualTitles);
  assert.equal([...manualTitles[1].matchAll(/^\s*'[^']+',?\s*$/gm)].length, 11);
  assert.match(guide, /href="\/docs\/pr-text-manual\.pdf"/);
  assert.match(guide, /download="pr-text_manual\.pdf"/);
  assert.match(guide, /loading="lazy"/);
  assert.match(guide, /aria-label=\{`\$\{page\.number\}페이지/);

  const assets = [
    new URL('../client/public/docs/pr-text-manual.pdf', import.meta.url),
    ...Array.from(
      { length: 11 },
      (_, index) => new URL(
        `../client/public/images/manual/pr-text-manual-${String(index + 1).padStart(2, '0')}.webp`,
        import.meta.url,
      ),
    ),
  ];
  const stats = await Promise.all(assets.map((asset) => stat(asset)));

  assert.ok(stats.every((asset) => asset.isFile() && asset.size > 0));
});
