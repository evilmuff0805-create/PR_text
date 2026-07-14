import { supabaseAdmin } from '../lib/supabase.js';

export function createPaymentOrderStore(database = supabaseAdmin) {
  return {
    async create(order) {
      const { error } = await database.from('payment_orders').insert(order);
      if (error) throw error;
    },

    async find(orderId) {
      const { data, error } = await database
        .from('payment_orders')
        .select('order_id, user_id, amount, credits, status, payment_key, idempotency_key')
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
      const result = Array.isArray(data) ? data[0] : data;
      if (!result) throw new Error('결제 완료 결과를 받지 못했습니다.');
      return result;
    },
  };
}

export const paymentOrderStore = createPaymentOrderStore();
