create table public.welcome_credit_claims (
  benefit_code text not null default 'welcome_10_minutes'
    check (benefit_code = 'welcome_10_minutes'),
  identity_hash text not null
    check (identity_hash ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz not null default now(),
  primary key (benefit_code, identity_hash)
);

comment on table public.welcome_credit_claims is
  'Server-only HMAC markers that prevent repeated welcome-credit grants.';
comment on column public.welcome_credit_claims.identity_hash is
  'HMAC only; never stores a raw email address or OAuth provider identifier.';

alter table public.welcome_credit_claims enable row level security;

revoke all on table public.welcome_credit_claims from public, anon, authenticated;
grant select, insert on table public.welcome_credit_claims to service_role;

create or replace function public.register_welcome_credit_claims(
  p_identity_hashes text[]
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_identity_count integer;
  v_inserted_count integer;
begin
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

  perform pg_advisory_xact_lock(
    hashtextextended('welcome-identity:' || normalized.identity_hash, 0)
  )
  from (
    select distinct btrim(value) as identity_hash
    from unnest(p_identity_hashes) as value
  ) as normalized
  order by normalized.identity_hash;

  insert into public.welcome_credit_claims (identity_hash)
  select distinct btrim(value)
  from unnest(p_identity_hashes) as value
  order by btrim(value)
  on conflict (benefit_code, identity_hash) do nothing;

  get diagnostics v_inserted_count = row_count;
  return v_inserted_count;
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

  perform pg_advisory_xact_lock(hashtextextended('welcome-user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(
    hashtextextended('welcome-identity:' || normalized.identity_hash, 0)
  )
  from (
    select distinct btrim(value) as identity_hash
    from unnest(p_identity_hashes) as value
  ) as normalized
  order by normalized.identity_hash;

  select p.credits, p.plan
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
  values (p_user_id, lower(btrim(p_email)), case when v_granted then 10 else 0 end, 'free')
  on conflict (id) do nothing;

  select p.credits, p.plan
  into v_credits, v_plan
  from public.profiles as p
  where p.id = p_user_id;

  if not found then
    raise exception using errcode = 'WC003', message = '회원 정보를 생성하지 못했습니다.';
  end if;

  return query select v_credits, v_plan, v_granted;
end;
$$;

revoke all on function public.register_welcome_credit_claims(text[])
  from public, anon, authenticated;
revoke all on function public.ensure_welcome_credit_profile(uuid, text, text[])
  from public, anon, authenticated;
grant execute on function public.register_welcome_credit_claims(text[]) to service_role;
grant execute on function public.ensure_welcome_credit_profile(uuid, text, text[]) to service_role;

notify pgrst, 'reload schema';
