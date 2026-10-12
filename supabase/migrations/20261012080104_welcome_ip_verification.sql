-- Welcome profiles no longer receive a balance as a side effect of authentication.
-- The authenticated claim RPC below is the only path that creates the welcome lot.
create table public.welcome_credit_eligibility (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  granted_at timestamptz
);

create table public.welcome_credit_ip_attempts (
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  account_hash text not null check (account_hash ~ '^[0-9a-f]{64}$'),
  first_attempt_at timestamptz not null default now(),
  challenge_nonce uuid,
  challenge_expires_at timestamptz,
  primary key (ip_hash, account_hash),
  check ((challenge_nonce is null) = (challenge_expires_at is null))
);

create index welcome_credit_ip_attempts_recent_idx
  on public.welcome_credit_ip_attempts (ip_hash, first_attempt_at desc);
create index welcome_credit_ip_attempts_retention_idx
  on public.welcome_credit_ip_attempts (first_attempt_at);

create table public.welcome_credit_ip_grants (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  account_hash text not null check (account_hash ~ '^[0-9a-f]{64}$'),
  granted_at timestamptz not null default now()
);

create index welcome_credit_ip_grants_recent_idx
  on public.welcome_credit_ip_grants (ip_hash, granted_at desc);
create index welcome_credit_ip_grants_retention_idx
  on public.welcome_credit_ip_grants (granted_at);

alter table public.welcome_credit_eligibility enable row level security;
alter table public.welcome_credit_ip_attempts enable row level security;
alter table public.welcome_credit_ip_grants enable row level security;

revoke all on table public.welcome_credit_eligibility from public, anon, authenticated;
revoke all on table public.welcome_credit_ip_attempts from public, anon, authenticated;
revoke all on table public.welcome_credit_ip_grants from public, anon, authenticated;
grant select, insert, update, delete on table public.welcome_credit_eligibility to service_role;
grant select, insert, update, delete on table public.welcome_credit_ip_attempts to service_role;
grant select, insert, update, delete on table public.welcome_credit_ip_grants to service_role;
grant usage, select on sequence public.welcome_credit_ip_grants_id_seq to service_role;

comment on table public.welcome_credit_ip_attempts is
  'HMAC-only distinct account attempts per network. Expired rows are pruned in bounded batches after seven days.';
comment on table public.welcome_credit_ip_grants is
  'HMAC-only welcome grants used for the rolling 24-hour network limit; rows are retained for at most seven days.';

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

  -- Keep the established credit-user → welcome-user → sorted identity lock order.
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

  insert into public.profiles (id, email, credits, plan)
  values (p_user_id, lower(btrim(p_email)), 0, 'free');

  if not v_already_claimed then
    insert into public.welcome_credit_eligibility (user_id)
    values (p_user_id);
  end if;

  return query select 0, 'free'::text, false;
end;
$$;

create or replace function public.prepare_welcome_credit_claim(
  p_user_id uuid,
  p_ip_hash text,
  p_account_hash text
)
returns table (
  eligible boolean,
  challenge_required boolean,
  challenge_nonce uuid,
  retry_at timestamptz,
  reason text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_eligibility public.welcome_credit_eligibility%rowtype;
  v_attempt_count integer;
  v_nonce uuid;
  v_challenge_expires timestamptz;
  v_retry_at timestamptz;
begin
  if p_user_id is null
    or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
    or p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'WC004', message = '무료 체험 확인 정보가 올바르지 않습니다.';
  end if;

  select * into v_eligibility
  from public.welcome_credit_eligibility as e
  where e.user_id = p_user_id;

  if not found then
    return query select false, false, null::uuid, null::timestamptz, 'not_eligible'::text;
    return;
  end if;
  if v_eligibility.granted_at is not null then
    return query select false, false, null::uuid, null::timestamptz, 'already_granted'::text;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('welcome-ip:' || p_ip_hash, 0));

  -- Bounded cleanup keeps each API call's maintenance work capped. The caller also
  -- runs this before grants, while the rolling-window predicates remain authoritative.
  with expired as (
    select a.ctid
    from public.welcome_credit_ip_attempts as a
    where a.first_attempt_at < now() - interval '7 days'
    order by a.first_attempt_at
    limit 1000
  )
  delete from public.welcome_credit_ip_attempts as a
  using expired
  where a.ctid = expired.ctid;

  with expired as (
    select g.id
    from public.welcome_credit_ip_grants as g
    where g.granted_at < now() - interval '7 days'
    order by g.granted_at
    limit 1000
  )
  delete from public.welcome_credit_ip_grants as g
  using expired
  where g.id = expired.id;

  insert into public.welcome_credit_ip_attempts (ip_hash, account_hash)
  values (p_ip_hash, p_account_hash)
  on conflict (ip_hash, account_hash) do nothing;

  select count(distinct a.account_hash)::integer
  into v_attempt_count
  from public.welcome_credit_ip_attempts as a
  where a.ip_hash = p_ip_hash
    and a.first_attempt_at >= now() - interval '7 days';

  select a.challenge_nonce, a.challenge_expires_at
  into v_nonce, v_challenge_expires
  from public.welcome_credit_ip_attempts as a
  where a.ip_hash = p_ip_hash and a.account_hash = p_account_hash;

  if v_attempt_count >= 2 and (v_nonce is null or v_challenge_expires <= now()) then
    v_nonce := gen_random_uuid();
    v_challenge_expires := now() + interval '5 minutes';
    update public.welcome_credit_ip_attempts as a
    set challenge_nonce = v_nonce,
        challenge_expires_at = v_challenge_expires
    where a.ip_hash = p_ip_hash and a.account_hash = p_account_hash;
  end if;

  select min(g.granted_at + interval '24 hours')
  into v_retry_at
  from public.welcome_credit_ip_grants as g
  where g.ip_hash = p_ip_hash
    and g.granted_at > now() - interval '24 hours';

  if v_retry_at is not null then
    return query select true, v_attempt_count >= 2, v_nonce, v_retry_at, 'ip_limit'::text;
    return;
  end if;

  return query select true, v_attempt_count >= 2, v_nonce, null::timestamptz, 'ready'::text;
end;
$$;

create or replace function public.claim_welcome_credit(
  p_user_id uuid,
  p_identity_hashes text[],
  p_ip_hash text,
  p_account_hash text,
  p_email_confirmed boolean,
  p_challenge_nonce uuid default null,
  p_turnstile_valid boolean default false
)
returns table (
  status text,
  credits integer,
  retry_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_eligibility public.welcome_credit_eligibility%rowtype;
  v_profile_balance integer;
  v_lot_balance integer;
  v_attempt_count integer;
  v_attempt public.welcome_credit_ip_attempts%rowtype;
  v_retry_at timestamptz;
  v_identity_claimed boolean;
begin
  if p_user_id is null
    or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
    or p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$'
    or coalesce(p_email_confirmed, false) is false then
    raise exception using errcode = 'WC004', message = '이메일 인증과 무료 체험 요청을 확인해주세요.';
  end if;

  if coalesce(array_length(p_identity_hashes, 1), 0) = 0 or exists (
    select 1
    from unnest(coalesce(p_identity_hashes, '{}'::text[])) as value
    where value is null or btrim(value) !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = 'WC001', message = '무료 체험 식별값이 올바르지 않습니다.';
  end if;

  -- Match credit operations first, then the existing welcome identity lock order.
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
  perform pg_advisory_xact_lock(hashtextextended('welcome-ip:' || p_ip_hash, 0));

  select * into v_eligibility
  from public.welcome_credit_eligibility as e
  where e.user_id = p_user_id
  for update;

  if not found then
    return query select 'not_eligible'::text, null::integer, null::timestamptz;
    return;
  end if;

  select coalesce(p.credits, 0)
  into v_profile_balance
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'WC003', message = '회원 잔액을 확인하지 못했습니다.';
  end if;

  if v_eligibility.granted_at is not null then
    return query select 'already_granted'::text, v_profile_balance, null::timestamptz;
    return;
  end if;

  select exists (
    select 1
    from public.welcome_credit_claims as c
    where c.benefit_code = 'welcome_10_minutes'
      and c.identity_hash = any(p_identity_hashes)
  ) into v_identity_claimed;

  if v_identity_claimed then
    return query select 'identity_claimed'::text, v_profile_balance, null::timestamptz;
    return;
  end if;

  select a.* into v_attempt
  from public.welcome_credit_ip_attempts as a
  where a.ip_hash = p_ip_hash and a.account_hash = p_account_hash
  for update;

  if not found then
    return query select 'attempt_required'::text, v_profile_balance, null::timestamptz;
    return;
  end if;

  select count(distinct a.account_hash)::integer
  into v_attempt_count
  from public.welcome_credit_ip_attempts as a
  where a.ip_hash = p_ip_hash
    and a.first_attempt_at >= now() - interval '7 days';

  if v_attempt_count >= 2 and (
    not coalesce(p_turnstile_valid, false)
    or p_challenge_nonce is null
    or v_attempt.challenge_nonce is distinct from p_challenge_nonce
    or v_attempt.challenge_expires_at is null
    or v_attempt.challenge_expires_at <= now()
  ) then
    return query select 'challenge_required'::text, v_profile_balance, null::timestamptz;
    return;
  end if;

  select min(g.granted_at + interval '24 hours')
  into v_retry_at
  from public.welcome_credit_ip_grants as g
  where g.ip_hash = p_ip_hash
    and g.granted_at > now() - interval '24 hours';

  if v_retry_at is not null then
    return query select 'ip_limit'::text, v_profile_balance, v_retry_at;
    return;
  end if;

  select coalesce(sum(l.available), 0)::integer
  into v_lot_balance
  from public.credit_lots as l
  where l.user_id = p_user_id;

  if v_profile_balance <> v_lot_balance then
    raise exception using errcode = 'WC005', message = '크레딧 장부 잔액을 확인하지 못했습니다.';
  end if;

  -- The sorted identity locks and the pre-check above make these inserts all-or-nothing.
  -- A conflict must roll back the complete claim instead of partially reserving identities.
  insert into public.welcome_credit_claims (identity_hash)
  select distinct btrim(value)
  from unnest(p_identity_hashes) as value
  order by btrim(value);

  update public.profiles as p
  set credits = coalesce(p.credits, 0) + 10,
      updated_at = now()
  where p.id = p_user_id
  returning coalesce(p.credits, 0) into v_profile_balance;

  insert into public.credit_lots (user_id, source, granted, available)
  values (p_user_id, 'welcome', 10, 10);

  update public.welcome_credit_eligibility as e
  set granted_at = now()
  where e.user_id = p_user_id;

  insert into public.welcome_credit_ip_grants (ip_hash, account_hash)
  values (p_ip_hash, p_account_hash);

  return query select 'granted'::text, v_profile_balance, null::timestamptz;
end;
$$;

create or replace function public.cleanup_welcome_credit_ip_records(p_limit integer default 1000)
returns table (attempts_deleted integer, grants_deleted integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 5000));
  v_attempts integer := 0;
  v_grants integer := 0;
begin
  with expired as (
    select a.ctid
    from public.welcome_credit_ip_attempts as a
    where a.first_attempt_at < now() - interval '7 days'
    order by a.first_attempt_at
    limit v_limit
  )
  delete from public.welcome_credit_ip_attempts as a
  using expired
  where a.ctid = expired.ctid;
  get diagnostics v_attempts = row_count;

  with expired as (
    select g.id
    from public.welcome_credit_ip_grants as g
    where g.granted_at < now() - interval '7 days'
    order by g.granted_at
    limit v_limit
  )
  delete from public.welcome_credit_ip_grants as g
  using expired
  where g.id = expired.id;
  get diagnostics v_grants = row_count;

  return query select v_attempts, v_grants;
end;
$$;

revoke all on function public.register_welcome_credit_claims(text[])
  from public, anon, authenticated;
revoke all on function public.ensure_welcome_credit_profile(uuid, text, text[])
  from public, anon, authenticated;
revoke all on function public.prepare_welcome_credit_claim(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_welcome_credit(uuid, text[], text, text, boolean, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.cleanup_welcome_credit_ip_records(integer)
  from public, anon, authenticated;

grant execute on function public.register_welcome_credit_claims(text[]) to service_role;
grant execute on function public.ensure_welcome_credit_profile(uuid, text, text[]) to service_role;
grant execute on function public.prepare_welcome_credit_claim(uuid, text, text) to service_role;
grant execute on function public.claim_welcome_credit(uuid, text[], text, text, boolean, uuid, boolean) to service_role;
grant execute on function public.cleanup_welcome_credit_ip_records(integer) to service_role;

notify pgrst, 'reload schema';
