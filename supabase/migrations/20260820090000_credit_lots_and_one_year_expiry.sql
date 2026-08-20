-- Paid credits need an auditable source and operation allocation before they can
-- expire safely. Existing balances are preserved as non-expiring legacy lots;
-- only payments approved after this migration receive a one-year expiry.

do $$
begin
  if exists (
    select 1
    from public.payment_orders as o
    where o.status = 'pending'
      or (o.status = 'paid' and o.refund_status <> 'refunded')
  ) then
    raise exception 'Open payment orders must be reconciled before enabling credit expiry.';
  end if;

  if exists (
    select 1
    from public.transcription_jobs as j
    where j.status in ('queued', 'running')
  ) then
    raise exception 'Active diarization jobs must finish before enabling credit allocations.';
  end if;
end;
$$;

alter table public.payment_orders
  add column payment_integration text not null default 'individual'
    check (payment_integration in ('individual', 'checkout')),
  add column canceled_amount integer not null default 0
    check (canceled_amount between 0 and amount),
  add column canceled_credits_reclaimed integer not null default 0
    check (canceled_credits_reclaimed between 0 and credits);

alter table public.transcription_jobs
  add column credits_restored integer not null default 0
    check (credits_restored between 0 and credits_reserved);

update public.transcription_jobs
set credits_restored = credits_reserved
where credits_refunded = true;

create table public.credit_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null
    check (source in ('legacy', 'welcome', 'payment', 'adjustment')),
  payment_order_id text references public.payment_orders(order_id),
  granted integer not null check (granted > 0),
  available integer not null check (available >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  expires_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (available + reserved <= granted),
  check (
    (source = 'payment' and payment_order_id is not null and expires_at is not null)
    or
    (source <> 'payment' and payment_order_id is null and expires_at is null)
  )
);

create unique index credit_lots_payment_order_id_idx
  on public.credit_lots (payment_order_id)
  where payment_order_id is not null;

create index credit_lots_user_expiry_idx
  on public.credit_lots (user_id, expires_at, created_at)
  where available > 0;

create table public.credit_allocations (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  lot_id uuid not null references public.credit_lots(id) on delete cascade,
  operation_type text not null
    check (operation_type in ('transcription', 'diarization', 'caption_ideas')),
  operation_id text not null
    check (char_length(operation_id) between 1 and 128),
  state text not null
    check (state in ('reserved', 'consumed', 'released', 'expired', 'reclaimed')),
  amount integer not null check (amount > 0),
  restored_amount integer not null default 0
    check (restored_amount between 0 and amount),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operation_type, operation_id, lot_id)
);

create index credit_allocations_user_operation_idx
  on public.credit_allocations (user_id, operation_type, operation_id);

create index credit_allocations_lot_id_idx
  on public.credit_allocations (lot_id);

alter table public.credit_lots enable row level security;
alter table public.credit_allocations enable row level security;

revoke all on table public.credit_lots from public, anon, authenticated;
revoke all on table public.credit_allocations from public, anon, authenticated;
grant select, insert, update, delete on table public.credit_lots to service_role;
grant select, insert, update, delete on table public.credit_allocations to service_role;
grant usage, select on sequence public.credit_allocations_id_seq to service_role;

insert into public.credit_lots (
  user_id,
  source,
  granted,
  available
)
select
  p.id,
  'legacy',
  p.credits,
  p.credits
from public.profiles as p
where coalesce(p.credits, 0) > 0;

do $$
declare
  v_profile_total bigint;
  v_lot_total bigint;
begin
  select coalesce(sum(p.credits), 0) into v_profile_total
  from public.profiles as p;

  select coalesce(sum(l.available), 0) into v_lot_total
  from public.credit_lots as l;

  if v_profile_total <> v_lot_total then
    raise exception 'Legacy credit backfill mismatch: profiles %, lots %', v_profile_total, v_lot_total;
  end if;
end;
$$;

create or replace function public.expire_credit_lots_for_user(p_user_id uuid)
returns table (
  expired integer,
  credits_remaining integer,
  discrepancy boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
  v_ledger_balance integer;
  v_expiring integer := 0;
  v_removed integer := 0;
begin
  if p_user_id is null then
    raise exception using errcode = 'CR001', message = '사용자 정보가 올바르지 않습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));

  select coalesce(p.credits, 0)
  into v_balance
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'CR002', message = '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  perform 1
  from public.credit_lots as l
  where l.user_id = p_user_id
  order by l.id
  for update;

  select coalesce(sum(l.available), 0)::integer
  into v_ledger_balance
  from public.credit_lots as l
  where l.user_id = p_user_id;

  if v_balance <> v_ledger_balance then
    raise exception using errcode = 'CR003', message = '크레딧 장부 잔액이 일치하지 않습니다.';
  end if;

  select coalesce(sum(l.available), 0)::integer
  into v_expiring
  from public.credit_lots as l
  where l.user_id = p_user_id
    and l.expires_at is not null
    and l.expires_at <= now()
    and l.expired_at is null;

  v_removed := v_expiring;

  update public.credit_lots as l
  set available = 0,
      expired_at = now(),
      updated_at = now()
  where l.user_id = p_user_id
    and l.expires_at is not null
    and l.expires_at <= now()
    and l.expired_at is null;

  if v_removed > 0 then
    update public.profiles as p
    set credits = coalesce(p.credits, 0) - v_removed,
        updated_at = now()
    where p.id = p_user_id
    returning coalesce(p.credits, 0) into v_balance;

    insert into public.usage_logs (
      user_id,
      action,
      credits_used,
      description
    ) values (
      p_user_id,
      'credit_expiration',
      v_removed,
      format('유료 충전 시간 사용 기한 만료 (%s분)', v_removed)
    );
  end if;

  return query select v_removed, v_balance, false;
end;
$$;

create or replace function public.consume_credit_lots(
  p_user_id uuid,
  p_credits integer,
  p_operation_type text,
  p_operation_id text,
  p_reserve boolean default false
)
returns table (
  credits_remaining integer,
  allocated integer,
  already_allocated boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
  v_existing integer;
  v_available integer;
  v_needed integer;
  v_take integer;
  v_lot public.credit_lots%rowtype;
begin
  if p_user_id is null
    or coalesce(p_credits, 0) < 1
    or p_operation_type not in ('transcription', 'diarization', 'caption_ideas')
    or p_operation_id is null
    or char_length(p_operation_id) not between 1 and 128 then
    raise exception using errcode = 'CR001', message = '크레딧 차감 정보가 올바르지 않습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  perform public.expire_credit_lots_for_user(p_user_id);

  select coalesce(p.credits, 0)
  into v_balance
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'CR002', message = '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  select coalesce(sum(a.amount), 0)::integer
  into v_existing
  from public.credit_allocations as a
  where a.user_id = p_user_id
    and a.operation_type = p_operation_type
    and a.operation_id = p_operation_id;

  if v_existing > 0 then
    if v_existing <> p_credits then
      raise exception using errcode = 'CR004', message = '이미 처리된 크레딧 요청 정보가 일치하지 않습니다.';
    end if;
    return query select v_balance, v_existing, true;
    return;
  end if;

  select coalesce(sum(l.available), 0)::integer
  into v_available
  from public.credit_lots as l
  where l.user_id = p_user_id
    and l.available > 0
    and (l.expires_at is null or l.expires_at > now());

  if v_balance < p_credits or v_available < p_credits then
    return;
  end if;

  v_needed := p_credits;

  for v_lot in
    select l.*
    from public.credit_lots as l
    where l.user_id = p_user_id
      and l.available > 0
      and (l.expires_at is null or l.expires_at > now())
    order by (l.expires_at is null), l.expires_at, l.created_at, l.id
    for update
  loop
    exit when v_needed = 0;
    v_take := least(v_lot.available, v_needed);

    update public.credit_lots as l
    set available = l.available - v_take,
        reserved = l.reserved + case when p_reserve then v_take else 0 end,
        updated_at = now()
    where l.id = v_lot.id;

    insert into public.credit_allocations (
      user_id,
      lot_id,
      operation_type,
      operation_id,
      state,
      amount
    ) values (
      p_user_id,
      v_lot.id,
      p_operation_type,
      p_operation_id,
      case when p_reserve then 'reserved' else 'consumed' end,
      v_take
    );

    v_needed := v_needed - v_take;
  end loop;

  if v_needed <> 0 then
    raise exception using errcode = 'CR003', message = '크레딧 장부 잔액이 일치하지 않습니다.';
  end if;

  update public.profiles as p
  set credits = coalesce(p.credits, 0) - p_credits,
      updated_at = now()
  where p.id = p_user_id
  returning coalesce(p.credits, 0) into v_balance;

  return query select v_balance, p_credits, false;
end;
$$;

create or replace function public.consume_transcription_credits(
  p_user_id uuid,
  p_credits integer,
  p_operation_id text,
  p_audio_minutes numeric,
  p_description text
)
returns table (credits_remaining integer, already_consumed boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result record;
begin
  select * into v_result
  from public.consume_credit_lots(
    p_user_id,
    p_credits,
    'transcription',
    p_operation_id,
    false
  );

  if not found then
    return;
  end if;

  if not v_result.already_allocated then
    insert into public.usage_logs (
      user_id,
      action,
      credits_used,
      audio_minutes,
      description
    ) values (
      p_user_id,
      'transcribe',
      p_credits,
      greatest(coalesce(p_audio_minutes, 0), 0),
      left(coalesce(p_description, '음성 변환'), 500)
    );
  end if;

  return query select v_result.credits_remaining, v_result.already_allocated;
end;
$$;

-- Compatibility for the old container during schema-first deployment.
create or replace function public.deduct_credits(
  p_user_id uuid,
  p_credits integer
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result record;
begin
  select * into v_result
  from public.consume_credit_lots(
    p_user_id,
    p_credits,
    'transcription',
    gen_random_uuid()::text,
    false
  );

  return v_result.credits_remaining;
end;
$$;

create or replace function public.ensure_welcome_credit_profile(
  p_user_id uuid,
  p_email text,
  p_identity_hashes text[]
)
returns table (
  credits integer,
  plan text,
  welcome_credit_granted boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_identity_count integer;
  v_already_claimed boolean;
  v_credits integer;
  v_plan text;
  v_granted boolean;
begin
  if p_user_id is null or p_email is null or btrim(p_email) = '' or char_length(p_email) > 320 then
    raise exception using errcode = 'WC002', message = '회원 정보가 올바르지 않습니다.';
  end if;

  select count(*)::integer
  into v_identity_count
  from (
    select distinct btrim(value) as identity_hash
    from unnest(coalesce(p_identity_hashes, '{}'::text[])) as value
    where value is not null and btrim(value) <> ''
  ) as normalized
  where normalized.identity_hash ~ '^[0-9a-f]{64}$';

  if v_identity_count = 0 or exists (
    select 1
    from unnest(coalesce(p_identity_hashes, '{}'::text[])) as value
    where value is null or btrim(value) !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = 'WC001', message = '무료 체험 식별값이 올바르지 않습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('welcome-user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(
    hashtextextended('welcome-identity:' || normalized.identity_hash, 0)
  )
  from (
    select distinct btrim(value) as identity_hash
    from unnest(p_identity_hashes) as value
  ) as normalized
  order by normalized.identity_hash;

  select coalesce(p.credits, 0), coalesce(p.plan, 'free')
  into v_credits, v_plan
  from public.profiles as p
  where p.id = p_user_id;

  if found then
    return query select v_credits, v_plan, false;
    return;
  end if;

  select exists (
    select 1
    from public.welcome_credit_claims as c
    where c.benefit_code = 'welcome_10_minutes'
      and c.identity_hash = any(p_identity_hashes)
  ) into v_already_claimed;

  insert into public.welcome_credit_claims (identity_hash)
  select distinct btrim(value)
  from unnest(p_identity_hashes) as value
  order by btrim(value)
  on conflict (benefit_code, identity_hash) do nothing;

  v_granted := not v_already_claimed;

  insert into public.profiles (id, email, credits, plan)
  values (p_user_id, lower(btrim(p_email)), case when v_granted then 10 else 0 end, 'free');

  if v_granted then
    insert into public.credit_lots (
      user_id,
      source,
      granted,
      available
    ) values (
      p_user_id,
      'welcome',
      10,
      10
    );
  end if;

  select coalesce(p.credits, 0), coalesce(p.plan, 'free')
  into v_credits, v_plan
  from public.profiles as p
  where p.id = p_user_id;

  return query select v_credits, v_plan, v_granted;
end;
$$;

create or replace function public.complete_payment_order(
  p_order_id text,
  p_user_id uuid,
  p_payment_key text,
  p_approved_at timestamptz
)
returns table (credits integer, charged integer, already_paid boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_credits integer;
  v_approved_at timestamptz;
begin
  if p_order_id is null or p_user_id is null or p_payment_key is null then
    raise exception using errcode = 'PR001', message = '결제 정보가 올바르지 않습니다.';
  end if;

  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id;

  if not found or v_order.user_id <> p_user_id then
    raise exception using errcode = 'PR001', message = '결제 주문을 찾을 수 없습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'PR003', message = '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if v_order.status = 'paid' then
    if v_order.payment_key <> p_payment_key then
      raise exception using errcode = 'PR002', message = '이미 다른 결제 정보로 처리된 주문입니다.';
    end if;
    return query select v_credits, v_order.credits, true;
    return;
  end if;

  if v_order.status <> 'pending' then
    raise exception using errcode = 'PR002', message = '완료할 수 없는 결제 주문입니다.';
  end if;

  v_approved_at := coalesce(p_approved_at, now());

  if v_approved_at < v_order.created_at - interval '1 day'
    or v_approved_at > now() + interval '5 minutes' then
    raise exception using errcode = 'PR002', message = '결제 승인 시각이 올바르지 않습니다.';
  end if;

  update public.profiles as p
  set credits = coalesce(p.credits, 0) + v_order.credits,
      updated_at = now()
  where p.id = p_user_id
  returning coalesce(p.credits, 0) into v_credits;

  update public.payment_orders as o
  set status = 'paid',
      payment_key = p_payment_key,
      approved_at = v_approved_at,
      updated_at = now()
  where o.order_id = p_order_id;

  insert into public.credit_lots (
    user_id,
    source,
    payment_order_id,
    granted,
    available,
    expires_at,
    created_at
  ) values (
    p_user_id,
    'payment',
    v_order.order_id,
    v_order.credits,
    v_order.credits,
    v_approved_at + interval '1 year',
    v_approved_at
  );

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    p_user_id,
    'charge',
    -v_order.credits,
    v_order.order_id,
    format('%s 결제 (%s원, 사용 기한 %s)',
      v_order.plan_name,
      to_char(v_order.amount, 'FM999,999,999,990'),
      to_char(v_approved_at + interval '1 year', 'YYYY-MM-DD'))
  );

  return query select v_credits, v_order.credits, false;
end;
$$;

create or replace function public.enqueue_diarization_job(
  p_user_id uuid,
  p_filename text,
  p_storage_path text,
  p_requested_language text,
  p_duration_seconds numeric,
  p_credits integer
)
returns table (job_id uuid, credits_remaining integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid := gen_random_uuid();
  v_result record;
begin
  if p_credits < 1 or p_duration_seconds < 0 then
    raise exception '예약할 변환 정보가 올바르지 않습니다.';
  end if;

  select * into v_result
  from public.consume_credit_lots(
    p_user_id,
    p_credits,
    'diarization',
    v_job_id::text,
    true
  );

  if not found then
    return;
  end if;

  insert into public.transcription_jobs (
    id,
    user_id,
    filename,
    storage_path,
    requested_language,
    duration_seconds,
    credits_reserved
  ) values (
    v_job_id,
    p_user_id,
    p_filename,
    p_storage_path,
    nullif(p_requested_language, ''),
    p_duration_seconds,
    p_credits
  );

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    audio_minutes,
    description
  ) values (
    p_user_id,
    'transcribe',
    p_credits,
    round((p_duration_seconds / 60)::numeric, 1),
    format('%s (다화자 작업 대기)', p_filename)
  );

  return query select v_job_id, v_result.credits_remaining;
end;
$$;

create or replace function public.complete_diarization_job(
  p_job_id uuid,
  p_worker_token uuid,
  p_result_text text,
  p_result_segments jsonb,
  p_result_language text,
  p_transcription_log_id bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_job public.transcription_jobs%rowtype;
  v_allocation public.credit_allocations%rowtype;
begin
  select j.user_id
  into v_user_id
  from public.transcription_jobs as j
  where j.id = p_job_id;

  if not found then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || v_user_id::text, 0));

  perform 1
  from public.profiles as p
  where p.id = v_user_id
  for update;

  select j.*
  into v_job
  from public.transcription_jobs as j
  where j.id = p_job_id
    and j.status = 'running'
    and j.worker_token = p_worker_token
  for update;

  if not found then
    return false;
  end if;

  for v_allocation in
    select a.*
    from public.credit_allocations as a
    where a.user_id = v_job.user_id
      and a.operation_type = 'diarization'
      and a.operation_id = v_job.id::text
      and a.state = 'reserved'
    order by a.id
    for update
  loop
    update public.credit_lots as l
    set reserved = l.reserved - v_allocation.amount,
        updated_at = now()
    where l.id = v_allocation.lot_id;

    update public.credit_allocations as a
    set state = 'consumed',
        updated_at = now()
    where a.id = v_allocation.id;
  end loop;

  update public.transcription_jobs as j
  set status = 'completed',
      completed_at = now(),
      result_text = p_result_text,
      result_segments = p_result_segments,
      result_language = p_result_language,
      transcription_log_id = p_transcription_log_id,
      updated_at = now()
  where j.id = p_job_id;

  return true;
end;
$$;

create or replace function public.release_diarization_credit_allocations(
  p_job_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_allocation public.credit_allocations%rowtype;
  v_lot public.credit_lots%rowtype;
  v_order public.payment_orders%rowtype;
  v_reclaim_target integer;
  v_reclaim_debt integer;
  v_withheld integer;
  v_restore_amount integer;
  v_restored integer := 0;
  v_expired_available integer := 0;
begin
  for v_allocation in
    select a.*
    from public.credit_allocations as a
    where a.user_id = p_user_id
      and a.operation_type = 'diarization'
      and a.operation_id = p_job_id::text
      and a.state = 'reserved'
    order by a.id
    for update
  loop
    select l.payment_order_id
    into v_lot.payment_order_id
    from public.credit_lots as l
    where l.id = v_allocation.lot_id
      and l.user_id = p_user_id;

    if not found then
      raise exception using errcode = 'CR003', message = '예약 크레딧 장부를 찾을 수 없습니다.';
    end if;

    v_order := null;
    if v_lot.payment_order_id is not null then
      select o.*
      into v_order
      from public.payment_orders as o
      where o.order_id = v_lot.payment_order_id
      for update;
    end if;

    select l.*
    into v_lot
    from public.credit_lots as l
    where l.id = v_allocation.lot_id
      and l.user_id = p_user_id
    for update;

    if not found then
      raise exception using errcode = 'CR003', message = '예약 크레딧 장부를 찾을 수 없습니다.';
    end if;

    if v_lot.expires_at is null or v_lot.expires_at > now() then
      v_withheld := 0;

      if v_lot.payment_order_id is not null and v_order.order_id is not null then
        v_reclaim_target := floor(
          v_order.credits::numeric * v_order.canceled_amount::numeric / v_order.amount::numeric
        );
        v_reclaim_debt := greatest(v_reclaim_target - v_order.canceled_credits_reclaimed, 0);
        v_withheld := least(v_allocation.amount, v_reclaim_debt);

        if v_withheld > 0 then
          update public.payment_orders as o
          set canceled_credits_reclaimed = o.canceled_credits_reclaimed + v_withheld,
              updated_at = now()
          where o.order_id = v_order.order_id;
        end if;
      end if;

      v_restore_amount := v_allocation.amount - v_withheld;

      update public.credit_lots as l
      set available = l.available + v_restore_amount,
          reserved = l.reserved - v_allocation.amount,
          updated_at = now()
      where l.id = v_lot.id;

      update public.credit_allocations as a
      set state = case when v_restore_amount > 0 then 'released' else 'reclaimed' end,
          restored_amount = v_restore_amount,
          updated_at = now()
      where a.id = v_allocation.id;

      v_restored := v_restored + v_restore_amount;
    else
      v_expired_available := v_expired_available + v_lot.available;

      update public.credit_lots as l
      set available = 0,
          reserved = l.reserved - v_allocation.amount,
          expired_at = coalesce(l.expired_at, now()),
          updated_at = now()
      where l.id = v_lot.id;

      update public.credit_allocations as a
      set state = 'expired',
          restored_amount = 0,
          updated_at = now()
      where a.id = v_allocation.id;
    end if;
  end loop;

  if v_restored > 0 or v_expired_available > 0 then
    update public.profiles as p
    set credits = coalesce(p.credits, 0) + v_restored - v_expired_available,
        updated_at = now()
    where p.id = p_user_id;
  end if;

  if v_expired_available > 0 then
    insert into public.usage_logs (
      user_id,
      action,
      credits_used,
      description
    ) values (
      p_user_id,
      'credit_expiration',
      v_expired_available,
      format('유료 충전 시간 사용 기한 만료 (%s분)', v_expired_available)
    );
  end if;

  return v_restored;
end;
$$;

create or replace function public.fail_diarization_job(
  p_job_id uuid,
  p_worker_token uuid,
  p_error_message text
)
returns table (updated boolean, credits_remaining integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_job public.transcription_jobs%rowtype;
  v_credits integer;
  v_restored integer;
begin
  select j.user_id
  into v_user_id
  from public.transcription_jobs as j
  where j.id = p_job_id;

  if not found then
    return query select false, null::integer;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || v_user_id::text, 0));

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = v_user_id
  for update;

  select j.*
  into v_job
  from public.transcription_jobs as j
  where j.id = p_job_id
    and j.status = 'running'
    and j.worker_token = p_worker_token
  for update;

  if not found then
    return query select false, null::integer;
    return;
  end if;

  v_restored := public.release_diarization_credit_allocations(v_job.id, v_job.user_id);

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = v_job.user_id;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    audio_minutes,
    description
  ) values (
    v_job.user_id,
    'refund',
    -v_restored,
    round((v_job.duration_seconds / 60)::numeric, 1),
    case
      when v_restored = v_job.credits_reserved
        then format('%s (다화자 작업 실패 환불)', v_job.filename)
      else format('%s (다화자 작업 실패, 유효한 예약 %s/%s분 반환)',
        v_job.filename, v_restored, v_job.credits_reserved)
    end
  );

  update public.transcription_jobs as j
  set status = 'failed',
      completed_at = now(),
      credits_refunded = (v_restored = v_job.credits_reserved),
      credits_restored = v_restored,
      error_message = left(coalesce(p_error_message, '작업 처리 중 오류가 발생했습니다.'), 500),
      updated_at = now()
  where j.id = v_job.id;

  return query select true, v_credits;
end;
$$;

create or replace function public.cancel_diarization_job(
  p_job_id uuid,
  p_user_id uuid
)
returns table (updated boolean, credits_remaining integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.transcription_jobs%rowtype;
  v_credits integer;
  v_restored integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = p_user_id
  for update;

  select j.*
  into v_job
  from public.transcription_jobs as j
  where j.id = p_job_id
    and j.user_id = p_user_id
    and j.status in ('queued', 'running')
  for update;

  if not found then
    return query select false, null::integer;
    return;
  end if;

  v_restored := public.release_diarization_credit_allocations(v_job.id, v_job.user_id);

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = v_job.user_id;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    audio_minutes,
    description
  ) values (
    v_job.user_id,
    'refund',
    -v_restored,
    round((v_job.duration_seconds / 60)::numeric, 1),
    case
      when v_restored = v_job.credits_reserved
        then format('%s (다화자 작업 취소 환불)', v_job.filename)
      else format('%s (다화자 작업 취소, 유효한 예약 %s/%s분 반환)',
        v_job.filename, v_restored, v_job.credits_reserved)
    end
  );

  update public.transcription_jobs as j
  set status = 'failed',
      completed_at = now(),
      credits_refunded = (v_restored = v_job.credits_reserved),
      credits_restored = v_restored,
      error_message = '사용자가 작업을 취소했습니다.',
      updated_at = now()
  where j.id = v_job.id;

  return query select true, v_credits;
end;
$$;

create or replace function public.complete_caption_idea_request(
  p_request_id uuid,
  p_user_id uuid,
  p_mode text,
  p_ideas jsonb,
  p_model text,
  p_prompt_tokens integer,
  p_cached_tokens integer,
  p_completion_tokens integer,
  p_estimated_cost_usd numeric,
  p_duration_ms bigint
)
returns table (
  ideas jsonb,
  credits integer,
  credits_charged integer,
  remaining_uses integer,
  already_completed boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.caption_idea_requests%rowtype;
  v_result record;
  v_credits integer;
  v_remaining smallint;
  v_credits_charged integer := 0;
begin
  if p_mode is null or p_mode not in ('entertainment', 'situation', 'emphasis', 'emotion') then
    raise exception using errcode = 'CI001', message = '자막 유형이 올바르지 않습니다.';
  end if;

  if p_ideas is null or jsonb_typeof(p_ideas) <> 'array' then
    raise exception using errcode = 'CI001', message = '자막 아이디어 결과가 올바르지 않습니다.';
  end if;

  if jsonb_array_length(p_ideas) <> 3
    or exists (
      select 1
      from jsonb_array_elements(p_ideas) as item(value)
      where jsonb_typeof(item.value) <> 'string'
    )
    or exists (
      select 1
      from jsonb_array_elements_text(p_ideas) as item(value)
      where char_length(btrim(item.value)) not between 1 and 28
    ) then
    raise exception using errcode = 'CI001', message = '자막 아이디어 결과가 올바르지 않습니다.';
  end if;

  if p_model is null or char_length(p_model) not between 1 and 100
    or coalesce(p_prompt_tokens, -1) < 0
    or coalesce(p_cached_tokens, -1) < 0
    or coalesce(p_cached_tokens, 0) > coalesce(p_prompt_tokens, 0)
    or coalesce(p_completion_tokens, -1) < 0
    or coalesce(p_duration_ms, -1) < 0
    or (p_estimated_cost_usd is not null and p_estimated_cost_usd < 0) then
    raise exception using errcode = 'CI001', message = '자막 아이디어 요청 정보가 올바르지 않습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  perform public.expire_credit_lots_for_user(p_user_id);

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'CI003', message = '사용자 크레딧 정보를 찾을 수 없습니다.';
  end if;

  select r.*
  into v_existing
  from public.caption_idea_requests as r
  where r.id = p_request_id;

  if found then
    if v_existing.user_id <> p_user_id then
      raise exception using errcode = 'CI005', message = '이미 사용된 요청 식별값입니다.';
    end if;
    if v_existing.ideas is null or v_existing.ideas_expires_at <= now() then
      raise exception using errcode = 'CI004', message = '복구 가능한 요청 시간이 만료되었습니다.';
    end if;

    return query select
      v_existing.ideas,
      v_credits,
      v_existing.credits_charged::integer,
      v_existing.remaining_uses_after::integer,
      true;
    return;
  end if;

  insert into public.caption_idea_wallets (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select w.remaining_uses
  into v_remaining
  from public.caption_idea_wallets as w
  where w.user_id = p_user_id
  for update;

  if v_remaining > 0 then
    v_remaining := v_remaining - 1;
  else
    select * into v_result
    from public.consume_credit_lots(
      p_user_id,
      1,
      'caption_ideas',
      p_request_id::text,
      false
    );

    if not found then
      raise exception using errcode = 'CI002', message = '변환 가능 시간이 부족합니다.';
    end if;

    v_credits := v_result.credits_remaining;
    v_remaining := 4;
    v_credits_charged := 1;

    if not v_result.already_allocated then
      insert into public.usage_logs (
        user_id,
        action,
        credits_used,
        description
      ) values (
        p_user_id,
        'caption_ideas',
        1,
        '자막 아이디어 생성권 5회'
      );
    end if;
  end if;

  update public.caption_idea_wallets as w
  set remaining_uses = v_remaining,
      updated_at = now()
  where w.user_id = p_user_id;

  insert into public.caption_idea_requests (
    id,
    user_id,
    mode,
    ideas,
    credits_charged,
    remaining_uses_after,
    model,
    prompt_tokens,
    cached_tokens,
    completion_tokens,
    estimated_cost_usd,
    duration_ms
  ) values (
    p_request_id,
    p_user_id,
    p_mode,
    p_ideas,
    v_credits_charged,
    v_remaining,
    p_model,
    p_prompt_tokens,
    p_cached_tokens,
    p_completion_tokens,
    p_estimated_cost_usd,
    p_duration_ms
  );

  return query select
    p_ideas,
    v_credits,
    v_credits_charged,
    v_remaining::integer,
    false;
end;
$$;

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
  v_lot public.credit_lots%rowtype;
  v_balance integer;
  v_refund_key uuid;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 1 or char_length(p_reason) > 200 then
    raise exception using errcode = 'PR006', message = '환불 사유가 올바르지 않습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  perform public.expire_credit_lots_for_user(p_user_id);

  select coalesce(p.credits, 0)
  into v_balance
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'PR001', message = '사용자 크레딧 정보를 찾을 수 없습니다.';
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

  select l.*
  into v_lot
  from public.credit_lots as l
  where l.payment_order_id = v_order.order_id
  for update;

  if not found then
    raise exception using errcode = 'PR005', message = '결제 크레딧 정산 확인이 필요합니다.';
  end if;

  if v_order.approved_at < now() - interval '7 days' then
    raise exception using errcode = 'PR003', message = '결제일로부터 7일이 지난 주문은 자동 환불할 수 없습니다.';
  end if;

  if v_lot.expires_at <= now() or v_lot.expired_at is not null then
    raise exception using errcode = 'PR003', message = '사용 기한이 만료된 주문은 자동 환불할 수 없습니다.';
  end if;

  if v_order.canceled_amount > 0
    or v_lot.available <> v_order.credits
    or v_lot.reserved <> 0 then
    raise exception using errcode = 'PR003', message = '결제한 변환 시간을 사용한 주문은 자동 환불할 수 없습니다.';
  end if;

  if v_balance < v_order.credits then
    raise exception using errcode = 'PR004', message = '환불할 결제의 변환 시간이 부족합니다.';
  end if;

  v_refund_key := gen_random_uuid();

  update public.credit_lots as l
  set available = 0,
      updated_at = now()
  where l.id = v_lot.id;

  update public.profiles as p
  set credits = coalesce(p.credits, 0) - v_order.credits,
      updated_at = now()
  where p.id = p_user_id
  returning coalesce(p.credits, 0) into v_balance;

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
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));

  select coalesce(p.credits, 0)
  into v_balance
  from public.profiles as p
  where p.id = p_user_id
  for update;

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
      canceled_amount = o.amount,
      canceled_credits_reclaimed = o.credits,
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
  v_lot public.credit_lots%rowtype;
  v_balance integer;
  v_restored integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));

  select coalesce(p.credits, 0)
  into v_balance
  from public.profiles as p
  where p.id = p_user_id
  for update;

  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found or v_order.user_id <> p_user_id then
    raise exception using errcode = 'PR001', message = '결제 주문을 찾을 수 없습니다.';
  end if;

  if v_order.refund_status = 'failed' and not v_order.refund_credits_reclaimed then
    return query select v_balance, 0, true;
    return;
  end if;

  if v_order.refund_status <> 'pending' or not v_order.refund_credits_reclaimed then
    raise exception '실패 처리할 수 있는 환불 보류 상태가 아닙니다.';
  end if;

  select l.*
  into v_lot
  from public.credit_lots as l
  where l.payment_order_id = v_order.order_id
  for update;

  if not found then
    raise exception using errcode = 'PR005', message = '결제 크레딧 정산 확인이 필요합니다.';
  end if;

  if v_lot.expires_at > now() and v_lot.expired_at is null then
    v_restored := v_order.credits;

    update public.credit_lots as l
    set available = v_order.credits,
        updated_at = now()
    where l.id = v_lot.id;

    update public.profiles as p
    set credits = coalesce(p.credits, 0) + v_restored,
        updated_at = now()
    where p.id = p_user_id
    returning coalesce(p.credits, 0) into v_balance;
  end if;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    p_user_id,
    'payment_refund_restore',
    -v_restored,
    v_order.order_id,
    format('%s 환불 실패 크레딧 복구 (%s분)', v_order.plan_name, v_restored)
  );

  update public.payment_orders as o
  set refund_status = case when v_restored = v_order.credits then 'failed' else 'review_required' end,
      refund_error_code = case
        when v_restored = v_order.credits then left(coalesce(p_error_code, 'UNKNOWN'), 100)
        else 'REFUND_FAILED_AFTER_CREDIT_EXPIRY'
      end,
      refund_credits_reclaimed = v_restored <> v_order.credits,
      updated_at = now()
  where o.order_id = p_order_id;

  return query select v_balance, v_restored, false;
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
  v_user_id uuid;
  v_order public.payment_orders%rowtype;
  v_lot public.credit_lots%rowtype;
  v_balance integer;
  v_reclaimed integer := 0;
  v_manual boolean := false;
begin
  select o.user_id
  into v_user_id
  from public.payment_orders as o
  where o.order_id = p_order_id;

  if not found or v_user_id is null then
    raise exception '취소된 결제 주문 정보가 일치하지 않습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || v_user_id::text, 0));
  perform public.expire_credit_lots_for_user(v_user_id);

  select coalesce(p.credits, 0)
  into v_balance
  from public.profiles as p
  where p.id = v_user_id
  for update;

  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found or v_order.payment_key <> p_payment_key or v_order.status <> 'paid' then
    raise exception '취소된 결제 주문 정보가 일치하지 않습니다.';
  end if;

  if v_order.refund_status = 'refunded' then
    return query select v_balance, v_order.credits, false, true;
    return;
  end if;

  select l.*
  into v_lot
  from public.credit_lots as l
  where l.payment_order_id = v_order.order_id
  for update;

  if not found then
    raise exception using errcode = 'PR005', message = '결제 크레딧 정산 확인이 필요합니다.';
  end if;

  if v_order.refund_status = 'pending' and v_order.refund_credits_reclaimed then
    v_reclaimed := v_order.credits;
  else
    v_reclaimed := least(v_lot.available, v_balance);
    v_manual := (v_reclaimed + v_order.canceled_credits_reclaimed) < v_order.credits;

    if v_reclaimed > 0 then
      update public.credit_lots as l
      set available = l.available - v_reclaimed,
          updated_at = now()
      where l.id = v_lot.id;

      update public.profiles as p
      set credits = coalesce(p.credits, 0) - v_reclaimed,
          updated_at = now()
      where p.id = v_user_id
      returning coalesce(p.credits, 0) into v_balance;
    end if;

    insert into public.usage_logs (
      user_id,
      action,
      credits_used,
      order_id,
      description
    ) values (
      v_user_id,
      'payment_refund_reconcile',
      v_order.canceled_credits_reclaimed + v_reclaimed,
      v_order.order_id,
      format('%s Toss 전액 취소 동기화 (%s원, %s분 회수)',
        v_order.plan_name,
        to_char(v_order.amount, 'FM999,999,999,990'),
        v_order.canceled_credits_reclaimed + v_reclaimed)
    )
    on conflict (order_id, action) where order_id is not null
    do update set
      credits_used = excluded.credits_used,
      description = excluded.description;
  end if;

  update public.payment_orders as o
  set refund_status = 'refunded',
      refund_reason = coalesce(o.refund_reason, 'Toss 취소 상태 동기화'),
      refunded_at = now(),
      refund_error_code = case
        when v_manual then 'PROVIDER_CANCEL_AFTER_CREDIT_USE'
        else null
      end,
      refund_credits_reclaimed = true,
      canceled_amount = o.amount,
      canceled_credits_reclaimed = least(o.credits, greatest(
        o.canceled_credits_reclaimed,
        o.canceled_credits_reclaimed + v_reclaimed
      )),
      updated_at = now()
  where o.order_id = p_order_id;

  update public.usage_logs as u
  set description = format('%s 결제 환불 완료 (%s원)', v_order.plan_name, to_char(v_order.amount, 'FM999,999,999,990'))
  where u.order_id = p_order_id
    and u.action = 'payment_refund';

  return query select v_balance, v_order.credits, v_manual, false;
end;
$$;

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
  v_user_id uuid;
  v_order public.payment_orders%rowtype;
  v_lot public.credit_lots%rowtype;
  v_balance integer;
  v_target integer;
  v_delta integer;
  v_reclaim integer;
  v_manual boolean;
begin
  if p_canceled_amount is null or p_canceled_amount <= 0 then
    raise exception using errcode = 'PR001', message = '부분 취소 금액이 올바르지 않습니다.';
  end if;

  select o.user_id
  into v_user_id
  from public.payment_orders as o
  where o.order_id = p_order_id;

  if not found or v_user_id is null then
    raise exception using errcode = 'PR002', message = '주문을 찾을 수 없습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || v_user_id::text, 0));
  perform public.expire_credit_lots_for_user(v_user_id);

  select coalesce(p.credits, 0)
  into v_balance
  from public.profiles as p
  where p.id = v_user_id
  for update;

  select o.*
  into v_order
  from public.payment_orders as o
  where o.order_id = p_order_id
  for update;

  if not found or v_order.payment_key <> p_payment_key or v_order.status <> 'paid' then
    raise exception using errcode = 'PR005', message = '결제 완료되지 않은 주문입니다.';
  end if;

  if v_order.refund_status = 'refunded' then
    return query select 0, v_balance, false, true;
    return;
  end if;

  if p_canceled_amount <= v_order.canceled_amount then
    return query select 0, v_balance,
      v_order.refund_status = 'review_required', true;
    return;
  end if;

  if p_canceled_amount > v_order.amount then
    raise exception using errcode = 'PR001', message = '부분 취소 금액이 주문 금액을 초과합니다.';
  end if;

  select l.*
  into v_lot
  from public.credit_lots as l
  where l.payment_order_id = v_order.order_id
  for update;

  if not found then
    raise exception using errcode = 'PR005', message = '결제 크레딧 정산 확인이 필요합니다.';
  end if;

  v_target := floor(v_order.credits::numeric * p_canceled_amount::numeric / v_order.amount::numeric);
  v_delta := greatest(v_target - v_order.canceled_credits_reclaimed, 0);
  v_reclaim := least(v_delta, v_lot.available, v_balance);
  v_manual := v_reclaim < v_delta;

  if v_reclaim > 0 then
    update public.credit_lots as l
    set available = l.available - v_reclaim,
        updated_at = now()
    where l.id = v_lot.id;

    update public.profiles as p
    set credits = coalesce(p.credits, 0) - v_reclaim,
        updated_at = now()
    where p.id = v_user_id
    returning coalesce(p.credits, 0) into v_balance;
  end if;

  update public.payment_orders as o
  set refund_status = 'review_required',
      payment_key = coalesce(o.payment_key, p_payment_key),
      refund_error_code = case
        when v_manual then 'PARTIAL_CANCEL_CREDITS_USED'
        else 'PARTIAL_CANCELED'
      end,
      canceled_amount = p_canceled_amount,
      canceled_credits_reclaimed = o.canceled_credits_reclaimed + v_reclaim,
      updated_at = now()
  where o.order_id = p_order_id;

  insert into public.usage_logs (
    user_id,
    action,
    credits_used,
    order_id,
    description
  ) values (
    v_user_id,
    'payment_refund_reconcile',
    v_order.canceled_credits_reclaimed + v_reclaim,
    v_order.order_id,
    format('%s 누적 부분 취소 반영 (%s원 취소, %s분 회수)',
      v_order.plan_name,
      to_char(p_canceled_amount, 'FM999,999,999,990'),
      v_order.canceled_credits_reclaimed + v_reclaim)
  )
  on conflict (order_id, action) where order_id is not null
  do update set
    credits_used = excluded.credits_used,
    description = excluded.description;

  return query select v_reclaim, v_balance, v_manual, false;
end;
$$;

drop function public.list_payment_orders_for_refund(uuid, integer);

create function public.list_payment_orders_for_refund(
  p_user_id uuid,
  p_limit integer default 10
)
returns table (
  order_id text,
  plan_name text,
  amount integer,
  credits integer,
  payment_status text,
  payment_environment text,
  refund_status text,
  created_at timestamptz,
  approved_at timestamptz,
  refunded_at timestamptz,
  can_refund boolean,
  can_retry boolean,
  eligibility_reason text,
  credit_expires_at timestamptz,
  paid_credits_remaining integer,
  payment_integration text
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
    o.payment_environment,
    o.refund_status,
    o.created_at,
    o.approved_at,
    o.refunded_at,
    (
      o.status = 'paid'
      and o.refund_status = 'none'
      and o.canceled_amount = 0
      and o.approved_at >= now() - interval '7 days'
      and l.available = o.credits
      and l.reserved = 0
      and l.expires_at > now()
      and l.expired_at is null
    ) as can_refund,
    (o.status = 'paid' and o.refund_status = 'pending') as can_retry,
    case
      when o.status <> 'paid' then 'not_paid'
      when o.refund_status = 'pending' then 'pending'
      when o.refund_status = 'refunded' then 'refunded'
      when o.refund_status = 'failed' then 'failed'
      when o.refund_status = 'review_required' then 'review_required'
      when l.id is null then 'legacy_order'
      when l.expires_at <= now() or l.expired_at is not null then 'expired'
      when o.approved_at < now() - interval '7 days' then 'refund_window_closed'
      when o.canceled_amount > 0 then 'partial_cancellation'
      when l.available < o.credits or l.reserved > 0 then 'credits_used'
      else null
    end as eligibility_reason,
    l.expires_at,
    coalesce(l.available, 0),
    o.payment_integration
  from public.payment_orders as o
  left join public.credit_lots as l on l.payment_order_id = o.order_id
  where o.user_id = p_user_id
  order by o.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 20));
$$;

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
  perform public.expire_credit_lots_for_user(p_user_id);

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = p_user_id;

  if not found then
    raise exception using errcode = 'AD001', message = '계정 정보를 찾을 수 없습니다.';
  end if;

  select count(*)::integer
  into v_active_jobs
  from public.transcription_jobs as j
  where j.user_id = p_user_id
    and j.status in ('queued', 'running');

  select count(distinct o.order_id)::integer
  into v_open_paid_orders
  from public.payment_orders as o
  join public.credit_lots as l on l.payment_order_id = o.order_id
  where o.user_id = p_user_id
    and o.status = 'paid'
    and o.refund_status = 'none'
    and l.available > 0
    and l.expires_at > now()
    and l.expired_at is null;

  select
    count(*) filter (where o.status = 'pending')::integer,
    count(*) filter (
      where o.status = 'paid'
        and o.refund_status in ('pending', 'failed', 'review_required')
    )::integer
  into v_pending_orders, v_unresolved_refunds
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
      and v_open_paid_orders = 0
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
      when v_open_paid_orders > 0 then 'paid_credit_review'
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

  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));

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

  perform public.expire_credit_lots_for_user(p_user_id);

  perform 1
  from public.payment_orders as o
  where o.user_id = p_user_id
  order by o.order_id
  for update;

  select coalesce(p.credits, 0)
  into v_credits
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'AD001', message = '계정 정보를 찾을 수 없습니다.';
  end if;

  select count(*)::integer
  into v_active_jobs
  from public.transcription_jobs as j
  where j.user_id = p_user_id
    and j.status in ('queued', 'running');

  select count(distinct o.order_id)::integer
  into v_open_paid_orders
  from public.payment_orders as o
  join public.credit_lots as l on l.payment_order_id = o.order_id
  where o.user_id = p_user_id
    and o.status = 'paid'
    and o.refund_status = 'none'
    and l.available > 0
    and l.expires_at > now()
    and l.expired_at is null;

  select
    count(*) filter (where o.status = 'pending')::integer,
    count(*) filter (
      where o.status = 'paid'
        and o.refund_status in ('pending', 'failed', 'review_required')
    )::integer
  into v_pending_orders, v_unresolved_refunds
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
  if v_open_paid_orders > 0 then
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

create or replace function public.expire_due_credit_lots(p_limit integer default 100)
returns table (
  users_processed integer,
  credits_expired integer,
  discrepancies integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_result record;
  v_users integer := 0;
  v_expired integer := 0;
  v_discrepancies integer := 0;
begin
  for v_user_id in
    select distinct l.user_id
    from public.credit_lots as l
    where l.expires_at is not null
      and l.expires_at <= now()
      and l.expired_at is null
    order by l.user_id
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  loop
    begin
      select * into v_result
      from public.expire_credit_lots_for_user(v_user_id);

      v_users := v_users + 1;
      v_expired := v_expired + coalesce(v_result.expired, 0);
    exception
      when sqlstate 'CR003' then
        v_users := v_users + 1;
        v_discrepancies := v_discrepancies + 1;
    end;
  end loop;

  return query select v_users, v_expired, v_discrepancies;
end;
$$;

revoke all on function public.expire_credit_lots_for_user(uuid) from public, anon, authenticated;
revoke all on function public.consume_credit_lots(uuid, integer, text, text, boolean) from public, anon, authenticated;
revoke all on function public.consume_transcription_credits(uuid, integer, text, numeric, text) from public, anon, authenticated;
revoke all on function public.deduct_credits(uuid, integer) from public, anon, authenticated;
revoke all on function public.ensure_welcome_credit_profile(uuid, text, text[]) from public, anon, authenticated;
revoke all on function public.complete_payment_order(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_payment_order(text, uuid, text) from public, anon, authenticated;
revoke all on function public.enqueue_diarization_job(uuid, text, text, text, numeric, integer) from public, anon, authenticated;
revoke all on function public.complete_diarization_job(uuid, uuid, text, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.release_diarization_credit_allocations(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_diarization_job(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_diarization_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_caption_idea_request(uuid, uuid, text, jsonb, text, integer, integer, integer, numeric, bigint) from public, anon, authenticated;
revoke all on function public.prepare_payment_refund(text, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_payment_refund(text, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_payment_refund(text, uuid, text) from public, anon, authenticated;
revoke all on function public.reconcile_canceled_payment_refund(text, text) from public, anon, authenticated;
revoke all on function public.reconcile_partial_payment_cancellation(text, text, integer) from public, anon, authenticated;
revoke all on function public.list_payment_orders_for_refund(uuid, integer) from public, anon, authenticated;
revoke all on function public.preview_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.begin_account_deletion(uuid, text) from public, anon, authenticated;
revoke all on function public.expire_due_credit_lots(integer) from public, anon, authenticated;

grant execute on function public.expire_credit_lots_for_user(uuid) to service_role;
grant execute on function public.consume_credit_lots(uuid, integer, text, text, boolean) to service_role;
grant execute on function public.consume_transcription_credits(uuid, integer, text, numeric, text) to service_role;
grant execute on function public.deduct_credits(uuid, integer) to service_role;
grant execute on function public.ensure_welcome_credit_profile(uuid, text, text[]) to service_role;
grant execute on function public.complete_payment_order(text, uuid, text, timestamptz) to service_role;
grant execute on function public.complete_payment_order(text, uuid, text) to service_role;
grant execute on function public.enqueue_diarization_job(uuid, text, text, text, numeric, integer) to service_role;
grant execute on function public.complete_diarization_job(uuid, uuid, text, jsonb, text, bigint) to service_role;
grant execute on function public.release_diarization_credit_allocations(uuid, uuid) to service_role;
grant execute on function public.fail_diarization_job(uuid, uuid, text) to service_role;
grant execute on function public.cancel_diarization_job(uuid, uuid) to service_role;
grant execute on function public.complete_caption_idea_request(uuid, uuid, text, jsonb, text, integer, integer, integer, numeric, bigint) to service_role;
grant execute on function public.prepare_payment_refund(text, uuid, text) to service_role;
grant execute on function public.complete_payment_refund(text, uuid, text) to service_role;
grant execute on function public.fail_payment_refund(text, uuid, text) to service_role;
grant execute on function public.reconcile_canceled_payment_refund(text, text) to service_role;
grant execute on function public.reconcile_partial_payment_cancellation(text, text, integer) to service_role;
grant execute on function public.list_payment_orders_for_refund(uuid, integer) to service_role;
grant execute on function public.preview_account_deletion(uuid) to service_role;
grant execute on function public.begin_account_deletion(uuid, text) to service_role;
grant execute on function public.expire_due_credit_lots(integer) to service_role;

comment on table public.credit_lots is
  'Server-only credit source ledger. Existing balances are legacy and non-expiring; new paid lots expire one year after approval.';
comment on table public.credit_allocations is
  'Server-only mapping from each credit-consuming operation to the exact source lots it used or reserved.';

notify pgrst, 'reload schema';

-- Compatibility for the old container during schema-first deployment.
create or replace function public.complete_payment_order(
  p_order_id text,
  p_user_id uuid,
  p_payment_key text
)
returns table (credits integer, charged integer, already_paid boolean)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.complete_payment_order(
    p_order_id,
    p_user_id,
    p_payment_key,
    now()
  );
$$;
