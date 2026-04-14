import { supabase, supabaseAdmin } from '../lib/supabase.js';

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

  // 없으면 생성, 있으면 그대로 (ignoreDuplicates: true = 충돌 시 스킵)
  await supabaseAdmin
    .from('profiles')
    .upsert(
      { id: user.id, email: user.email, credits: 10, plan: 'free' },
      { onConflict: 'id', ignoreDuplicates: true }
    );

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('credits, plan')
    .eq('id', user.id)
    .single();

  req.user = {
    id: user.id,
    email: user.email,
    credits: profile?.credits ?? 10,
    plan: profile?.plan ?? 'free',
    token,
  };

  next();
}
