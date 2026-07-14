alter table public.payment_orders
  add column refund_status text not null default 'none'
    check (refund_status in ('none', 'pending', 'refunded', 'failed', 'review_required')),
  add column refund_idempotency_key uuid,
  add column refund_reason text
    check (refund_reason is null or char_length(refund_reason) between 1 and 200),
  add column refund_requested_at timestamptz,
  add column refunded_at timestamptz,
  add column refund_error_code text
    check (refund_error_code is null or char_length(refund_error_code) <= 100),
  add column refund_credits_reclaimed boolean not null default false;

create unique index payment_orders_refund_idempotency_key_idx
  on public.payment_orders (refund_idempotency_key)
  where refund_idempotency_key is not null;

drop index public.usage_logs_order_id_unique;

create unique index usage_logs_order_action_unique
  on public.usage_logs (order_id, action)
  where order_id is not null;

create or replace function public.prepare_payment_refund(
  p_order_id text,
  p_user_id uuid,
  p_reason text
)
returns table (
  order_id text,
  payment_key text,
  amount integer,
  credits integer,
  refund_idempotency_key uuid,
  refund_status text,
  credits_remaining integer,
  already_refunded boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_balance integer;
  v_has_usage boolean;
  v_refund_key uuid;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 1 or char_length(p_reason) > 200 then
    raise exception using errcode = 'PR006', message = '환불 사유가 올바르지 않습니다.';
  end if;

  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found or v_order.user_id <> p_user_id then
    raise exception using errcode = 'PR001', message = '결제 주문을 찾을 수 없습니다.';
  end if;

  if v_order.status <> 'paid' or v_order.payment_key is null then
    raise exception using errcode = 'PR002', message = '완료된 결제만 환불할 수 있습니다.';
  end if;

  select p.credits
  into v_balance
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if v_balance is null then
    raise exception using errcode = 'PR001', message = '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  if v_order.refund_status = 'refunded' then
    return query select
      v_order.order_id,
      v_order.payment_key,
      v_order.amount,
      v_order.credits,
      v_order.refund_idempotency_key,
      v_order.refund_status,
      v_balance,
      true;
    return;
  end if;

  if v_order.refund_status = 'pending' then
    if not v_order.refund_credits_reclaimed or v_order.refund_idempotency_key is null then
      raise exception '환불 보류 상태가 올바르지 않습니다.';
    end if;

    return query select
      v_order.order_id,
      v_order.payment_key,
      v_order.amount,
      v_order.credits,
      v_order.refund_idempotency_key,
      v_order.refund_status,
      v_balance,
      false;
    return;
  end if;

  if v_order.refund_status in ('failed', 'review_required') then
    raise exception using errcode = 'PR005', message = '자동 환불을 다시 시도할 수 없습니다. 고객센터에 문의해주세요.';
  end if;

  select exists (
    select 1
    from public.usage_logs as u
    where u.user_id = p_user_id
      and u.created_at > v_order.approved_at
      and coalesce(u.credits_used, 0) > 0
  )
  into v_has_usage;

  if v_has_usage then
    raise exception using errcode = 'PR003', message = '결제 이후 변환 시간을 사용한 주문은 자동 환불할 수 없습니다.';
  end if;

  if v_balance < v_order.credits then
    raise exception using errcode = 'PR004', message = '환불할 결제의 변환 시간이 부족합니다.';
  end if;

  v_refund_key := gen_random_uuid();

  update public.profiles as p
  set credits = p.credits - v_order.credits,
      updated_at = now()
  where p.id = p_user_id
  returning p.credits into v_balance;

  update public.payment_orders as o
  set refund_status = 'pending',
      refund_idempotency_key = v_refund_key,
      refund_reason = btrim(p_reason),
      refund_requested_at = now(),
      refund_error_code = null,
      refund_credits_reclaimed = true,
      updated_at = now()
  where o.order_id = p_order_id;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    p_user_id,
    'payment_refund',
    v_order.credits,
    v_order.order_id,
    format('%s 결제 환불 처리 중 (%s원)', v_order.plan_name, to_char(v_order.amount, 'FM999,999,999,990'))
  );

  return query select
    v_order.order_id,
    v_order.payment_key,
    v_order.amount,
    v_order.credits,
    v_refund_key,
    'pending'::text,
    v_balance,
    false;
end;
$$;

create or replace function public.complete_payment_refund(
  p_order_id text,
  p_user_id uuid,
  p_payment_key text
)
returns table (credits_remaining integer, refunded integer, already_refunded boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_balance integer;
begin
  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found or v_order.user_id <> p_user_id then
    raise exception using errcode = 'PR001', message = '결제 주문을 찾을 수 없습니다.';
  end if;

  if v_order.payment_key <> p_payment_key then
    raise exception '결제 정보가 일치하지 않습니다.';
  end if;

  select p.credits
  into v_balance
  from public.profiles as p
  where p.id = p_user_id;

  if v_order.refund_status = 'refunded' then
    return query select v_balance, v_order.credits, true;
    return;
  end if;

  if v_order.refund_status <> 'pending' or not v_order.refund_credits_reclaimed then
    raise exception '완료할 수 있는 환불 보류 상태가 아닙니다.';
  end if;

  update public.payment_orders as o
  set refund_status = 'refunded',
      refunded_at = now(),
      refund_error_code = null,
      updated_at = now()
  where o.order_id = p_order_id;

  update public.usage_logs as u
  set description = format('%s 결제 환불 완료 (%s원)', v_order.plan_name, to_char(v_order.amount, 'FM999,999,999,990'))
  where u.order_id = p_order_id
    and u.action = 'payment_refund';

  return query select v_balance, v_order.credits, false;
end;
$$;

create or replace function public.fail_payment_refund(
  p_order_id text,
  p_user_id uuid,
  p_error_code text
)
returns table (credits_remaining integer, restored integer, already_failed boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_balance integer;
begin
  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found or v_order.user_id <> p_user_id then
    raise exception using errcode = 'PR001', message = '결제 주문을 찾을 수 없습니다.';
  end if;

  if v_order.refund_status = 'failed' and not v_order.refund_credits_reclaimed then
    select p.credits into v_balance
    from public.profiles as p
    where p.id = p_user_id;

    return query select v_balance, v_order.credits, true;
    return;
  end if;

  if v_order.refund_status <> 'pending' or not v_order.refund_credits_reclaimed then
    raise exception '실패 처리할 수 있는 환불 보류 상태가 아닙니다.';
  end if;

  update public.profiles as p
  set credits = p.credits + v_order.credits,
      updated_at = now()
  where p.id = p_user_id
  returning p.credits into v_balance;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    p_user_id,
    'payment_refund_restore',
    -v_order.credits,
    v_order.order_id,
    format('%s 환불 실패 크레딧 복구', v_order.plan_name)
  );

  update public.payment_orders as o
  set refund_status = 'failed',
      refund_error_code = left(coalesce(p_error_code, 'UNKNOWN'), 100),
      refund_credits_reclaimed = false,
      updated_at = now()
  where o.order_id = p_order_id;

  return query select v_balance, v_order.credits, false;
end;
$$;

create or replace function public.reconcile_canceled_payment_refund(
  p_order_id text,
  p_payment_key text
)
returns table (
  credits_remaining integer,
  refunded integer,
  manual_review boolean,
  already_refunded boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_balance integer;
  v_action text;
begin
  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found or v_order.payment_key <> p_payment_key or v_order.status <> 'paid' then
    raise exception '취소된 결제 주문 정보가 일치하지 않습니다.';
  end if;

  select p.credits
  into v_balance
  from public.profiles as p
  where p.id = v_order.user_id
  for update;

  if v_order.refund_status = 'refunded' then
    return query select v_balance, v_order.credits, false, true;
    return;
  end if;

  if v_order.refund_status = 'pending' and v_order.refund_credits_reclaimed then
    update public.payment_orders as o
    set refund_status = 'refunded',
        refunded_at = now(),
        refund_error_code = null,
        updated_at = now()
    where o.order_id = p_order_id;

    update public.usage_logs as u
    set description = format('%s 결제 환불 완료 (%s원)', v_order.plan_name, to_char(v_order.amount, 'FM999,999,999,990'))
    where u.order_id = p_order_id
      and u.action = 'payment_refund';

    return query select v_balance, v_order.credits, false, false;
    return;
  end if;

  if v_balance < v_order.credits then
    update public.payment_orders as o
    set refund_status = 'review_required',
        refund_error_code = 'INSUFFICIENT_CREDITS_AFTER_PROVIDER_CANCEL',
        refund_credits_reclaimed = false,
        updated_at = now()
    where o.order_id = p_order_id;

    return query select v_balance, v_order.credits, true, false;
    return;
  end if;

  update public.profiles as p
  set credits = p.credits - v_order.credits,
      updated_at = now()
  where p.id = v_order.user_id
  returning p.credits into v_balance;

  v_action := case
    when v_order.refund_status = 'none' then 'payment_refund'
    else 'payment_refund_reconcile'
  end;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    v_order.user_id,
    v_action,
    v_order.credits,
    v_order.order_id,
    format('%s Toss 취소 동기화 (%s원)', v_order.plan_name, to_char(v_order.amount, 'FM999,999,999,990'))
  );

  update public.payment_orders as o
  set refund_status = 'refunded',
      refund_reason = coalesce(o.refund_reason, 'Toss 취소 상태 동기화'),
      refunded_at = now(),
      refund_error_code = null,
      refund_credits_reclaimed = true,
      updated_at = now()
  where o.order_id = p_order_id;

  return query select v_balance, v_order.credits, false, false;
end;
$$;

create or replace function public.list_payment_orders_for_refund(
  p_user_id uuid,
  p_limit integer default 10
)
returns table (
  order_id text,
  plan_name text,
  amount integer,
  credits integer,
  payment_status text,
  refund_status text,
  created_at timestamptz,
  approved_at timestamptz,
  refunded_at timestamptz,
  can_refund boolean,
  can_retry boolean,
  eligibility_reason text
)
language sql
security invoker
set search_path = ''
as $$
  select
    o.order_id,
    o.plan_name,
    o.amount,
    o.credits,
    o.status,
    o.refund_status,
    o.created_at,
    o.approved_at,
    o.refunded_at,
    (
      o.status = 'paid'
      and o.refund_status = 'none'
      and p.credits >= o.credits
      and not exists (
        select 1
        from public.usage_logs as u
        where u.user_id = p_user_id
          and u.created_at > o.approved_at
          and coalesce(u.credits_used, 0) > 0
      )
    ) as can_refund,
    (o.status = 'paid' and o.refund_status = 'pending') as can_retry,
    case
      when o.status <> 'paid' then 'not_paid'
      when o.refund_status = 'pending' then 'pending'
      when o.refund_status = 'refunded' then 'refunded'
      when o.refund_status = 'failed' then 'failed'
      when o.refund_status = 'review_required' then 'review_required'
      when p.credits < o.credits then 'insufficient_credits'
      when exists (
        select 1
        from public.usage_logs as u
        where u.user_id = p_user_id
          and u.created_at > o.approved_at
          and coalesce(u.credits_used, 0) > 0
      ) then 'credits_used'
      else null
    end as eligibility_reason
  from public.payment_orders as o
  join public.profiles as p on p.id = o.user_id
  where o.user_id = p_user_id
  order by o.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 20));
$$;

revoke all on function public.prepare_payment_refund(text, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_payment_refund(text, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_payment_refund(text, uuid, text) from public, anon, authenticated;
revoke all on function public.reconcile_canceled_payment_refund(text, text) from public, anon, authenticated;
revoke all on function public.list_payment_orders_for_refund(uuid, integer) from public, anon, authenticated;

grant execute on function public.prepare_payment_refund(text, uuid, text) to service_role;
grant execute on function public.complete_payment_refund(text, uuid, text) to service_role;
grant execute on function public.fail_payment_refund(text, uuid, text) to service_role;
grant execute on function public.reconcile_canceled_payment_refund(text, text) to service_role;
grant execute on function public.list_payment_orders_for_refund(uuid, integer) to service_role;

notify pgrst, 'reload schema';
