import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { createPasswordClient, supabaseAdmin } from '../lib/supabase.js';
import {
  AccountDeletionError,
  accountDeletionStore,
  removeAccountAudio,
  toAccountDeletionPreview,
  verifyAccountDeletionIdentity,
} from '../services/account-deletion.js';

const DATABASE_BLOCKERS = new Set(['AD002', 'AD003', 'AD004', 'AD005']);

function safeDatabaseError(error) {
  if (DATABASE_BLOCKERS.has(error?.code)) {
    return new AccountDeletionError(error.message, { code: error.code, status: 409 });
  }
  return error;
}

export function createAccountRouter({
  auth = authMiddleware,
  store = accountDeletionStore,
  authAdmin = supabaseAdmin.auth.admin,
  storage = supabaseAdmin.storage,
  passwordClient = createPasswordClient,
  now = () => Date.now(),
} = {}) {
  const router = Router();

  router.get('/deletion-preview', auth, async (req, res) => {
    try {
      const preview = await store.preview(req.user.id);
      return res.json(toAccountDeletionPreview(preview, req.user, now()));
    } catch (error) {
      console.error('[account.deletion_preview_failed]', JSON.stringify({
        requestId: req.requestId,
        userId: req.user.id,
        code: error.code,
      }));
      return res.status(500).json({ error: '탈퇴 가능 여부를 확인하지 못했습니다.' });
    }
  });

  router.delete('/', auth, async (req, res) => {
    let deletion;

    try {
      const previewRow = await store.preview(req.user.id);
      const preview = toAccountDeletionPreview(previewRow, req.user, now());

      if (!preview.canDelete) {
        return res.status(409).json({
          error: preview.blockerMessage,
          code: preview.blockerReason,
          preview,
        });
      }

      await verifyAccountDeletionIdentity({
        user: req.user,
        confirmationEmail: req.body?.confirmationEmail,
        currentPassword: req.body?.currentPassword,
        authClient: passwordClient(),
        now: now(),
      });

      await store.recordWelcomeCreditClaim(req.user.welcomeIdentityHashes);
      await removeAccountAudio(storage, req.user.id);
      deletion = await store.begin(req.user.id);

      const { error: signOutError } = await authAdmin.signOut(req.user.token, 'global');
      if (signOutError) {
        console.warn('[account.deletion_session_cleanup_failed]', JSON.stringify({
          requestId: req.requestId,
          deletionId: deletion.deletion_id,
          code: signOutError.code,
        }));
      }

      const { error: deleteError } = await authAdmin.deleteUser(req.user.id);
      if (deleteError) {
        try {
          await store.fail(deletion.deletion_id, deleteError.code);
        } catch (statusError) {
          console.error('[account.deletion_failure_record_failed]', JSON.stringify({
            requestId: req.requestId,
            deletionId: deletion.deletion_id,
            code: statusError.code,
          }));
        }

        console.error('[account.auth_delete_failed]', JSON.stringify({
          requestId: req.requestId,
          deletionId: deletion.deletion_id,
          code: deleteError.code,
        }));
        return res.status(503).json({
          error: '계정 데이터 정리는 완료했지만 인증 계정 삭제를 마치지 못했습니다. 고객센터에 문의해주세요.',
          code: 'ACCOUNT_DELETE_INCOMPLETE',
        });
      }

      try {
        await store.complete(deletion.deletion_id);
      } catch (completeError) {
        console.error('[account.deletion_completion_record_failed]', JSON.stringify({
          requestId: req.requestId,
          deletionId: deletion.deletion_id,
          code: completeError.code,
        }));
      }

      console.log('[account.deleted]', JSON.stringify({
        requestId: req.requestId,
        deletionId: deletion.deletion_id,
        creditsForfeited: deletion.credits_forfeited,
      }));
      return res.json({
        success: true,
        message: '회원 탈퇴가 완료되었습니다.',
      });
    } catch (rawError) {
      const error = safeDatabaseError(rawError);
      if (error instanceof AccountDeletionError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }

      console.error('[account.deletion_failed]', JSON.stringify({
        requestId: req.requestId,
        deletionId: deletion?.deletion_id,
        code: error.code,
      }));
      return res.status(500).json({ error: '회원 탈퇴를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' });
    }
  });

  return router;
}

export default createAccountRouter();
