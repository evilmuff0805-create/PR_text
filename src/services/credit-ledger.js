import { supabaseAdmin } from '../lib/supabase.js';

function firstResult(data, message) {
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) throw new Error(message);
  return result;
}

export function createCreditLedgerStore(database = supabaseAdmin) {
  return {
    async expireForUser(userId) {
      const { data, error } = await database.rpc('expire_credit_lots_for_user', {
        p_user_id: userId,
      });

      if (error) throw error;
      return firstResult(data, '크레딧 사용 기한 처리 결과를 받지 못했습니다.');
    },

    async expireDue(limit = 100) {
      const { data, error } = await database.rpc('expire_due_credit_lots', {
        p_limit: limit,
      });

      if (error) throw error;
      return firstResult(data, '만료 크레딧 정리 결과를 받지 못했습니다.');
    },
  };
}

export const creditLedgerStore = createCreditLedgerStore();

export function startCreditLedgerMaintenance(store = creditLedgerStore) {
  const run = async () => {
    try {
      const result = await store.expireDue();
      if (result.users_processed || result.credits_expired) {
        console.log('[credit.expiry]', JSON.stringify({
          usersProcessed: result.users_processed,
          creditsExpired: result.credits_expired,
        }));
      }
      if (result.discrepancies) {
        console.error('[credit.ledger_discrepancy]', JSON.stringify({
          discrepancies: result.discrepancies,
        }));
      }
    } catch (error) {
      console.warn('[credit.expiry_failed]', JSON.stringify({ message: error.message }));
    }
  };

  const initialTimer = setTimeout(run, 30_000);
  initialTimer.unref?.();
  const interval = setInterval(run, 60 * 60 * 1000);
  interval.unref?.();
  return interval;
}
