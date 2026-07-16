alter table public.payment_orders
  alter column user_id drop not null,
  add column account_deleted_at timestamptz;

alter table public.payment_orders
  drop constraint payment_orders_user_id_fkey,
  add constraint payment_orders_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;

create table public.account_deletions (
  id uuid primary key default gen_random_uuid(),
  account_hash text not null unique check (account_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid unique,
  status text not null default 'processing'
    check (status in ('processing', 'prepared', 'completed', 'failed')),
  credits_forfeited integer not null default 0 check (credits_forfeited >= 0),
  requested_at timestamptz not null default now(),
  prepared_at timestamptz,
  completed_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100)
);

alter table public.account_deletions enable row level security;

revoke all on table public.account_deletions from public, anon, authenticated;
grant select, insert, update on table public.account_deletions to service_role;

create or replace function public.preview_account_deletion(p_user_id uuid)
returns table (
  credits integer,
  active_job_count integer,
  pending_order_count integer,
  open_paid_order_count integer,
  unresolved_refund_count integer,
  can_delete boolean,
  credit_disposition text,
  blocker_reason text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_credits integer;
  v_active_jobs integer;
  v_pending_orders integer;
  v_open_paid_orders integer;
  v_unresolved_refunds integer;
begin
  select p.credits
  into v_credits
  from public.profiles as p
  where p.id = p_user_id;

  if v_credits is null then
    raise exception using errcode = 'AD001', message = '계정 정보를 찾을 수 없습니다.';
  end if;

  select count(*)::integer
  into v_active_jobs
  from public.transcription_jobs as j
  where j.user_id = p_user_id
    and j.status in ('queued', 'running');

  select
    count(*) filter (where o.status = 'pending')::integer,
    count(*) filter (
      where o.status = 'paid' and o.refund_status = 'none'
    )::integer,
    count(*) filter (
      where o.status = 'paid'
        and o.refund_status in ('pending', 'failed', 'review_required')
    )::integer
  into v_pending_orders, v_open_paid_orders, v_unresolved_refunds
  from public.payment_orders as o
  where o.user_id = p_user_id;

  return query select
    v_credits,
    v_active_jobs,
    v_pending_orders,
    v_open_paid_orders,
    v_unresolved_refunds,
    (
      v_active_jobs = 0
      and v_pending_orders = 0
      and v_unresolved_refunds = 0
      and not (v_credits > 0 and v_open_paid_orders > 0)
    ),
    case
      when v_credits <= 0 then 'none'
      when v_open_paid_orders > 0 then 'review_required'
      else 'free_forfeit'
    end,
    case
      when v_active_jobs > 0 then 'active_job'
      when v_pending_orders > 0 then 'pending_payment'
      when v_unresolved_refunds > 0 then 'unresolved_refund'
      when v_credits > 0 and v_open_paid_orders > 0 then 'paid_credit_review'
      else null
    end;
end;
$$;

create or replace function public.begin_account_deletion(
  p_user_id uuid,
  p_account_hash text
)
returns table (
  deletion_id uuid,
  deletion_status text,
  credits_forfeited integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.account_deletions%rowtype;
  v_deletion_id uuid;
  v_credits integer;
  v_active_jobs integer;
  v_pending_orders integer;
  v_open_paid_orders integer;
  v_unresolved_refunds integer;
begin
  if p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'AD006', message = '탈퇴 요청 식별값이 올바르지 않습니다.';
  end if;

  select d.*
  into v_existing
  from public.account_deletions as d
  where d.account_hash = p_account_hash
  for update;

  if found then
    if v_existing.user_id = p_user_id and v_existing.status in ('processing', 'prepared', 'failed') then
      return query select v_existing.id, v_existing.status, v_existing.credits_forfeited;
      return;
    end if;

    raise exception using errcode = 'AD007', message = '이미 처리된 탈퇴 요청입니다.';
  end if;

  perform 1
  from public.payment_orders as o
  where o.user_id = p_user_id
  for update;

  select p.credits
  into v_credits
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if v_credits is null then
    raise exception using errcode = 'AD001', message = '계정 정보를 찾을 수 없습니다.';
  end if;

  select count(*)::integer
  into v_active_jobs
  from public.transcription_jobs as j
  where j.user_id = p_user_id
    and j.status in ('queued', 'running');

  select
    count(*) filter (where o.status = 'pending')::integer,
    count(*) filter (
      where o.status = 'paid' and o.refund_status = 'none'
    )::integer,
    count(*) filter (
      where o.status = 'paid'
        and o.refund_status in ('pending', 'failed', 'review_required')
    )::integer
  into v_pending_orders, v_open_paid_orders, v_unresolved_refunds
  from public.payment_orders as o
  where o.user_id = p_user_id;

  if v_active_jobs > 0 then
    raise exception using errcode = 'AD002', message = '진행 중인 변환 작업이 있습니다.';
  end if;
  if v_pending_orders > 0 then
    raise exception using errcode = 'AD003', message = '확인 중인 결제 주문이 있습니다.';
  end if;
  if v_unresolved_refunds > 0 then
    raise exception using errcode = 'AD004', message = '처리가 끝나지 않은 환불 요청이 있습니다.';
  end if;
  if v_credits > 0 and v_open_paid_orders > 0 then
    raise exception using errcode = 'AD005', message = '결제한 크레딧의 정산 확인이 필요합니다.';
  end if;

  insert into public.account_deletions (
    account_hash,
    user_id,
    status,
    credits_forfeited
  ) values (
    p_account_hash,
    p_user_id,
    'processing',
    v_credits
  )
  returning id into v_deletion_id;

  update public.payment_orders
  set user_id = null,
      account_deleted_at = now(),
      updated_at = now()
  where user_id = p_user_id;

  delete from public.profiles where id = p_user_id;

  update public.account_deletions
  set status = 'prepared',
      prepared_at = now(),
      last_error_code = null
  where id = v_deletion_id;

  return query select v_deletion_id, 'prepared'::text, v_credits;
end;
$$;

create or replace function public.record_deleted_account_payment_cancellation(
  p_order_id text,
  p_payment_key text
)
returns table (manual_review boolean, already_refunded boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
begin
  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found
    or v_order.user_id is not null
    or v_order.account_deleted_at is null
    or v_order.status <> 'paid'
    or v_order.payment_key <> p_payment_key then
    raise exception '탈퇴 계정의 취소 결제 정보가 일치하지 않습니다.';
  end if;

  if v_order.refund_status = 'refunded' then
    return query select false, true;
    return;
  end if;

  update public.payment_orders
  set refund_status = 'review_required',
      refund_reason = coalesce(refund_reason, '탈퇴 후 Toss 취소 상태 동기화'),
      refund_error_code = 'PROVIDER_CANCELED_AFTER_ACCOUNT_DELETION',
      updated_at = now()
  where order_id = p_order_id;

  return query select true, false;
end;
$$;

revoke all on function public.preview_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.begin_account_deletion(uuid, text) from public, anon, authenticated;
revoke all on function public.record_deleted_account_payment_cancellation(text, text)
  from public, anon, authenticated;
grant execute on function public.preview_account_deletion(uuid) to service_role;
grant execute on function public.begin_account_deletion(uuid, text) to service_role;
grant execute on function public.record_deleted_account_payment_cancellation(text, text) to service_role;

notify pgrst, 'reload schema';
