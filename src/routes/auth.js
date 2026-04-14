import { Router } from 'express';
import { supabase, supabaseAdmin } from '../lib/supabase.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// 회원가입
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return res.status(400).json({ error: error.message });
  }

  // profiles 테이블에 직접 행 생성
  if (data.user) {
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: data.user.id, email: data.user.email, credits: 10, plan: 'free' });
    if (profileError) {
      console.error('[signup] profiles 생성 실패:', profileError.message);
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
  const redirectTo = `${process.env.APP_URL || 'http://localhost:3000'}/auth/callback`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
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
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.APP_URL || 'http://localhost:3000'}/auth/reset`,
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: '비밀번호 재설정 링크가 이메일로 발송되었습니다.' });
});

// 로그아웃
router.post('/logout', authMiddleware, async (req, res) => {
  await supabase.auth.signOut();
  res.json({ message: '로그아웃되었습니다.' });
});

// 현재 유저 정보
router.get('/me', authMiddleware, async (req, res) => {
  const { id, email, credits, plan } = req.user;

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
    .select('*')
    .eq('user_id', id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (transcriptionLogsError) {
    console.error('[/me] transcription_logs 조회 실패:', transcriptionLogsError.message);
  }

  res.json({ id, email, credits, plan, usageLogs: usageLogs || [], transcriptionLogs: transcriptionLogs || [] });
});

export default router;
