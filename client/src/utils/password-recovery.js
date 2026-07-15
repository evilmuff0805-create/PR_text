export const PASSWORD_RECOVERY_STORAGE_KEY = 'passwordRecoverySession';

const PASSWORD_RECOVERY_PATHS = new Set(['/auth/reset', '/reset-password']);

export function isPasswordRecoveryPath(pathname) {
  return PASSWORD_RECOVERY_PATHS.has(pathname);
}

export function parsePasswordRecoveryHash(hash, pathname) {
  if (!isPasswordRecoveryPath(pathname)) return { kind: 'not-recovery' };
  if (!hash) return { kind: 'missing' };

  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const errorCode = params.get('error_code') || params.get('error');
  if (errorCode) {
    const isExpired = errorCode === 'otp_expired'
      || String(params.get('error_description') || '').toLowerCase().includes('expired');
    return {
      kind: 'error',
      message: isExpired
        ? '재설정 링크가 만료되었거나 이미 사용되었습니다.'
        : '비밀번호 재설정 링크가 유효하지 않습니다.',
    };
  }

  if (params.get('type') !== 'recovery') {
    return { kind: 'error', message: '비밀번호 재설정 링크가 유효하지 않습니다.' };
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) {
    return { kind: 'error', message: '비밀번호 재설정 링크가 유효하지 않습니다.' };
  }

  return { kind: 'session', session: { accessToken, refreshToken } };
}

export function loadPasswordRecoverySession(storage) {
  try {
    const stored = JSON.parse(storage.getItem(PASSWORD_RECOVERY_STORAGE_KEY));
    if (stored?.accessToken && stored?.refreshToken) return stored;
  } catch {
    // Invalid temporary state is treated as a missing recovery session.
  }
  storage.removeItem(PASSWORD_RECOVERY_STORAGE_KEY);
  return null;
}

export function savePasswordRecoverySession(storage, session) {
  storage.setItem(PASSWORD_RECOVERY_STORAGE_KEY, JSON.stringify(session));
}

export function clearPasswordRecoverySession(storage) {
  storage.removeItem(PASSWORD_RECOVERY_STORAGE_KEY);
}
