import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { publicPages } from '../client/src/public-pages.js';

const publicPageFiles = new Map(publicPages.map((page) => [page.path, page.path === '/' ? 'index.html' : join('public-pages', `${page.path.slice(1)}.html`)]));
const privateSpaPaths = new Set(['/transcribe', '/caption-ideas', '/result', '/payment/success', '/payment/fail', '/usage', '/redownload', '/settings', '/auth/reset', '/reset-password']);
function sendHtml(res, filePath, noindex = false) { if (noindex) res.set('X-Robots-Tag', 'noindex, nofollow'); res.type('html').sendFile(filePath); }
function isGeneratedHtmlPath(pathname) { return pathname === '/index.html' || pathname === '/spa.html' || pathname.startsWith('/public-pages/') || pathname.toLowerCase().endsWith('.html'); }

export function addStaticSiteRoutes(app, distPath) {
  if (!existsSync(distPath)) return;
  const router = express.Router({ strict: true, caseSensitive: true });
  router.use((req, res, next) => {
    let pathname;
    try { pathname = decodeURIComponent(req.path); } catch { return res.status(400).type('text').send('Bad Request'); }
    return isGeneratedHtmlPath(pathname) ? res.status(404).type('text').send('Not Found') : next();
  });
  router.get('/intro', (req, res) => res.redirect(301, `/${req.url.slice('/intro'.length)}`));
  router.get(['/public-pages', '/public-pages/'], (req, res) => res.status(404).type('text').send('Not Found'));
  for (const [pathname, relativeFile] of publicPageFiles) router.get(pathname, (req, res) => sendHtml(res, join(distPath, relativeFile)));
  router.use(express.static(distPath, { index: false }));
  router.get('*', (req, res) => privateSpaPaths.has(req.path) ? sendHtml(res, join(distPath, 'spa.html'), true) : res.status(404).type('text').send('Not Found'));
  app.use(router);
}