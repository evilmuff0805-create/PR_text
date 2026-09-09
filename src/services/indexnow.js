import { indexNowPayload } from '../../client/src/public-pages.js';

// api.indexnow.org는 참여 검색엔진 전체로 전달한다. searchengines.json 기준
// Bing, 네이버, Yandex, Seznam, Yep, Internet Archive, Amazonbot이 소비한다.
// Google은 IndexNow를 쓰지 않으므로 이 호출은 Google 색인에 영향이 없다.
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const REQUEST_TIMEOUT_MS = 10_000;
// 크롤러를 부르기 전에 새 컨테이너가 실제로 트래픽을 받고 있어야 한다.
const SUBMIT_DELAY_MS = 30_000;

export async function submitPublicPagesToIndexNow(fetchImpl = fetch) {
  const payload = indexNowPayload();

  try {
    const response = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // 202는 키 검증이 진행 중이라는 뜻으로 정상 응답이다.
    if (response.status === 200 || response.status === 202) {
      console.log('[indexnow.submitted]', JSON.stringify({ status: response.status, urls: payload.urlList.length }));
      return { ok: true, status: response.status };
    }

    console.warn('[indexnow.failed]', JSON.stringify({ status: response.status }));
    return { ok: false, status: response.status };
  } catch (error) {
    // 검색엔진 통보 실패가 서비스에 영향을 주면 안 되므로 로그만 남긴다.
    console.warn('[indexnow.failed]', JSON.stringify({ message: error.message }));
    return { ok: false, error: error.message };
  }
}

export function startIndexNowSubmission() {
  if (process.env.INDEXNOW_ENABLED !== 'true') return null;

  const timer = setTimeout(() => { submitPublicPagesToIndexNow(); }, SUBMIT_DELAY_MS);
  timer.unref?.();
  return timer;
}
