import { supportFaqs } from './content/support-faqs.js';
import { guideSteps } from './content/guide-steps.js';

const siteUrl = 'https://pr-text.com';

// Business identity is also printed in the site footer. Answer engines weigh
// "who is saying this", so the same facts are exposed as structured data.
const organization = Object.freeze({
  '@type': 'Organization',
  name: '코드밋(CodeMeet)',
  url: `${siteUrl}/`,
  email: 'codemeet@naver.com',
  address: {
    '@type': 'PostalAddress',
    addressCountry: 'KR',
    addressRegion: '경기도',
    addressLocality: '김포시',
    streetAddress: '김포한강9로12번길 50(구래동)',
  },
});

const webApplication = Object.freeze({
  '@type': 'WebApplication',
  name: '프리뷰 자막 머신',
  url: `${siteUrl}/`,
  description: '휴대폰 녹음과 영상 파일을 원문의 말투를 지킨 자막으로 변환하고 직접 편집할 수 있는 웹 애플리케이션',
  applicationCategory: 'MultimediaApplication',
  operatingSystem: 'Web',
  inLanguage: 'ko-KR',
  image: `${siteUrl}/og-image.jpg`,
  featureList: ['음성 및 영상 파일 자막 변환', '구간별 자막 편집', 'SRT, TXT, ASS 다운로드', 'CapCut에서 불러올 수 있는 SRT 자막', '다화자 구분'],
  publisher: organization,
});

// Every answer string below is the same object the page renders, so the schema
// can never claim text the visitor does not see.
const faqPage = Object.freeze({
  '@type': 'FAQPage',
  inLanguage: 'ko-KR',
  mainEntity: supportFaqs.map((faq) => ({
    '@type': 'Question',
    name: faq.question,
    acceptedAnswer: { '@type': 'Answer', text: faq.answer },
  })),
});

const howTo = Object.freeze({
  '@type': 'HowTo',
  name: '음성·영상 파일을 자막으로 변환하는 방법',
  description: '파일 업로드부터 SRT·TXT·ASS 다운로드까지 프리뷰 자막 머신의 자막 제작 흐름입니다.',
  inLanguage: 'ko-KR',
  step: guideSteps.map((step, index) => ({
    '@type': 'HowToStep',
    position: index + 1,
    name: step.title,
    text: [step.summary, ...step.details].join(' '),
    url: `${siteUrl}/guide#${step.id}`,
  })),
});

const withContext = (node) => Object.freeze({ '@context': 'https://schema.org', ...node });

const pageDefinitions = [
  { path: '/', title: '자동 자막 생성·SRT 변환 | PR-text 프리뷰 자막 머신', description: '음성·영상에서 자동 자막을 만들고 직접 편집하세요. CapCut·Premiere Pro에서 불러올 수 있는 SRT와 TXT·ASS로 내려받을 수 있습니다.', structuredData: withContext(webApplication) },
  { path: '/guide', title: '프리미어 자막 작업 자동화·SRT 사용법 | PR-text', description: '음성·영상에서 자동 자막을 생성하고 SRT로 내려받아 Premiere Pro로 가져오는 방법을 확인하세요. 업로드부터 자막 편집까지 단계별로 안내합니다.', structuredData: withContext(howTo) },
  { path: '/payment', title: '변환 시간 요금 | 프리뷰 자막 머신', description: '필요한 만큼 충전해 음성과 영상 파일을 자막으로 변환하세요. 프리뷰 자막 머신의 변환 시간 요금을 확인할 수 있습니다.' },
  { path: '/support', title: '고객센터와 자주 묻는 질문 | 프리뷰 자막 머신', description: '지원 파일 형식, 변환 시간, 파일 보관 기준 등 프리뷰 자막 머신 이용 중 자주 묻는 질문을 확인하세요. 이메일 문의는 평일 10시부터 18시까지 받습니다.', structuredData: withContext(faqPage) },
  { path: '/terms', title: '이용약관 | 프리뷰 자막 머신', description: '프리뷰 자막 머신 서비스 이용약관과 환불 기준을 확인하세요. 충전한 변환 시간의 유효기간과 미사용분 환불 조건을 함께 안내합니다.' },
  { path: '/privacy', title: '개인정보처리방침 | 프리뷰 자막 머신', description: '프리뷰 자막 머신이 처리하는 개인정보와 음성·영상 파일의 보관 기준을 확인하세요. 원본 파일은 변환에만 사용하고 영구 저장하지 않습니다.' },
];
const priorities = ['1.0', '0.8', '0.7', '0.5', '0.3', '0.3'];

export const publicPages = Object.freeze(pageDefinitions.map((page) => Object.freeze({ ...page, canonicalUrl: `${siteUrl}${page.path}`, ogImage: `${siteUrl}/og-image.jpg` })));
export const publicPageByPath = new Map(publicPages.map((page) => [page.path, page]));
export const organizationStructuredData = organization;
export const homeStructuredData = publicPageByPath.get('/').structuredData;
export const sitemapXml = () => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${publicPages.map((page, index) => `  <url><loc>${page.canonicalUrl}</loc><priority>${priorities[index]}</priority></url>`).join('\n')}\n</urlset>\n`;
export function publicPageForPath(pathname) { return publicPageByPath.get(pathname) ?? null; }

// Generative engines read /llms.txt as a site guide. It is generated from the
// page list so a new public page cannot be missing from it.
export const llmsTxt = () => [
  '# 프리뷰 자막 머신 (PR-text)',
  '',
  '> 음성·영상 파일을 한국어 자막으로 변환하고, 구간별로 직접 편집해 SRT·TXT·ASS로 내려받는 웹 서비스. 원문의 말투를 보존하며 번역하지 않는다.',
  '',
  '## 핵심 페이지',
  ...publicPages.map((page) => `- [${page.title.split('|')[0].trim()}](${page.canonicalUrl}): ${page.description}`),
  '',
  '## 서비스 사실',
  '- 운영: 코드밋(CodeMeet), 사업자등록번호 470-32-01835, 통신판매업 제 2026-경기김포-4391 호',
  '- 지원 입력: mp3, wav, m4a, webm, mp4, mpeg, mpga, ogg, flac',
  '- 용량 한도: MP3·M4A·영상 최대 150MB, WAV 원본 최대 500MB (150MB 초과 WAV는 업로드 전 자동 최적화)',
  '- 출력 형식: SRT, TXT, ASS. SRT는 Premiere Pro·CapCut·YouTube에서 불러올 수 있으며 CapCut 타임코드 호환을 확인함',
  '- 자막 규격: 한 자막 최대 28자, 최소 표시 시간 0.8초, 겹치는 자막 큐 제거',
  '- 한국어 처리: 맞춤법·띄어쓰기만 교정하고 말투와 문맥은 바꾸지 않음. 다른 언어로 번역하지 않음',
  '- 다화자 구분: 최대 20분 파일까지 지원',
  '- 과금: 변환한 오디오 길이를 분 단위로 차감',
  '',
  '## 인용 안내',
  '- 위 수치는 서비스가 실제로 강제하는 값이며 이 문서가 원출처다',
  '- 인용 시 표기: pr-text.com',
  '',
].join('\n');

// IndexNow는 "여기 있다"만 말하는 사이트맵과 달리 "방금 바뀌었다"를 전한다.
// 참여 검색엔진은 Bing과 네이버를 포함하므로 한 번의 제출이 두 곳에 모두 닿는다.
// 키는 비밀이 아니다. 도메인에서 서빙된다는 사실 자체가 소유 증명이라 공개가 전제다.
export const indexNowKey = '3fd9cf2c8f254e54b0d6aa9fb02d034f';
export const indexNowKeyPath = `/${indexNowKey}.txt`;
export const indexNowHost = new URL(siteUrl).host;

// 제출 목록도 사이트맵과 같은 배열에서 파생시켜, 공개 페이지가 늘어도 뒤처질 수 없게 한다.
export const indexNowPayload = () => ({
  host: indexNowHost,
  key: indexNowKey,
  keyLocation: `${siteUrl}${indexNowKeyPath}`,
  urlList: publicPages.map((page) => page.canonicalUrl),
});
