import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { publicPageForPath } from './public-pages.js';

function setMeta(selector, content) {
  let element = document.head.querySelector(selector);
  if (!element) {
    const match = selector.match(/^meta\[(name|property)="([^"]+)"\]$/);
    if (!match) return;
    element = document.createElement('meta');
    element.setAttribute(match[1], match[2]);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

function ensureCanonical() {
  let canonical = document.head.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  return canonical;
}

function ensurePageStructuredData(page) {
  let structuredData = document.getElementById('public-structured-data');
  if (!structuredData) {
    structuredData = document.createElement('script');
    structuredData.id = 'public-structured-data';
    structuredData.type = 'application/ld+json';
    document.head.appendChild(structuredData);
  }
  structuredData.textContent = JSON.stringify(page.structuredData);
}

function setPublicSocialMetadata(page) {
  setMeta('meta[name="description"]', page.description);
  setMeta('meta[property="og:site_name"]', '프리뷰 자막 머신');
  setMeta('meta[property="og:title"]', page.title);
  setMeta('meta[property="og:description"]', page.description);
  setMeta('meta[property="og:type"]', 'website');
  setMeta('meta[property="og:url"]', page.canonicalUrl);
  setMeta('meta[property="og:image"]', page.ogImage);
  setMeta('meta[property="og:image:secure_url"]', page.ogImage);
  setMeta('meta[property="og:image:type"]', 'image/jpeg');
  setMeta('meta[property="og:image:width"]', '1200');
  setMeta('meta[property="og:image:height"]', '630');
  setMeta('meta[property="og:image:alt"]', '구름 위 조용한 공간에서 자막을 편집하는 프리뷰 자막 머신');
  setMeta('meta[property="og:locale"]', 'ko_KR');
  setMeta('meta[name="twitter:card"]', 'summary_large_image');
  setMeta('meta[name="twitter:title"]', page.title);
  setMeta('meta[name="twitter:description"]', page.description);
  setMeta('meta[name="twitter:image"]', page.ogImage);
  setMeta('meta[name="twitter:image:alt"]', '구름 위 조용한 공간에서 자막을 편집하는 프리뷰 자막 머신');
}

export default function PublicMetadata() {
  const { pathname } = useLocation();
  useEffect(() => {
    const page = publicPageForPath(pathname);
    const robots = document.head.querySelector('meta[name="robots"]');
    const canonical = document.head.querySelector('link[rel="canonical"]');
    const structuredData = document.getElementById('public-structured-data');
    if (!page) {
      document.title = '프리뷰 자막 머신';
      if (robots) robots.setAttribute('content', 'noindex, nofollow');
      if (canonical) canonical.remove();
      if (structuredData) structuredData.remove();
      return;
    }
    document.title = page.title;
    setPublicSocialMetadata(page);
    if (robots) robots.setAttribute('content', 'index, follow, max-image-preview:large');
    ensureCanonical().setAttribute('href', page.canonicalUrl);
    if (page.structuredData) ensurePageStructuredData(page);
    else if (structuredData) structuredData.remove();
  }, [pathname]);
  return null;
}