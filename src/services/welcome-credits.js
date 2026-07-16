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
  };
}

export const welcomeCreditStore = createWelcomeCreditStore();
