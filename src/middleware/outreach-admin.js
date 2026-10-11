import { supabase } from '../lib/supabase.js';
import { UUID_PATTERN } from '../services/outreach-validation.js';

// No profile creation, credit expiry or user-editable metadata participates in this gate.
export function createOutreachAdminMiddleware({ auth = supabase.auth, env = () => process.env } = {}) {
  return async function outreachAdmin(req, res, next) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header) || header.length > 8192) {
      return res.status(401).json({ error: '관리자 로그인이 필요합니다.', code: 'OUTREACH_AUTH_REQUIRED' });
    }
    const allowed = new Set((env().OUTREACH_ADMIN_USER_IDS || '').split(',').map(id => id.trim().toLowerCase()).filter(id => UUID_PATTERN.test(id)));
    try {
      const { data, error } = await auth.getUser(header.slice(7));
      if (error || !data?.user) {
        const unavailable = error && (!error.status || error.status >= 500);
        return res.status(unavailable ? 503 : 401).json({
          error: unavailable ? '관리자 인증을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.' : '유효한 관리자 로그인이 필요합니다.',
          code: unavailable ? 'OUTREACH_AUTH_UNAVAILABLE' : 'OUTREACH_AUTH_REQUIRED',
        });
      }
      const id = data.user.id;
      if (data.user.is_anonymous || typeof id !== 'string' || !allowed.has(id.toLowerCase())) {
        return res.status(403).json({ error: '홍보 발송 관리자 권한이 필요합니다.', code: 'OUTREACH_ADMIN_REQUIRED' });
      }
      req.outreachAdmin = { id };
      return next();
    } catch {
      return res.status(503).json({ error: '관리자 인증을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.', code: 'OUTREACH_AUTH_UNAVAILABLE' });
    }
  };
}

export const outreachAdminMiddleware = createOutreachAdminMiddleware();
