import { createServer, build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeStructuredData, publicPages, sitemapXml } from '../client/src/public-pages.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = resolve(root, 'client');
const distRoot = resolve(root, 'dist');
const viteConfig = resolve(clientRoot, 'vite.config.js');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function publicMetadata(page) {
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  const canonicalUrl = escapeHtml(page.canonicalUrl);
  const structuredData = page.path === '/'
    ? `<script type="application/ld+json" id="public-structured-data">${JSON.stringify(homeStructuredData).replace(/</g, '\\u003c')}</script>`
    : '';
  return `<title>${title}</title>\n    <meta name="description" content="${description}" />\n    <meta name="robots" content="index, follow, max-image-preview:large" />\n    <meta property="og:site_name" content="프리뷰 자막 머신" />\n    <meta property="og:title" content="${title}" />\n    <meta property="og:description" content="${description}" />\n    <meta property="og:type" content="website" />\n    <meta property="og:url" content="${canonicalUrl}" />\n    <meta property="og:image" content="https://pr-text.com/og-image.jpg" />\n    <meta property="og:image:secure_url" content="https://pr-text.com/og-image.jpg" />\n    <meta property="og:image:type" content="image/jpeg" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta property="og:image:alt" content="구름 위 조용한 공간에서 자막을 편집하는 프리뷰 자막 머신" />\n    <meta property="og:locale" content="ko_KR" />\n    <meta name="twitter:card" content="summary_large_image" />\n    <meta name="twitter:title" content="${title}" />\n    <meta name="twitter:description" content="${description}" />\n    <meta name="twitter:image" content="https://pr-text.com/og-image.jpg" />\n    <meta name="twitter:image:alt" content="구름 위 조용한 공간에서 자막을 편집하는 프리뷰 자막 머신" />\n    <link rel="canonical" href="${canonicalUrl}" />\n    ${structuredData}`;
}

const pageOutputPath = (pathname) => pathname === '/' ? resolve(distRoot, 'index.html') : resolve(distRoot, 'public-pages', `${pathname.slice(1)}.html`);
function privateSpaShell(template) {
  return template.replace(/<!-- public-metadata:start -->[\s\S]*?<!-- public-metadata:end -->/, '<title>프리뷰 자막 머신</title>\n    <meta name="robots" content="noindex, nofollow" />');
}
function assertPublicHead(document, pathname) {
  for (const name of ['naver-site-verification', 'google-site-verification']) {
    const count = (document.match(new RegExp(`name="${name}"`, 'g')) || []).length;
    if (count !== 1) throw new Error(`${pathname} must contain exactly one ${name} tag.`);
  }
  if ((document.match(/rel="icon"/g) || []).length !== 1) {
    throw new Error(`${pathname} must contain exactly one favicon link.`);
  }
}

function renderDocument(template, page, body) {
  return template.replace(/<!-- public-metadata:start -->[\s\S]*?<!-- public-metadata:end -->/, publicMetadata(page)).replace('<html lang="ko">', '<html lang="ko" data-prerendered="true">').replace('<div id="root"></div>', `<div id="root">${body}</div>`);
}

await build({ configFile: viteConfig });
const initialTemplate = await readFile(resolve(distRoot, 'index.html'), 'utf8');
if (!initialTemplate.includes('<!-- public-metadata:start -->') || !initialTemplate.includes('<!-- public-metadata:end -->') || !initialTemplate.includes('<div id="root"></div>')) {
  throw new Error('Vite build template is missing the public metadata or root marker.');
}
const spaShellPath = resolve(distRoot, 'spa.html');
await writeFile(spaShellPath, privateSpaShell(initialTemplate), 'utf8');
await writeFile(resolve(distRoot, 'sitemap.xml'), sitemapXml(), 'utf8');
const vite = await createServer({ configFile: viteConfig, server: { middlewareMode: true }, appType: 'custom' });
try {
  const template = initialTemplate;
  const { renderPublicPage } = await vite.ssrLoadModule('/src/entry-server.jsx');
  for (const page of publicPages) {
    const outputPath = pageOutputPath(page.path);
    await mkdir(dirname(outputPath), { recursive: true });
    const document = renderDocument(template, page, renderPublicPage(page.path));
    assertPublicHead(document, page.path);
    await writeFile(outputPath, document, 'utf8');
  }
} finally { await vite.close(); }