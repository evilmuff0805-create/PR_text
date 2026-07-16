import { createHash } from 'node:crypto';
import { createPasswordClient, supabaseAdmin } from '../lib/supabase.js';

const STORAGE_BUCKET = 'transcription-jobs';
export const RECENT_LOGIN_WINDOW_MS = 10 * 60 * 1000;

const BLOCKER_MESSAGES = {
  active_job: '진행 중인 변환 작업을 완료하거나 취소한 뒤 다시 시도해주세요.',
  pending_payment: '확인 중인 결제가 있습니다. 결제 내역을 먼저 확인해주세요.',
  unresolved_refund: '처리가 끝나지 않은 환불 요청이 있습니다. 고객센터에 문의해주세요.',
  paid_credit_review: '결제한 크레딧이 남아 있어 환불 가능 여부 확인이 필요합니다.',
};

export class AccountDeletionError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.name = 'AccountDeletionError';
    this.code = code;
    this.status = status;
  }
}

export function hashAccountIdentity(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

export function isRecentLogin(lastSignInAt, now = Date.now()) {
  const signedInAt = typeof lastSignInAt === 'number'
    ? lastSignInAt
    : Date.parse(lastSignInAt || '');
  return Number.isFinite(signedInAt)
    && now - signedInAt >= 0
    && now - signedInAt <= RECENT_LOGIN_WINDOW_MS;
}

export function toAccountDeletionPreview(row, user, now = Date.now()) {
  const canChangePassword = user.canChangePassword !== false;
  const credits = Number(row?.credits) || 0;
  const blockerReason = row?.blocker_reason || null;

  return {
    credits,
    canDelete: Boolean(row?.can_delete),
    creditDisposition: row?.credit_disposition || 'none',
    blockerReason,
    blockerMessage: blockerReason ? BLOCKER_MESSAGES[blockerReason] : null,
    activeJobCount: Number(row?.active_job_count) || 0,
    pendingOrderCount: Number(row?.pending_order_count) || 0,
    openPaidOrderCount: Number(row?.open_paid_order_count) || 0,
    unresolvedRefundCount: Number(row?.unresolved_refund_count) || 0,
    confirmationMethod: canChangePassword ? 'password' : 'google',
    requiresRecentLogin: !canChangePassword && !isRecentLogin(user.lastSignInAt, now),
  };
}

export async function verifyAccountDeletionIdentity({
  user,
  confirmationEmail,
  currentPassword,
  authClient = createPasswordClient(),
  now = Date.now(),
}) {
  const normalizedConfirmation = String(confirmationEmail || '').trim().toLowerCase();
  const normalizedEmail = String(user.email || '').trim().toLowerCase();

  if (!normalizedConfirmation || normalizedConfirmation !== normalizedEmail) {
    throw new AccountDeletionError('계정 이메일을 정확히 입력해주세요.', {
      code: 'EMAIL_CONFIRMATION_MISMATCH',
    });
  }

  if (!user.canChangePassword) {
    if (!isRecentLogin(user.lastSignInAt, now)) {
      throw new AccountDeletionError('계정 보호를 위해 Google로 다시 인증해주세요.', {
        code: 'RECENT_LOGIN_REQUIRED',
        status: 403,
      });
    }
    return;
  }

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw new AccountDeletionError('현재 비밀번호를 입력해주세요.', {
      code: 'CURRENT_PASSWORD_REQUIRED',
    });
  }

  const { data, error } = await authClient.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });

  if (error || data?.user?.id !== user.id) {
    throw new AccountDeletionError('현재 비밀번호가 올바르지 않습니다.', {
      code: 'CURRENT_PASSWORD_INVALID',
      status: 401,
    });
  }

  const { error: sessionCleanupError } = await authClient.auth.signOut({ scope: 'local' });
  if (sessionCleanupError) {
    throw new AccountDeletionError('본인 확인 세션을 정리하지 못했습니다. 잠시 후 다시 시도해주세요.', {
      code: 'REAUTH_SESSION_CLEANUP_FAILED',
      status: 503,
    });
  }
}

export function createAccountDeletionStore(database = supabaseAdmin) {
  function firstResult(data, message) {
    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error(message);
    return result;
  }

  return {
    async preview(userId) {
      const { data, error } = await database.rpc('preview_account_deletion', {
        p_user_id: userId,
      });
      if (error) throw error;
      return firstResult(data, '탈퇴 가능 여부를 확인하지 못했습니다.');
    },

    async begin(userId) {
      const { data, error } = await database.rpc('begin_account_deletion', {
        p_user_id: userId,
        p_account_hash: hashAccountIdentity(userId),
      });
      if (error) throw error;
      return firstResult(data, '탈퇴 준비 결과를 확인하지 못했습니다.');
    },

    async recordWelcomeCreditClaim(identityHashes) {
      const { error } = await database.rpc('register_welcome_credit_claims', {
        p_identity_hashes: identityHashes,
      });
      if (error) throw error;
    },

    async complete(deletionId) {
      const { error } = await database
        .from('account_deletions')
        .update({
          user_id: null,
          status: 'completed',
          completed_at: new Date().toISOString(),
          last_error_code: null,
        })
        .eq('id', deletionId);
      if (error) throw error;
    },

    async fail(deletionId, errorCode) {
      const { error } = await database
        .from('account_deletions')
        .update({
          status: 'failed',
          last_error_code: String(errorCode || 'AUTH_DELETE_FAILED').slice(0, 100),
        })
        .eq('id', deletionId);
      if (error) throw error;
    },
  };
}

export async function removeAccountAudio(storage, userId) {
  const bucket = storage.from(STORAGE_BUCKET);
  let offset = 0;

  while (true) {
    const { data: objects, error: listError } = await bucket.list(userId, {
      limit: 100,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (listError) throw listError;
    if (!objects?.length) return;

    const paths = objects
      .filter((object) => object.id)
      .map((object) => `${userId}/${object.name}`);

    if (paths.length > 0) {
      const { error: removeError } = await bucket.remove(paths);
      if (removeError) throw removeError;
    }

    if (objects.length < 100) return;
    if (paths.length === 0) offset += objects.length;
  }
}

export const accountDeletionStore = createAccountDeletionStore();
