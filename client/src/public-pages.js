const siteUrl = 'https://pr-text.com';

const pageDefinitions = [
  { path: '/', title: '프리뷰 자막 머신 | 음성·영상 자막 변환과 편집', description: '휴대폰 녹음과 영상 파일을 자막으로 변환하고 직접 편집한 뒤, CapCut·Premiere Pro에서 불러올 수 있는 SRT와 TXT·ASS로 내려받으세요.' },
  { path: '/guide', title: '음성 파일에서 SRT 자막까지 | 프리뷰 자막 머신 사용법', description: '음성·영상 파일 업로드부터 자막 편집, Premiere Pro·CapCut용 SRT 다운로드까지 프리뷰 자막 머신 사용법을 확인하세요.' },
  { path: '/payment', title: '변환 시간 요금 | 프리뷰 자막 머신', description: '필요한 만큼 충전해 음성과 영상 파일을 자막으로 변환하세요. 프리뷰 자막 머신의 변환 시간 요금을 확인할 수 있습니다.' },
  { path: '/support', title: '고객센터와 자주 묻는 질문 | 프리뷰 자막 머신', description: '지원 파일 형식, 변환 시간, 파일 보관 기준 등 프리뷰 자막 머신 이용 중 자주 묻는 질문을 확인하세요.' },
  { path: '/terms', title: '이용약관 | 프리뷰 자막 머신', description: '프리뷰 자막 머신 서비스 이용약관과 환불 기준을 확인하세요.' },
  { path: '/privacy', title: '개인정보처리방침 | 프리뷰 자막 머신', description: '프리뷰 자막 머신이 처리하는 개인정보와 음성·영상 파일의 보관 기준을 확인하세요.' },
];
const priorities = ['1.0', '0.8', '0.7', '0.5', '0.3', '0.3'];

export const publicPages = Object.freeze(pageDefinitions.map((page) => Object.freeze({ ...page, canonicalUrl: `${siteUrl}${page.path}`, ogImage: `${siteUrl}/og-image.jpg` })));
export const publicPageByPath = new Map(publicPages.map((page) => [page.path, page]));
export const homeStructuredData = Object.freeze({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: '프리뷰 자막 머신',
  url: 'https://pr-text.com/',
  description: '휴대폰 녹음과 영상 파일을 원문의 말투를 지킨 자막으로 변환하고 직접 편집할 수 있는 웹 애플리케이션',
  applicationCategory: 'MultimediaApplication',
  operatingSystem: 'Web',
  inLanguage: 'ko-KR',
  image: 'https://pr-text.com/og-image.jpg',
  featureList: ['음성 및 영상 파일 자막 변환', '구간별 자막 편집', 'SRT, TXT, ASS 다운로드', 'CapCut에서 불러올 수 있는 SRT 자막', '다화자 구분'],
});
export const sitemapXml = () => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${publicPages.map((page, index) => `  <url><loc>${page.canonicalUrl}</loc><priority>${priorities[index]}</priority></url>`).join('\n')}\n</urlset>\n`;
export function publicPageForPath(pathname) { return publicPageByPath.get(pathname) ?? null; }