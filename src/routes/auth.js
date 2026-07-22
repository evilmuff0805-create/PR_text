import { Router } from 'express';
import { createPasswordClient, supabase, supabaseAdmin } from '../lib/supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  changePasswordWithRecoverySession,
  changePasswordWithCurrentPassword,
  PasswordChangeError,
  validateNewPassword,
} from '../services/password-security.js';
import { getWelcomeIdentityHashes, welcomeCreditStore } from '../services/welcome-credits.js';

const router = Router();
const OAUTH_RETURN_PATHS = new Set(['/settings', '/caption-ideas']);

export function safeOAuthReturnPath(value) {
  return OAUTH_RETURN_PATHS.has(value) ? value : '/';
}

// 회원가입
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  }
  const passwordError = validateNewPassword(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return res.status(400).json({ error: error.message });
  }

  // 최초 무료 크레딧은 동일 로그인 신원에 한 번만 원자적으로 지급한다.
  if (data.user) {
    try {
      const identityHashes = getWelcomeIdentityHashes(data.user);
      await welcomeCreditStore.ensureProfile(data.user, identityHashes);
    } catch {
      // 이메일 인증 후 첫 로그인에서도 같은 원자적 준비를 다시 시도한다.
      console.error('[signup.profile_prepare_failed]', JSON.stringify({ userId: data.user.id }));
    }
  }

  res.json({ message: '가입이 완료되었습니다.', user: { id: data.user?.id, email: data.user?.email } });
});

// 로그인
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }

  res.json({
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email },
  });
});

// Google OAuth 시작
router.get('/google', async (req, res) => {
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const returnPath = safeOAuthReturnPath(req.query.next);
  const callbackUrl = new URL('/auth/callback', appUrl);
  callbackUrl.searchParams.set('next', returnPath);

  const oauthOptions = {
    redirectTo: callbackUrl.toString(),
    skipBrowserRedirect: true,
  };
  if (returnPath === '/settings') {
    oauthOptions.queryParams = { prompt: 'select_account' };
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: oauthOptions,
  });

  if (error || !data?.url) {
    return res.status(500).json({ error: 'Google 인증 URL 생성에 실패했습니다.' });
  }

  res.redirect(data.url);
});

// 비밀번호 재설정 요청
router.post('/reset-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일을 입력해주세요.' });
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appUrl}/auth/reset`,
  });
  if (error) {
    console.warn('[auth.password_recovery_request_failed]', JSON.stringify({
      requestId: req.requestId,
      code: error.code || 'unknown',
    }));
    return res.status(503).json({ error: '재설정 메일을 발송하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json({ message: '계정이 확인되면 비밀번호 재설정 링크가 발송됩니다.' });
});

// 비밀번호 재설정 링크의 recovery 세션으로 변경
router.put('/recovery-password', async (req, res) => {
  const accessToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  const { refreshToken, newPassword } = req.body || {};

  try {
    const { userId, sessionCleanupError } = await changePasswordWithRecoverySession({
      authClient: createPasswordClient(),
      accessToken,
      refreshToken,
      newPassword,
    });

    if (sessionCleanupError) {
      console.warn('[auth.password_recovery_session_cleanup_failed]', JSON.stringify({
        requestId: req.requestId,
        userId,
        code: sessionCleanupError.code || 'unknown',
      }));
    }

    return res.json({ message: '비밀번호가 재설정되었습니다. 다시 로그인해주세요.' });
  } catch (error) {
    if (error instanceof PasswordChangeError) {
      console.warn('[auth.password_recovery_rejected]', JSON.stringify({
        requestId: req.requestId,
        code: error.code,
      }));
      return res.status(error.status).json({ error: error.message });
    }

    console.error('[auth.password_recovery_failed]', JSON.stringify({
      requestId: req.requestId,
    }));
    return res.status(500).json({ error: '비밀번호 재설정 중 오류가 발생했습니다.' });
  }
});

// 비밀번호 변경 (로그인 상태)
router.put('/password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!req.user.canChangePassword) {
    return res.status(400).json({
      error: 'Google 로그인 계정은 별도의 비밀번호를 사용하지 않습니다.',
    });
  }

  try {
    const { accessToken, sessionCleanupError } = await changePasswordWithCurrentPassword({
      authClient: createPasswordClient(),
      email: req.user.email,
      userId: req.user.id,
      currentPassword,
      newPassword,
    });

    if (sessionCleanupError) {
      console.warn('[auth.password_session_cleanup_failed]', JSON.stringify({
        requestId: req.requestId,
        userId: req.user.id,
        code: sessionCleanupError.code || 'unknown',
      }));
    }

    return res.json({
      message: '비밀번호가 변경되었습니다.',
      token: accessToken,
    });
  } catch (error) {
    if (error instanceof PasswordChangeError) {
      console.warn('[auth.password_change_rejected]', JSON.stringify({
        requestId: req.requestId,
        userId: req.user.id,
        code: error.code,
      }));
      return res.status(error.status).json({ error: error.message });
    }

    console.error('[auth.password_change_failed]', JSON.stringify({
      requestId: req.requestId,
      userId: req.user.id,
    }));
    return res.status(500).json({ error: '비밀번호 변경 중 오류가 발생했습니다.' });
  }
});

// 로그아웃
router.post('/logout', authMiddleware, async (req, res) => {
  await supabase.auth.signOut();
  res.json({ message: '로그아웃되었습니다.' });
});

// 현재 유저 정보
router.get('/me', authMiddleware, async (req, res) => {
  const { id, email, credits, plan, canChangePassword } = req.user;

  const { data: usageLogs, error: logsError } = await supabaseAdmin
    .from('usage_logs')
    .select('*')
    .eq('user_id', id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (logsError) {
    console.error('[/me] usage_logs 조회 실패:', logsError.message);
  }

  const { data: transcriptionLogs, error: transcriptionLogsError } = await supabaseAdmin
    .from('transcription_logs')
    .select('id, user_id, filename, duration_seconds, language, segments_count, text_preview, created_at')
    .eq('user_id', id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (transcriptionLogsError) {
    console.error('[/me] transcription_logs 조회 실패:', transcriptionLogsError.message);
  }

  res.json({
    id,
    email,
    credits,
    plan,
    canChangePassword,
    usageLogs: usageLogs || [],
    transcriptionLogs: transcriptionLogs || [],
  });
});

// 사용 내역 페이지네이션
// type=all(기본): 두 테이블 모두 반환 (초기 로드)
// type=usage: usage_logs만 반환
// type=transcription: transcription_logs만 반환
router.get('/usage-logs', authMiddleware, async (req, res) => {
  const { id } = req.user;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const type = req.query.type || 'all';

  try {
    let usageLogs = null, usageTotal = null;
    let transcriptionLogs = null, transcriptionTotal = null;

    if (type === 'all' || type === 'usage') {
      const [{ data: logs, error: logsErr }, { count, error: countErr }] = await Promise.all([
        supabaseAdmin.from('usage_logs').select('*').eq('user_id', id)
          .order('created_at', { ascending: false }).range(offset, offset + limit - 1),
        supabaseAdmin.from('usage_logs').select('*', { count: 'exact', head: true }).eq('user_id', id),
      ]);
      if (logsErr) throw new Error(logsErr.message);
      if (countErr) throw new Error(countErr.message);
      usageLogs = logs || [];
      usageTotal = count || 0;
    }

    if (type === 'all' || type === 'transcription') {
      const [{ data: logs, error: logsErr }, { count, error: countErr }] = await Promise.all([
        supabaseAdmin.from('transcription_logs')
          .select('id, user_id, filename, duration_seconds, language, segments_count, text_preview, created_at')
          .eq('user_id', id)
          .order('created_at', { ascending: false }).range(offset, offset + limit - 1),
        supabaseAdmin.from('transcription_logs').select('*', { count: 'exact', head: true }).eq('user_id', id),
      ]);
      if (logsErr) throw new Error(logsErr.message);
      if (countErr) throw new Error(countErr.message);
      transcriptionLogs = logs || [];
      transcriptionTotal = count || 0;
    }

    res.json({ usageLogs, usageTotal, transcriptionLogs, transcriptionTotal });
  } catch (err) {
    console.error('[/usage-logs]', err.message);
    res.status(500).json({ error: '사용 내역을 불러오지 못했습니다.' });
  }
});

// 특정 변환 기록 상세 조회 (segments 포함)
router.get('/transcription/:id', authMiddleware, async (req, res) => {
  const { id: logId } = req.params;
  const { id: userId } = req.user;

  const { data, error } = await supabaseAdmin
    .from('transcription_logs')
    .select('*')
    .eq('id', logId)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: '변환 기록을 찾을 수 없습니다.' });
  }

  res.json(data);
});

export default router;
