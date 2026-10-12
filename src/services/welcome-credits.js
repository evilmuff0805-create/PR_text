import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';

export const WELCOME_CREDITS = 10;
const HASH_CONTEXT = 'pr-text:welcome-credit:v1';

function welcomeCreditSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('무료 체험 식별값을 보호할 서버 키가 없습니다.');
  return secret;
}

export function hashWelcomeIdentity(kind, value, secret = welcomeCreditSecret()) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedValue = String(value || '').trim();
  if (!normalizedKind || !normalizedValue) {
    throw new Error('무료 체험 식별값을 만들 수 없습니다.');
  }

  return createHmac('sha256', secret)
    .update(`${HASH_CONTEXT}\0${normalizedKind}\0${normalizedValue}`)
    .digest('hex');
}

export function getWelcomeIdentityHashes(user, secret = welcomeCreditSecret()) {
  const descriptors = new Map();
  const email = String(user?.email || '').trim().toLowerCase();
  if (email) descriptors.set(`email:${email}`, ['email', email]);

  for (const identity of user?.identities || []) {
    const provider = String(identity?.provider || '').trim().toLowerCase();
    const providerId = String(identity?.provider_id || '').trim();
    if (provider && provider !== 'email' && providerId) {
      descriptors.set(`oauth:${provider}:${providerId}`, [`oauth:${provider}`, providerId]);
    }
  }

  return [...descriptors.values()]
    .map(([kind, value]) => hashWelcomeIdentity(kind, value, secret))
    .sort();
}

function firstResult(data, message) {
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) throw new Error(message);
  return result;
}

export function createWelcomeCreditStore(database = supabaseAdmin) {
  return {
    async getEligibility(userId) {
      const { data, error } = await database
        .from('welcome_credit_eligibility')
        .select('user_id, granted_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async getCredits(userId) {
      const { data, error } = await database
        .from('profiles')
        .select('credits')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return Number(data?.credits) || 0;
    },

    async ensureProfile(user, identityHashes = getWelcomeIdentityHashes(user)) {
      const { data, error } = await database.rpc('ensure_welcome_credit_profile', {
        p_user_id: user.id,
        p_email: user.email,
        p_identity_hashes: identityHashes,
      });
      if (error) throw error;
      return firstResult(data, '계정 정보를 준비하지 못했습니다.');
    },

    async recordClaims(identityHashes) {
      const { data, error } = await database.rpc('register_welcome_credit_claims', {
        p_identity_hashes: identityHashes,
      });
      if (error) throw error;
      return Number(data) || 0;
    },

    async prepareClaim(userId, { ipHash, accountHash }) {
      const { data, error } = await database.rpc('prepare_welcome_credit_claim', {
        p_user_id: userId,
        p_ip_hash: ipHash,
        p_account_hash: accountHash,
      });
      if (error) throw error;
      return firstResult(data, '무료 체험 확인 결과를 받지 못했습니다.');
    },

    async claim(user, { ipHash, accountHash, challengeNonce = null, turnstileValid = false }) {
      const { data, error } = await database.rpc('claim_welcome_credit', {
        p_user_id: user.id,
        p_identity_hashes: user.welcomeIdentityHashes,
        p_ip_hash: ipHash,
        p_account_hash: accountHash,
        p_email_confirmed: user.emailConfirmed,
        p_challenge_nonce: challengeNonce,
        p_turnstile_valid: turnstileValid,
      });
      if (error) throw error;
      return firstResult(data, '무료 체험 지급 결과를 받지 못했습니다.');
    },

    async cleanupIpRecords(limit = 1000) {
      const { data, error } = await database.rpc('cleanup_welcome_credit_ip_records', {
        p_limit: limit,
      });
      if (error) throw error;
      return firstResult(data, '무료 체험 보관 자료 정리 결과를 받지 못했습니다.');
    },
  };
}

export const welcomeCreditStore = createWelcomeCreditStore();

export function startWelcomeCreditMaintenance(store = welcomeCreditStore) {
  const run = async () => {
    try {
      const result = await store.cleanupIpRecords(1000);
      if (result.attempts_deleted || result.grants_deleted) {
        console.log('[welcome_credit.retention]', JSON.stringify({
          attemptsDeleted: result.attempts_deleted,
          grantsDeleted: result.grants_deleted,
        }));
      }
    } catch (error) {
      console.warn('[welcome_credit.retention_failed]', JSON.stringify({ code: error.code || 'unknown' }));
    }
  };

  const initialTimer = setTimeout(run, 15_000);
  initialTimer.unref?.();
  const interval = setInterval(run, 60 * 60 * 1000);
  interval.unref?.();
  return interval;
}
