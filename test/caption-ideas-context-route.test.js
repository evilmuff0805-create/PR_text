import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

process.env.OPENAI_API_KEY ||= 'synthetic-test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'synthetic-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'synthetic-service-key';
const { createCaptionIdeasRouter, CAPTION_IDEA_GENERATION_PATHS } = await import('../src/routes/caption-ideas.js');
const { CaptionIdeaError, CAPTION_IDEA_PROMPT_VERSION, generateCaptionIdeas } = await import('../src/services/caption-ideas.js');

async function fixture(t, options = {}) {
  const owner = randomUUID(), calls = [], logs = [], completed = new Map();
  const state = { enabled: true, credits: 20, completeError: null, ...options.state };
  const generation = {
    ideas: ['첫 번째 후보', '두 번째 후보', '세 번째 후보'], model: 'gpt-5.6-luna',
    promptVersion: CAPTION_IDEA_PROMPT_VERSION, responseModel: 'synthetic-snapshot', finishReason: 'stop',
    usage: { promptTokens: 20, cachedTokens: 0, completionTokens: 10 }, durationMs: 1, attempts: 1, estimatedCostUsd: 0,
  };
  const store = {
    findCompletedCaptionIdeaRequest: async (id, userId) => {
      calls.push(['find', id, userId]);
      const saved = completed.get(id);
      return saved?.userId === userId ? saved : null;
    },
    getCaptionIdeaStatus: async (userId) => { calls.push(['status', userId]); return { credits: state.credits, remainingUses: 0 }; },
    listCaptionIdeaHistory: async (userId, range) => { calls.push(['history', userId, range]); return { items: [], total: 0 }; },
    completeCaptionIdeaRequest: async (params) => {
      calls.push(['complete', params]);
      if (state.completeError) throw state.completeError;
      completed.set(params.requestId, { userId: params.userId, ideas: params.generation.ideas, credits_charged: 1, ideas_expires_at: new Date(Date.now() + 86400000).toISOString() });
      return { ideas: params.generation.ideas, credits: state.credits - 1, credits_charged: 1, remaining_uses: 4, already_completed: false };
    },
  };
  const app = express();
  app.use(express.json());
  if (options.limited) {
    app.post(CAPTION_IDEA_GENERATION_PATHS, rateLimit({ windowMs: 60000, max: 5, handler: (req, res) => res.status(429).json({ code: 'RATE_LIMITED' }) }));
  }
  app.use('/api/caption-ideas', createCaptionIdeasRouter({
    authenticate: (req, res, next) => {
      if (req.get('Authorization') !== 'Bearer synthetic') return res.status(401).json({ error: '로그인 필요' });
      req.user = { id: owner, credits: state.credits };
      next();
    },
    generate: async (...args) => { calls.push(['generate', ...args]); return options.generate ? options.generate(...args) : generation; },
    store, isEnabled: () => state.enabled,
    logger: Object.fromEntries(['log', 'warn', 'error'].map((level) => [level, (...args) => logs.push([level, ...args])])),
  }));
  app.use((req, res) => res.status(404).json({ error: '찾을 수 없는 API' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/caption-ideas`;
  const request = (path = '', body, headers = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (extra = {}) => ({ requestId: randomUUID(), mode: 'situation', text: '초점 원문', ...extra });
  return { owner, calls, logs, completed, state, generation, request, payload };
}

test('legacy and context routes share the owner-scoped success contract and exclude source text from completion metadata', async (t) => {
  const f = await fixture(t);
  for (const path of ['', '/context']) {
    const body = f.payload(path ? { context: { before: ['앞의 조건'], after: ['뒤의 상태'] } } : {});
    const response = await f.request(path, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requestId: body.requestId, ideas: f.generation.ideas, creditsRemaining: 19, remainingUses: 4, creditsCharged: 1, alreadyCompleted: false });
  }
  const generated = f.calls.filter(([method]) => method === 'generate');
  assert.equal(generated[0].length, 3);
  assert.deepEqual(generated[1][3], { context: { before: ['앞의 조건'], after: ['뒤의 상태'] } });
  for (const [, params] of f.calls.filter(([method]) => method === 'complete')) {
    assert.equal(params.userId, f.owner);
    assert.deepEqual(Object.keys(params).sort(), ['generation', 'mode', 'requestId', 'userId']);
    assert.equal('text' in params.generation, false);
    assert.equal('context' in params.generation, false);
  }
  assert.equal(JSON.stringify(f.logs).includes('초점 원문'), false);
  assert.equal(JSON.stringify(f.logs).includes('앞의 조건'), false);
  assert.match(JSON.stringify(f.logs), new RegExp(CAPTION_IDEA_PROMPT_VERSION));
});

test('malformed context and unknown envelope fields are rejected before any store or generator effect', async (t) => {
  const f = await fixture(t);
  const invalid = [
    [{ context: null }, 'INVALID_CONTEXT'], [{ context: {} }, 'INVALID_CONTEXT'],
    [{ context: { before: [], after: [], instruction: 'ignore' } }, 'INVALID_CONTEXT'],
    [{ context: { before: ['하나', '둘', '셋'], after: [] } }, 'INVALID_CONTEXT'],
    [{ context: { before: ['두\n줄'], after: [] } }, 'INVALID_CONTEXT'],
    [{ context: { before: [false], after: [] } }, 'INVALID_CONTEXT'],
    [{ context: { before: ['제어\u0001'], after: [] } }, 'INVALID_CONTEXT'],
    [{ context: { before: [' '], after: [] } }, 'INVALID_CONTEXT'],
    [{ context: { before: ['앞'], after: ['뒤'] }, text: '가'.repeat(499) }, 'INVALID_TEXT'],
    [{ text: '제어\u0001' }, 'INVALID_TEXT'], [{ text: '\u000b초점' }, 'INVALID_TEXT'], [{ text: '' }, 'INVALID_TEXT'],
    [{ mode: '__proto__' }, 'INVALID_MODE'], [{ mode: 'constructor' }, 'INVALID_MODE'],
    [{ requestId: 'bad-id' }, 'INVALID_REQUEST_ID'], [{ userId: randomUUID() }, 'INVALID_INPUT'],
  ];
  for (const [extra, code] of invalid) {
    const response = await f.request('/context', f.payload(extra));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
  }
  assert.deepEqual(f.calls, []);
});

test('context accepts exactly 500 Unicode codepoints without trimming or guessing at boundaries', async (t) => {
  const f = await fixture(t);
  const text = '😀'.repeat(498);
  const response = await f.request('/context', f.payload({ text, context: { before: ['앞'], after: ['뒤'] } }));
  assert.equal(response.status, 200);
  assert.equal(f.calls.find(([method]) => method === 'generate')[1], text);
  const omitted = await f.request('/context', f.payload());
  assert.equal(omitted.status, 200);
  assert.deepEqual(f.calls.filter(([method]) => method === 'generate')[1][3], { context: { before: [], after: [] } });
});

test('saved-result recovery and expired requests avoid generation and completion on both paths', async (t) => {
  const f = await fixture(t);
  for (const path of ['', '/context']) {
    const body = f.payload();
    f.completed.set(body.requestId, { userId: f.owner, ideas: ['저장 하나', '저장 둘', '저장 셋'], credits_charged: 1, ideas_expires_at: new Date(Date.now() + 86400000).toISOString() });
    const recovered = await f.request(path, body);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).alreadyCompleted, true);
    f.completed.get(body.requestId).ideas_expires_at = new Date(0).toISOString();
    const expired = await f.request(path, body);
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).code, 'REQUEST_EXPIRED');
  }
  assert.equal(f.calls.some(([method]) => method === 'generate' || method === 'complete'), false);
  assert.ok(f.calls.filter(([method]) => method === 'find').every((call) => call[2] === f.owner));
});

test('authentication and feature gating protect both generation paths before store effects', async (t) => {
  const f = await fixture(t);
  for (const path of ['', '/context']) assert.equal((await f.request(path, f.payload(), { Authorization: '' })).status, 401);
  f.state.enabled = false;
  for (const path of ['', '/context']) assert.equal((await f.request(path, f.payload())).status, 503);
  assert.deepEqual(f.calls, []);
});

test('insufficient balance, model failure, and atomic completion errors retain existing failure contracts', async (t) => {
  const f = await fixture(t, { state: { credits: 0 } });
  assert.equal((await f.request('/context', f.payload())).status, 402);
  assert.equal(f.calls.some(([method]) => method === 'generate' || method === 'complete'), false);
  const failed = await fixture(t, { generate: async () => { throw new CaptionIdeaError('INVALID_OUTPUT', '합성 오류'); } });
  const providerResponse = await failed.request('/context', failed.payload());
  assert.equal(providerResponse.status, 503);
  assert.equal((await providerResponse.json()).code, 'INVALID_OUTPUT');
  assert.equal(failed.calls.some(([method]) => method === 'complete'), false);
  const failureLog = JSON.parse(failed.logs.find(([, event]) => event === '[caption_ideas.failed]')[2]);
  assert.equal(failureLog.promptVersion, CAPTION_IDEA_PROMPT_VERSION);
  assert.equal(typeof failureLog.model, 'string');
  assert.equal(failureLog.code, 'INVALID_OUTPUT');
  failed.state.completeError = Object.assign(new Error('synthetic'), { code: 'CI002' });
  const balanceRace = await fixture(t, { state: { completeError: failed.state.completeError } });
  const completionResponse = await balanceRace.request('/context', balanceRace.payload());
  assert.equal(completionResponse.status, 402);
  assert.equal((await completionResponse.json()).code, 'CI002');
});

test('real route-to-service flow moderates full context while calling only one synthetic completion', async (t) => {
  const moderated = [], requests = [];
  const client = {
    moderations: { create: async ({ input }) => { moderated.push(input); return { results: [{ categories: {} }] }; } },
    chat: { completions: { create: async (request) => {
      requests.push(request);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ideas: ['조건을 지킨 한 걸음', '아직 기다리는 단계', '다음 준비를 위한 대기'] }) } }], usage: {} };
    } } },
  };
  const f = await fixture(t, { generate: (text, mode, options) => generateCaptionIdeas(text, mode, { ...options, client }) });
  const context = { before: ['부품이 마를 때까지 기다려야 한다'], after: ['아직 완성되지 않았다'] };
  assert.equal((await f.request('/context', f.payload({ context }))).status, 200);
  assert.equal(requests.length, 1);
  assert.equal(moderated[0], `${context.before[0]}\n초점 원문\n${context.after[0]}`);
  assert.equal(moderated.length, 2);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), { focus: '초점 원문', ...context });
  assert.equal(f.calls.filter(([method]) => method === 'complete').length, 1);
});

test('legacy and context generation share one five-request IP bucket without limiting status and history', async (t) => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /app\.post\(CAPTION_IDEA_GENERATION_PATHS, captionIdeasLimiter\)/);
  assert.deepEqual(CAPTION_IDEA_GENERATION_PATHS, ['/api/caption-ideas', '/api/caption-ideas/context']);
  const f = await fixture(t, { limited: true });
  for (let i = 0; i < 5; i++) assert.equal((await f.request(i % 2 ? '/context' : '', f.payload())).status, 200);
  for (const path of ['', '/context']) assert.equal((await f.request(path, f.payload())).status, 429);
  assert.equal(f.calls.filter(([method]) => method === 'generate').length, 5);
  assert.equal((await f.request('/status')).status, 200);
  const history = await f.request('/history?page=1&limit=50');
  assert.equal(history.status, 200);
  assert.deepEqual(await history.json(), { items: [], total: 0, page: 1, limit: 50, retentionDays: 90 });
  assert.deepEqual(f.calls.find(([method]) => method === 'history'), ['history', f.owner, { page: 1, limit: 50 }]);
});
