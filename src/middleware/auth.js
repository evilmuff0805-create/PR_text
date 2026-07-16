import { supabase, supabaseAdmin } from '../lib/supabase.js';
import { hashAccountIdentity } from '../services/account-deletion.js';
import { userHasPasswordIdentity } from '../services/password-security.js';
import {
  getWelcomeIdentityHashes,
  welcomeCreditStore,
} from '../services/welcome-credits.js';

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const token = authHeader.slice(7);

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: '유효하지 않은 인증 토큰입니다.' });
  }

  let welcomeIdentityHashes;
  try {
    welcomeIdentityHashes = getWelcomeIdentityHashes(user);
  } catch (identityError) {
    console.error('[auth.identity_hash_failed]', JSON.stringify({ userId: user.id }));
    return res.status(503).json({ error: '계정 정보를 확인하지 못했습니다.' });
  }

  let { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('credits, plan')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    return res.status(503).json({ error: '계정 정보를 확인하지 못했습니다.' });
  }

  if (!profile) {
    const { data: deletion, error: deletionError } = await supabaseAdmin
      .from('account_deletions')
      .select('status')
      .eq('account_hash', hashAccountIdentity(user.id))
      .maybeSingle();

    if (deletionError) {
      return res.status(503).json({ error: '계정 상태를 확인하지 못했습니다.' });
    }
    if (deletion) {
      return res.status(410).json({
        error: '탈퇴 처리된 계정입니다.',
        code: 'ACCOUNT_DELETED',
      });
    }

    try {
      profile = await welcomeCreditStore.ensureProfile(user, welcomeIdentityHashes);
    } catch (createError) {
      console.error('[auth.profile_prepare_failed]', JSON.stringify({ userId: user.id }));
      return res.status(503).json({ error: '계정 정보를 준비하지 못했습니다.' });
    }
  }

  req.user = {
    id: user.id,
    email: user.email,
    credits: profile?.credits ?? 0,
    plan: profile?.plan ?? 'free',
    canChangePassword: userHasPasswordIdentity(user),
    lastSignInAt: user.last_sign_in_at,
    welcomeIdentityHashes,
    token,
  };

  next();
}
