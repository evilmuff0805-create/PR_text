import test from 'node:test';
import assert from 'node:assert/strict';
import { searchYouTubeChannels } from '../src/services/youtube-discovery.js';

const channelId = n => `UC${String(n).padStart(22, '0')}`;
const response = data => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

test('official channel discovery filters the subscriber threshold and foreign countries, and marks unknown country', async () => {
  const calls = [];
  const data = [
    { id: channelId(1), snippet: { title: '한국 채널', country: 'KR', description: 'private@example.com' }, statistics: { subscriberCount: '100000' } },
    { id: channelId(2), snippet: { title: '작은 채널', country: 'KR' }, statistics: { subscriberCount: '99999' } },
    { id: channelId(3), snippet: { title: '국가 미기재 채널' }, statistics: { subscriberCount: '300000' } },
    { id: channelId(4), snippet: { title: '미국 채널', country: 'US' }, statistics: { subscriberCount: '500000' } },
    { id: channelId(5), snippet: { title: '비공개 채널', country: 'KR' }, statistics: { subscriberCount: '900000', hiddenSubscriberCount: true } },
    { id: channelId(6), snippet: { title: '잘못된 숫자', country: 'KR' }, statistics: { subscriberCount: null } },
  ];
  const result = await searchYouTubeChannels({ query: '웹예능', category: 'web_entertainment' }, {
    apiKey: 'fixture-api-key', now: () => new Date('2026-10-11T00:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(calls.length === 1
        ? { items: [...data.map(item => ({ id: { channelId: item.id } })), { id: { channelId: channelId(1) } }], nextPageToken: 'PAGE_2=' }
        : { items: [...data, data[0], { ...data[0], id: channelId(99) }] });
    },
  });
  assert.deepEqual(result.channels.map(item => item.channelId), [channelId(1), channelId(3)]);
  assert.equal(result.channels[0].koreaVerified, true);
  assert.equal(result.channels[1].countryNeedsReview, true);
  assert.equal(result.channels[0].checkedAt, '2026-10-11T00:00:00.000Z');
  assert.equal(result.minSubscribers, 100000);
  assert.equal(result.nextPageToken, 'PAGE_2=');
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
  assert.equal(JSON.stringify(result).includes('fixture-api-key'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin, 'https://www.googleapis.com');
  assert.equal(calls[0].url.searchParams.get('type'), 'channel');
  assert.equal(calls[1].url.searchParams.get('id').split(',').length, 6);
  assert.equal(calls[0].options.redirect, 'error');
});

test('discovery validates category, query and paging before network access', async () => {
  const options = { apiKey: 'fixture', fetchImpl: () => assert.fail('must not fetch') };
  for (const input of [
    null, [], 'actor', { category: '__proto__' }, { category: 'other' }, { query: {} },
    { category: ['actor'] }, { category: { toString: null } }, { category: null },
    { query: 'a'.repeat(101) }, { query: 'bad\r\nquery' }, { query: 'bad\u202equery' },
    { pageToken: 'https://example.com' }, { pageToken: [] }, { pageToken: 'a'.repeat(513) },
  ]) {
    await assert.rejects(searchYouTubeChannels(input, options), error => error.status === 400);
  }
  await assert.rejects(searchYouTubeChannels({}, { ...options, apiKey: '' }),
    error => error.status === 503 && error.code === 'YOUTUBE_NOT_CONFIGURED');
});

test('channel titles sanitize C1, Unicode line separators and bidi controls before contact registration', async () => {
  let calls = 0;
  const result = await searchYouTubeChannels({}, {
    apiKey: 'fixture', fetchImpl: async () => {
      calls += 1;
      return response(calls === 1
        ? { items: [{ id: { channelId: channelId(1) } }] }
        : { items: [{ id: channelId(1), snippet: { title: '한국\u0085채널\u2028이름\u2029\u202e\u2066', country: 'KR' }, statistics: { subscriberCount: '100000' } }] });
    },
  });
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].channelName, '한국 채널 이름');
});

test('empty discovery handles paging without making a details request', async () => {
  let calls = 0;
  const result = await searchYouTubeChannels({ category: 'actor', pageToken: 'PAGE_2=' }, {
    apiKey: 'fixture', fetchImpl: async url => {
      calls += 1;
      assert.equal(url.searchParams.get('q'), '배우 브이로그');
      assert.equal(url.searchParams.get('pageToken'), 'PAGE_2=');
      return response({ items: [{ id: { videoId: 'not-a-channel' } }], nextPageToken: '<invalid>' });
    },
  });
  assert.deepEqual(result, { channels: [], nextPageToken: null, minSubscribers: 100000 });
  assert.equal(calls, 1);
});

test('network, quota and malformed upstream failures never disclose credentials or payloads', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('secret fixture-api-key https://www.googleapis.com?key=fixture-api-key'); },
    async () => new Response('fixture-api-key', { status: 403 }),
    async () => response({ error: { message: 'fixture-api-key' } }),
    async () => new Response('{fixture-api-key', { status: 200 }),
    async () => new Response('fixture-api-key', { status: 200, headers: { 'Content-Length': '3000000' } }),
  ]) {
    await assert.rejects(searchYouTubeChannels({}, { apiKey: 'fixture-api-key', fetchImpl }), error => {
      assert.equal(error.status, 502);
      assert.equal(error.message.includes('fixture-api-key'), false);
      return true;
    });
  }
});
