// Only channel metadata is requested from the official YouTube Data API.
// Business email addresses are not provided by this API and are never scraped.
export const MIN_OUTREACH_SUBSCRIBERS = 100_000;
export const OUTREACH_CHANNEL_CATEGORIES = Object.freeze({
  web_entertainment: '웹예능',
  actor: '배우 개인 채널',
  general: '한국 유튜브 채널',
});

const DEFAULT_QUERIES = Object.freeze({
  web_entertainment: '웹예능',
  actor: '배우 브이로그',
  general: '한국 유튜버',
});
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UNSAFE_TITLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export class YouTubeDiscoveryError extends Error {
  constructor(message, status = 400, code = 'YOUTUBE_INVALID_QUERY') {
    super(message);
    this.name = 'YouTubeDiscoveryError';
    this.status = status;
    this.code = code;
  }
}

function invalidQuery() {
  return new YouTubeDiscoveryError('검색어·채널 분류·페이지 정보를 확인해주세요.');
}

function cleanTitle(value) {
  return typeof value === 'string'
    ? value.replace(UNSAFE_TITLE_CHARACTERS, ' ').trim().slice(0, 200)
    : '';
}

async function requestYouTube(resource, params, { apiKey, fetchImpl }) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  Object.entries({ ...params, key: apiKey }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new YouTubeDiscoveryError(
        response.status === 403 || response.status === 429
          ? 'YouTube API 사용 설정과 조회 한도를 확인해주세요.'
          : 'YouTube 채널 정보를 조회하지 못했습니다. 잠시 후 다시 시도해주세요.',
        502,
        'YOUTUBE_UPSTREAM_ERROR',
      );
    }
    const declaredLength = Number(response.headers?.get('content-length'));
    if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('response_size');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response_size');
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || !Array.isArray(result.items)) {
      throw new Error('response_shape');
    }
    return result;
  } catch (error) {
    if (error instanceof YouTubeDiscoveryError) throw error;
    // Do not include fetch errors, URLs or upstream payloads: they may contain the key.
    throw new YouTubeDiscoveryError(
      'YouTube 채널 정보를 조회하지 못했습니다. 잠시 후 다시 시도해주세요.',
      502,
      'YOUTUBE_UPSTREAM_ERROR',
    );
  }
}

export async function searchYouTubeChannels(
  input = {},
  { apiKey = process.env.YOUTUBE_API_KEY, fetchImpl = fetch, now = () => new Date() } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidQuery();
  const { query, category = 'web_entertainment', pageToken } = input;
  if (typeof category !== 'string' || !Object.hasOwn(OUTREACH_CHANNEL_CATEGORIES, category)) throw invalidQuery();
  if (query !== undefined && typeof query !== 'string') throw invalidQuery();
  const searchQuery = query?.trim() || DEFAULT_QUERIES[category];
  if (searchQuery.length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(searchQuery)) throw invalidQuery();
  if (pageToken !== undefined && (
    typeof pageToken !== 'string' || pageToken.length > 512 || !/^[A-Za-z0-9_=-]+$/.test(pageToken)
  )) throw invalidQuery();
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new YouTubeDiscoveryError(
      '채널 검색을 사용하려면 서버에 YOUTUBE_API_KEY를 설정해주세요.',
      503,
      'YOUTUBE_NOT_CONFIGURED',
    );
  }
  const options = { apiKey: apiKey.trim(), fetchImpl };
  const search = await requestYouTube('search', {
    part: 'snippet', type: 'channel', maxResults: '50', order: 'relevance',
    regionCode: 'KR', relevanceLanguage: 'ko', q: searchQuery,
    ...(pageToken ? { pageToken } : {}),
  }, options);
  const ids = [...new Set(search.items.map(item => item?.id?.channelId)
    .filter(id => typeof id === 'string' && CHANNEL_ID.test(id)))].slice(0, 50);
  const checkedAt = now().toISOString();
  const nextPageToken = typeof search.nextPageToken === 'string'
    && search.nextPageToken.length <= 512 && /^[A-Za-z0-9_=-]+$/.test(search.nextPageToken)
    ? search.nextPageToken : null;
  if (!ids.length) return { channels: [], nextPageToken, minSubscribers: MIN_OUTREACH_SUBSCRIBERS };
  const details = await requestYouTube('channels', {
    part: 'snippet,statistics', id: ids.join(','), maxResults: '50',
  }, options);
  const requestedIds = new Set(ids);
  const channels = [];
  for (const item of details.items) {
    if (!requestedIds.has(item?.id)) continue;
    requestedIds.delete(item.id);
    if (item.statistics?.hiddenSubscriberCount === true) continue;
    const rawCount = item.statistics?.subscriberCount;
    if (typeof rawCount !== 'string' || !/^\d{1,15}$/.test(rawCount)) continue;
    const subscriberCount = Number(rawCount);
    if (!Number.isSafeInteger(subscriberCount) || subscriberCount < MIN_OUTREACH_SUBSCRIBERS) continue;
    const rawCountry = item.snippet?.country;
    const country = typeof rawCountry === 'string' && /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : '';
    if (country && country !== 'KR') continue;
    const channelName = cleanTitle(item.snippet?.title);
    if (!channelName) continue;
    channels.push({
      channelId: item.id, channelName, channelUrl: `https://www.youtube.com/channel/${item.id}`,
      category, subscriberCount, country, koreaVerified: country === 'KR',
      countryNeedsReview: country !== 'KR', checkedAt,
    });
  }
  return { channels, nextPageToken, minSubscribers: MIN_OUTREACH_SUBSCRIBERS };
}
