export const MIN_PASSWORD_LENGTH = 8;

export class PasswordChangeError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.name = 'PasswordChangeError';
    this.code = code;
    this.status = status;
  }
}

export function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`;
  }
  return null;
}

export function userHasPasswordIdentity(user) {
  const configuredProviders = user?.app_metadata?.providers;
  const providers = Array.isArray(configuredProviders)
    ? configuredProviders
    : [user?.app_metadata?.provider].filter(Boolean);

  return providers.length === 0 || providers.includes('email');
}

export async function changePasswordWithCurrentPassword({
  authClient,
  email,
  userId,
  currentPassword,
  newPassword,
}) {
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw new PasswordChangeError('현재 비밀번호를 입력해주세요.', {
      code: 'CURRENT_PASSWORD_REQUIRED',
    });
  }

  const passwordError = validateNewPassword(newPassword);
  if (passwordError) {
    throw new PasswordChangeError(passwordError, { code: 'PASSWORD_TOO_SHORT' });
  }

  if (currentPassword === newPassword) {
    throw new PasswordChangeError('새 비밀번호는 현재 비밀번호와 달라야 합니다.', {
      code: 'PASSWORD_UNCHANGED',
    });
  }

  const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
    email,
    password: currentPassword,
  });

  if (
    signInError
    || !signInData?.session?.access_token
    || !signInData?.user
    || signInData.user.id !== userId
  ) {
    throw new PasswordChangeError('현재 비밀번호가 올바르지 않습니다.', {
      code: 'CURRENT_PASSWORD_INVALID',
      status: 401,
    });
  }

  const { error: updateError } = await authClient.auth.updateUser({
    password: newPassword,
    current_password: currentPassword,
  });

  if (updateError) {
    const code = String(updateError.code || '').toLowerCase();
    if (code === 'same_password') {
      throw new PasswordChangeError('새 비밀번호는 현재 비밀번호와 달라야 합니다.', {
        code: 'PASSWORD_UNCHANGED',
      });
    }
    if (code === 'weak_password') {
      throw new PasswordChangeError('새 비밀번호가 보안 기준을 충족하지 않습니다.', {
        code: 'PASSWORD_TOO_WEAK',
      });
    }
    throw new PasswordChangeError('비밀번호 변경을 완료하지 못했습니다.', {
      code: 'PASSWORD_UPDATE_REJECTED',
    });
  }

  const { error: sessionCleanupError } = await authClient.auth.signOut({ scope: 'others' });

  return {
    accessToken: signInData.session.access_token,
    sessionCleanupError,
  };
}
