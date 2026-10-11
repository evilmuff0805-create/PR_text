import { supabaseAdmin } from '../lib/supabase.js';
import {
  OUTREACH_DEFAULTS, OUTREACH_SENDER, MAX_IMPORT_ROWS, MIN_SUBSCRIBERS,
  OutreachError, outreachFooter, readOutreachConfig, renderOutreachTemplate,
} from './outreach-validation.js';

const CONTACT_COLUMNS = 'id,channel_id,channel_name,channel_url,category,country,subscriber_count,email,public_email_source,consent_status,consent_evidence,consent_granted_at,korea_verified,korea_evidence,channel_checked_at,metadata_source,metadata_expired_at,created_at,updated_at';
const CAMPAIGN_COLUMNS = 'id,name,subject,body,contact_ids,status,revision,scheduled_at,queued_at,created_at,updated_at';
const MESSAGE_COLUMNS = 'id,campaign_id,contact_id,kind,email,channel_name,status,error_code,started_at,sent_at,finished_at,created_at';
const MISSING_SCHEMA_CODES = new Set(['42P01', '42883', 'PGRST202', 'PGRST205']);

export function isOutreachSchemaMissing(error) { return MISSING_SCHEMA_CODES.has(error?.code); }

function databaseError(error) {
  if (error instanceof OutreachError) return error;
  if (isOutreachSchemaMissing(error)) return new OutreachError('홍보 발송 DB 마이그레이션을 먼저 적용해주세요.', 503, 'OUTREACH_DATABASE_NOT_READY');
  if (error?.code === '23505') return new OutreachError('이미 등록한 이메일 또는 요청 식별값입니다.', 409, 'OUTREACH_DUPLICATE');
  if (error?.code === 'OM404') return new OutreachError('요청한 연락처 또는 캠페인을 찾을 수 없습니다.', 404, 'OUTREACH_NOT_FOUND');
  if (error?.code === 'OM409') return new OutreachError('현재 상태와 발송 가능 연락처를 확인하고 다시 미리보기해주세요.', 409, 'OUTREACH_CONFLICT');
  if (['OM001', '23514', '23502', '22P02', '22007', '22008'].includes(error?.code)) return new OutreachError('입력값과 수신동의 근거를 확인해주세요.', 400, 'OUTREACH_INVALID_INPUT');
  return new OutreachError('홍보 발송 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.', 503, 'OUTREACH_DATABASE_UNAVAILABLE');
}

async function result(query) {
  let response;
  try { response = await query; } catch { throw databaseError(); }
  if (response.error) throw databaseError(response.error);
  return response;
}

export function outreachContactResponse(c) {
  return {
    id: c.id, channelId: c.channel_id, channelName: c.channel_name, channelUrl: c.channel_url,
    category: c.category, country: c.country, subscriberCount: c.subscriber_count === null ? null : Number(c.subscriber_count),
    email: c.email, publicEmailSource: c.public_email_source, consentStatus: c.consent_status,
    consentEvidence: c.consent_evidence, consentGrantedAt: c.consent_granted_at,
    koreaVerified: c.korea_verified, koreaEvidence: c.korea_evidence, channelCheckedAt: c.channel_checked_at,
    metadataSource: c.metadata_source, metadataExpiredAt: c.metadata_expired_at,
    createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

export function outreachCampaignResponse(c, counts = {}) {
  return {
    id: c.id, name: c.name, subject: c.subject, body: c.body, contactIds: c.contact_ids,
    status: c.status, previewRevision: c.revision, scheduledAt: c.scheduled_at, queuedAt: c.queued_at,
    createdAt: c.created_at, updatedAt: c.updated_at,
    counts: Object.fromEntries(['pending', 'claimed', 'sending', 'sent', 'failed', 'uncertain', 'skipped'].map(status => [status, Number(counts[status] || 0)])),
  };
}

export function outreachMessageResponse(m) {
  return {
    id: m.id, campaignId: m.campaign_id, contactId: m.contact_id, kind: m.kind,
    channelName: m.channel_name, email: m.email, status: m.status, errorCode: m.error_code,
    startedAt: m.started_at, sentAt: m.sent_at, finishedAt: m.finished_at, createdAt: m.created_at,
  };
}

export function createOutreachStore({ admin = supabaseAdmin, env = () => process.env } = {}) {
  const rpc = async (name, parameters = {}) => (await result(admin.rpc(name, parameters))).data;
  const first = data => Array.isArray(data) ? data[0] : data;
  const countsFor = async ids => {
    if (!ids.length) return new Map();
    const rows = await rpc('outreach_campaign_counts', { p_campaign_ids: ids });
    return new Map((rows || []).map(row => [row.campaign_id, row.counts]));
  };
  const store = {
    async status() {
      const config = readOutreachConfig(env());
      let databaseReady = true, databaseMessage, quota;
      try {
        quota = await rpc('outreach_database_status');
        if (quota?.schemaVersion !== 1) throw new OutreachError('홍보 발송 DB 상태를 확인하지 못했습니다.', 503, 'OUTREACH_DATABASE_UNAVAILABLE');
      } catch (error) {
        if (error.code !== 'OUTREACH_DATABASE_NOT_READY') throw error;
        databaseReady = false; databaseMessage = error.message;
      }
      return {
        admin: true, sendingEnabled: config.sendingEnabled, smtpConfigured: config.smtpConfigured,
        discoveryConfigured: config.discoveryConfigured, databaseReady, publicUrlConfigured: config.publicUrlConfigured,
        limitsConfigured: config.limitsConfigured, dailyLimit: config.dailyLimit, intervalSeconds: config.intervalSeconds,
        minIntervalSeconds: 60, quotaTimezone: 'Asia/Seoul', dailyAttempts: quota?.dailyAttempts ?? 0,
        quotaDay: quota?.quotaDay ?? null, nextAllowedAt: quota?.nextAllowedAt ?? null,
        fromEmail: OUTREACH_SENDER.email, replyToEmail: OUTREACH_SENDER.email, sender: OUTREACH_SENDER,
        defaults: OUTREACH_DEFAULTS, maxImportRows: MAX_IMPORT_ROWS, maxCampaignContacts: MAX_IMPORT_ROWS,
        minSubscribers: MIN_SUBSCRIBERS, ...(databaseMessage ? { databaseMessage } : {}),
      };
    },
    async listContacts({ page = 1, limit = 50, q = '' } = {}) {
      let query = admin.from('outreach_contacts').select(CONTACT_COLUMNS, { count: 'exact' });
      // The API accepts a literal search string; escape PostgREST filter punctuation.
      if (q) {
        const search = q.replace(/[\\%_,()."']/g, '').slice(0, 100);
        if (search) query = query.or(`channel_name.ilike.%${search}%,email.ilike.%${search}%`);
      }
      const response = await result(query.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1));
      return { contacts: (response.data || []).map(outreachContactResponse), total: response.count || 0, page, limit };
    },
    async getContact(id) {
      const { data } = await result(admin.from('outreach_contacts').select(CONTACT_COLUMNS).eq('id', id).maybeSingle());
      if (!data) throw new OutreachError('연락처를 찾을 수 없습니다.', 404, 'OUTREACH_NOT_FOUND');
      return outreachContactResponse(data);
    },
    async saveContacts(contacts, actorId, existingId = null) {
      const data = await rpc('outreach_save_contacts', { p_contacts: contacts, p_actor_id: actorId, p_existing_id: existingId });
      return (data || []).map(outreachContactResponse);
    },
    async listCampaigns({ page = 1, limit = 20 } = {}) {
      const response = await result(admin.from('outreach_campaigns').select(CAMPAIGN_COLUMNS, { count: 'exact' }).order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1));
      const rows = response.data || [], counts = await countsFor(rows.map(c => c.id));
      return { campaigns: rows.map(c => outreachCampaignResponse(c, counts.get(c.id))), total: response.count || 0, page, limit };
    },
    async createCampaign(campaign, actorId) {
      return outreachCampaignResponse(first(await rpc('outreach_create_campaign', { p_campaign: campaign, p_actor_id: actorId })));
    },
    async campaignDetails(id) {
      const { data: c } = await result(admin.from('outreach_campaigns').select(CAMPAIGN_COLUMNS).eq('id', id).maybeSingle());
      if (!c) throw new OutreachError('캠페인을 찾을 수 없습니다.', 404, 'OUTREACH_NOT_FOUND');
      const response = await result(admin.from('outreach_messages').select(MESSAGE_COLUMNS, { count: 'exact' }).eq('campaign_id', id).order('created_at', { ascending: false }).limit(200));
      const counts = await countsFor([id]);
      return { campaign: outreachCampaignResponse(c, counts.get(id)), messages: (response.data || []).map(outreachMessageResponse), totalMessages: response.count || 0 };
    },
    async previewCampaign(id) {
      const data = await rpc('outreach_preview_campaign', { p_campaign_id: id });
      const campaign = data.campaign;
      const samples = [], excluded = [];
      let eligibleCount = 0;
      for (const recipient of data.recipients) {
        const contact = recipient.contact;
        let reason = recipient.reason, content;
        if (!reason) {
          try { content = renderOutreachTemplate(campaign, contact.channel_name); }
          catch { reason = 'template_too_long'; }
        }
        if (reason) excluded.push({ contactId: recipient.contactId || contact?.id, reason });
        else {
          eligibleCount++;
          if (samples.length < 3) samples.push({ contactId: contact.id, channelName: contact.channel_name, to: contact.email, subject: content.subject, body: content.body + outreachFooter('[수신자별 수신거부 링크 / Recipient unsubscribe link]') });
        }
      }
      return { previewRevision: campaign.revision, subject: campaign.subject, body: campaign.body + outreachFooter('[수신자별 수신거부 링크 / Recipient unsubscribe link]'), eligibleCount, excluded, samples };
    },
    async queueCampaign(id, { requestId, previewRevision, scheduledAt }) {
      const data = await rpc('outreach_queue_campaign', { p_campaign_id: id, p_request_id: requestId, p_expected_revision: previewRevision, p_scheduled_at: scheduledAt });
      return { campaign: outreachCampaignResponse(data.campaign), alreadyQueued: data.alreadyQueued, queuedCount: data.queuedCount, excluded: data.excluded };
    },
    async setCampaignState(id, action) {
      const data = first(await rpc('outreach_set_campaign_state', { p_campaign_id: id, p_action: action }));
      const counts = await countsFor([id]);
      return outreachCampaignResponse(data, counts.get(id));
    },
    async queueTest(content, actorId) {
      return outreachMessageResponse(first(await rpc('outreach_queue_test', { p_subject: content.subject, p_body: content.body, p_actor_id: actorId })));
    },
    async getMessage(id) {
      const { data } = await result(admin.from('outreach_messages').select(MESSAGE_COLUMNS).eq('id', id).maybeSingle());
      if (!data) throw new OutreachError('발송 기록을 찾을 수 없습니다.', 404, 'OUTREACH_NOT_FOUND');
      return outreachMessageResponse(data);
    },
    async expireApiMetadata() { return rpc('outreach_expire_api_metadata'); },
    async recoverDispatch() { return rpc('outreach_recover_dispatch'); },
    async releaseClaim(id, token) { return rpc('outreach_release_claim', { p_message_id: id, p_worker_token: token }); },
    async claim(token, config) {
      return first(await rpc('outreach_claim_message', { p_worker_token: token, p_daily_limit: config.dailyLimit, p_interval_seconds: config.intervalSeconds })) || null;
    },
    async begin(id, token, tokenHash, config) {
      return first(await rpc('outreach_begin_send', { p_message_id: id, p_worker_token: token, p_token_hash: tokenHash, p_daily_limit: config.dailyLimit, p_interval_seconds: config.intervalSeconds })) || null;
    },
    async finish(id, token, status, errorCode = null, smtpMessageId = null) {
      return rpc('outreach_finish_message', { p_message_id: id, p_worker_token: token, p_status: status, p_error_code: errorCode, p_smtp_message_id: smtpMessageId });
    },
    async unsubscribe(tokenHash) { return rpc('outreach_unsubscribe', { p_token_hash: tokenHash }); },
  };
  return store;
}

export const outreachStore = createOutreachStore();
