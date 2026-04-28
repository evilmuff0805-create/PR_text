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

// 비밀번호 변경 (로그인 상태)
router.put('/password', authMiddleware, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    password: newPassword,
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: '비밀번호가 변경되었습니다.' });
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
    .select('id, user_id, filename, duration_seconds, language, segments_count, text_preview, created_at')
    .eq('user_id', id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (transcriptionLogsError) {
    console.error('[/me] transcription_logs 조회 실패:', transcriptionLogsError.message);
  }

  res.json({ id, email, credits, plan, usageLogs: usageLogs || [], transcriptionLogs: transcriptionLogs || [] });
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
