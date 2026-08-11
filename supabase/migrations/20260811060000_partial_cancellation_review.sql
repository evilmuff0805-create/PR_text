-- 토스 상점관리자에서 부분 취소를 하면 PARTIAL_CANCELED 웹훅이 오는데,
-- 지금은 이 이벤트를 무시해서 돈은 환불되고 크레딧은 그대로 남는다.
-- 부분 취소분에 비례하는 크레딧을 회수하되, 이미 써버려서 회수할 수 없으면
-- 운영자가 볼 수 있도록 review_required로 남긴다.

create or replace function public.reconcile_partial_payment_cancellation(
  p_order_id text,
  p_payment_key text,
  p_canceled_amount integer
)
returns table (
  reclaimed integer,
  credits_remaining integer,
  manual_review boolean,
  already_handled boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_balance integer;
  v_reclaim integer;
begin
  if p_canceled_amount is null or p_canceled_amount <= 0 then
    raise exception using errcode = 'PR001', message = '부분 취소 금액이 올바르지 않습니다.';
  end if;

  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'PR002', message = '주문을 찾을 수 없습니다.';
  end if;

  -- 이미 검토 대상으로 표시했거나 전액 환불이 끝난 주문은 다시 건드리지 않는다.
  if v_order.refund_status in ('refunded', 'review_required') then
    return query select 0, coalesce(
      (select p.credits from public.profiles as p where p.id = v_order.user_id), 0
    ), v_order.refund_status = 'review_required', true;
    return;
  end if;

  if v_order.status <> 'paid' then
    raise exception using errcode = 'PR005', message = '결제 완료되지 않은 주문입니다.';
  end if;

  -- 취소 금액 비율만큼 크레딧을 회수한다. 올림으로 계산하면 사용자에게 불리하므로 내림.
  v_reclaim := floor(v_order.credits::numeric * p_canceled_amount::numeric / v_order.amount::numeric);

  select p.credits
  into v_balance
  from public.profiles as p
  where p.id = v_order.user_id
  for update;

  if v_balance is null then
    raise exception using errcode = 'PR003', message = '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  -- 이미 써버려서 회수할 수 없으면 잔액을 건드리지 않고 운영자 검토로 넘긴다.
  if v_reclaim > v_balance then
    update public.payment_orders as o
    set refund_status = 'review_required',
        payment_key = coalesce(o.payment_key, p_payment_key),
        refund_error_code = 'PARTIAL_CANCEL_CREDITS_USED',
        updated_at = now()
    where o.order_id = p_order_id;

    return query select 0, v_balance, true, false;
    return;
  end if;

  update public.profiles as p
  set credits = p.credits - v_reclaim,
      updated_at = now()
  where p.id = v_order.user_id
  returning p.credits into v_balance;

  update public.payment_orders as o
  set refund_status = 'review_required',
      payment_key = coalesce(o.payment_key, p_payment_key),
      refund_error_code = 'PARTIAL_CANCELED',
      updated_at = now()
  where o.order_id = p_order_id;

  -- action 값은 기존 환불 동기화와 같은 것을 쓴다. 부분 취소라는 사실은 설명에 남긴다.
  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    v_order.user_id,
    'payment_refund_reconcile',
    v_reclaim,
    v_order.order_id,
    format('%s 부분 취소 반영 (%s원 취소, %s분 회수)',
      v_order.plan_name,
      to_char(p_canceled_amount, 'FM999,999,999,990'),
      v_reclaim)
  );

  return query select v_reclaim, v_balance, false, false;
end;
$$;

revoke all on function public.reconcile_partial_payment_cancellation(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_partial_payment_cancellation(text, text, integer)
  to service_role;
