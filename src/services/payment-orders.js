import { supabaseAdmin } from '../lib/supabase.js';

export function createPaymentOrderStore(database = supabaseAdmin) {
  function firstResult(data, message) {
    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error(message);
    return result;
  }

  return {
    async create(order) {
      const { error } = await database.from('payment_orders').insert(order);
      if (error) throw error;
    },

    async find(orderId) {
      const { data, error } = await database
        .from('payment_orders')
        .select(`
          order_id,
          user_id,
          amount,
          credits,
          status,
          payment_key,
          payment_environment,
          idempotency_key,
          refund_status,
          refund_idempotency_key,
          refund_reason,
          refund_credits_reclaimed,
          account_deleted_at
        `)
        .eq('order_id', orderId)
        .maybeSingle();

      if (error) throw error;
      return data;
    },

    async getCurrentCredits(userId) {
      const { data, error } = await database
        .from('profiles')
        .select('credits')
        .eq('id', userId)
        .single();

      if (error) throw error;
      return data.credits;
    },

    async complete({ orderId, userId, paymentKey }) {
      const { data, error } = await database.rpc('complete_payment_order', {
        p_order_id: orderId,
        p_user_id: userId,
        p_payment_key: paymentKey,
      });

      if (error) throw error;
      return firstResult(data, '결제 완료 결과를 받지 못했습니다.');
    },

    async listForRefund(userId, limit = 10) {
      const { data, error } = await database.rpc('list_payment_orders_for_refund', {
        p_user_id: userId,
        p_limit: limit,
      });

      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },

    async prepareRefund({ orderId, userId, reason }) {
      const { data, error } = await database.rpc('prepare_payment_refund', {
        p_order_id: orderId,
        p_user_id: userId,
        p_reason: reason,
      });

      if (error) throw error;
      return firstResult(data, '환불 준비 결과를 받지 못했습니다.');
    },

    async completeRefund({ orderId, userId, paymentKey }) {
      const { data, error } = await database.rpc('complete_payment_refund', {
        p_order_id: orderId,
        p_user_id: userId,
        p_payment_key: paymentKey,
      });

      if (error) throw error;
      return firstResult(data, '환불 완료 결과를 받지 못했습니다.');
    },

    async failRefund({ orderId, userId, errorCode }) {
      const { data, error } = await database.rpc('fail_payment_refund', {
        p_order_id: orderId,
        p_user_id: userId,
        p_error_code: errorCode,
      });

      if (error) throw error;
      return firstResult(data, '환불 실패 복구 결과를 받지 못했습니다.');
    },

    async reconcileCanceledRefund({ orderId, paymentKey }) {
      const { data, error } = await database.rpc('reconcile_canceled_payment_refund', {
        p_order_id: orderId,
        p_payment_key: paymentKey,
      });

      if (error) throw error;
      return firstResult(data, '취소 결제 동기화 결과를 받지 못했습니다.');
    },

    async recordDeletedAccountCancellation({ orderId, paymentKey }) {
      const { data, error } = await database.rpc('record_deleted_account_payment_cancellation', {
        p_order_id: orderId,
        p_payment_key: paymentKey,
      });

      if (error) throw error;
      return firstResult(data, '탈퇴 계정의 취소 결제 상태를 기록하지 못했습니다.');
    },
  };
}

export const paymentOrderStore = createPaymentOrderStore();
