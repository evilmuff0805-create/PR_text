import { Router, urlencoded } from 'express';
import { outreachAdminMiddleware } from '../middleware/outreach-admin.js';
import { outreachStore } from '../services/outreach-store.js';
import { searchYouTubeChannels } from '../services/youtube-discovery.js';
import {
  OutreachError, OUTREACH_SENDER, assertOutreachCanSend, hashUnsubscribeToken,
  parseOutreachCsv, readOutreachConfig, renderOutreachTemplate, requireUuid,
  validateOutreachCampaign, validateOutreachContact, validateOutreachSchedule, validateOutreachTemplate,
} from '../services/outreach-validation.js';

export function outreachSecurityHeaders(req, res, next) {
  res.set({
    'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
}

export function createOutreachErrorHandler({ logger = console } = {}) {
  // Body parser errors can contain fragments of submitted addresses and tokens.
  // Never pass these errors to the shared diagnostic logger.
  return function outreachErrorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    outreachSecurityHeaders(req, res, () => {});
    const tooLarge = ['entity.too.large', 'parameters.too.many'].includes(error?.type);
    const malformed = ['entity.parse.failed', 'encoding.unsupported', 'charset.unsupported', 'request.aborted'].includes(error?.type);
    const status = tooLarge ? 413 : malformed ? 400 : 503;
    const code = tooLarge ? 'OUTREACH_BODY_TOO_LARGE' : malformed ? 'OUTREACH_INVALID_BODY' : 'OUTREACH_REQUEST_FAILED';
    logger.warn?.('[outreach.error]', JSON.stringify({ code }));
    return res.status(status).json({ error: tooLarge ? '요청 크기 제한을 초과했습니다.' : malformed ? '요청 형식을 확인해주세요.' : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.', code });
  };
}

export const outreachErrorHandler = createOutreachErrorHandler();

function pagination(query, fallback = 50) {
  const read = (value, defaultValue, maximum) => {
    if (value === undefined) return defaultValue;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new OutreachError('조회 범위를 확인해주세요.');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new OutreachError('조회 범위를 확인해주세요.');
    return number;
  };
  const q = query.q ?? '';
  if (typeof q !== 'string' || q.length > 100 || /[\u0000-\u001f\u007f]/.test(q)) throw new OutreachError('검색어를 확인해주세요.');
  return { page: read(query.page, 1, 10_000), limit: read(query.limit, fallback, 100), q };
}

function unsubscribePage({ token, message, success = false }) {
  // Token grammar is checked before interpolation. No external assets, recipient
  // identity, redirects or automatic POSTs appear on this public page.
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>코드밋 수신거부</title></head><body><main><h1>코드밋 홍보 메일 수신거부</h1><p>${message || '아래 버튼을 누르면 이후 홍보 메일 수신을 거부합니다. 이미 발송 중인 메일은 회수되지 않을 수 있습니다.'}</p>${token && !success ? `<form method="post" action="/api/outreach/unsubscribe"><input type="hidden" name="token" value="${token}"><button type="submit">수신거부 확인 / Confirm unsubscribe</button></form>` : ''}<p>To stop receiving promotional emails, confirm using the button. An email already being sent may still arrive.</p></main></body></html>`;
}

export function createOutreachRouter({
  store = outreachStore, adminMiddleware = outreachAdminMiddleware, discover = searchYouTubeChannels,
  env = () => process.env, now = Date.now, logger = console,
} = {}) {
  const router = Router();
  router.use(outreachSecurityHeaders);
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      const known = error instanceof OutreachError || (error?.name === 'YouTubeDiscoveryError' && Number.isInteger(error.status));
      if (!known) logger.warn?.('[outreach.route]', JSON.stringify({ code: 'OUTREACH_REQUEST_FAILED' }));
      res.status(known ? error.status : 503).json({
        error: known ? error.message : '홍보 발송 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.',
        code: known ? error.code : 'OUTREACH_REQUEST_FAILED', ...(known && error.extras ? error.extras : {}),
      });
    }
  };
  router.get('/unsubscribe', (req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      hashUnsubscribeToken(req.query.token);
      return res.type('html').send(unsubscribePage({ token: req.query.token }));
    } catch { return res.status(400).type('html').send(unsubscribePage({ message: '수신거부 링크가 올바르지 않습니다.' })); }
  });
  router.post('/unsubscribe', urlencoded({ extended: false, limit: '2kb', parameterLimit: 2 }), async (req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    let status = 200, message = '수신거부가 처리되었습니다. 이후 홍보 메일을 보내지 않습니다.';
    try {
      const tokenHash = hashUnsubscribeToken(req.body?.token);
      if (!await store.unsubscribe(tokenHash)) { status = 404; message = '수신거부 링크를 다시 확인해주세요.'; }
    } catch (error) {
      status = error instanceof OutreachError ? error.status : 503;
      message = status === 400 ? '수신거부 링크가 올바르지 않습니다.' : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.';
    }
    if (req.is('application/json')) return res.status(status).json({ message });
    return res.status(status).type('html').send(unsubscribePage({ message, success: status === 200 }));
  });

  router.use(adminMiddleware);
  router.get('/status', handle(async (req, res) => res.json(await store.status())));
  router.post('/discover', handle(async (req, res) => res.json(await discover(req.body))));
  router.get('/contacts', handle(async (req, res) => res.json(await store.listContacts(pagination(req.query)))));
  router.post('/contacts/import', handle(async (req, res) => {
    const contacts = parseOutreachCsv(req.body?.csv, { now: now() });
    const saved = await store.saveContacts(contacts, req.outreachAdmin.id);
    return res.status(201).json({ importedCount: saved.length, contacts: saved });
  }));
  router.post('/contacts', handle(async (req, res) => {
    const contact = validateOutreachContact(req.body, { now: now() });
    const saved = await store.saveContacts([contact], req.outreachAdmin.id);
    return res.status(201).json({ contact: saved[0] });
  }));
  router.patch('/contacts/:id', handle(async (req, res) => {
    const id = requireUuid(req.params.id);
    const existing = await store.getContact(id);
    const contact = validateOutreachContact(req.body, { now: now(), existing });
    const saved = await store.saveContacts([contact], req.outreachAdmin.id, id);
    return res.json({ contact: saved[0] });
  }));
  router.get('/campaigns', handle(async (req, res) => res.json(await store.listCampaigns(pagination(req.query, 20)))));
  router.post('/campaigns', handle(async (req, res) => {
    const campaign = await store.createCampaign(validateOutreachCampaign(req.body), req.outreachAdmin.id);
    return res.status(201).json({ campaign });
  }));
  router.get('/campaigns/:id', handle(async (req, res) => res.json(await store.campaignDetails(requireUuid(req.params.id)))));
  router.post('/campaigns/:id/preview', handle(async (req, res) => res.json(await store.previewCampaign(requireUuid(req.params.id)))));
  router.post('/campaigns/:id/queue', handle(async (req, res) => {
    const id = requireUuid(req.params.id), requestId = requireUuid(req.body?.requestId, 'requestId');
    const previewRevision = req.body?.previewRevision;
    if (!Number.isSafeInteger(previewRevision) || previewRevision < 1) throw new OutreachError('미리보기 식별값을 확인해주세요.');
    const scheduledAt = validateOutreachSchedule(req.body?.scheduledAt, { now: now() });
    if (scheduledAt) assertOutreachCanSend(readOutreachConfig(env()));
    return res.status(202).json(await store.queueCampaign(id, { requestId, previewRevision, scheduledAt }));
  }));
  router.post('/campaigns/:id/start', handle(async (req, res) => {
    const id = requireUuid(req.params.id);
    assertOutreachCanSend(readOutreachConfig(env()));
    return res.json({ campaign: await store.setCampaignState(id, 'start') });
  }));
  router.post('/campaigns/:id/pause', handle(async (req, res) => res.json({ campaign: await store.setCampaignState(requireUuid(req.params.id), 'pause') })));
  router.post('/test-send', handle(async (req, res) => {
    assertOutreachCanSend(readOutreachConfig(env()));
    if (!req.body || Object.keys(req.body).some(key => !['subject', 'body'].includes(key))) throw new OutreachError('테스트 수신자는 코드밋 본인 주소로 고정됩니다.');
    const template = validateOutreachTemplate(req.body);
    const content = renderOutreachTemplate(template, '코드밋 테스트');
    const message = await store.queueTest(content, req.outreachAdmin.id);
    return res.status(202).json({ message, notice: `${OUTREACH_SENDER.email} 본인 테스트 메일을 발송 대기열에 등록했습니다.` });
  }));
  router.get('/messages/:id', handle(async (req, res) => res.json({ message: await store.getMessage(requireUuid(req.params.id)) })));
  return router;
}

export default createOutreachRouter();
