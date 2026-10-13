-- Roll out the IP-limited welcome grant only after Railway's X-Real-IP
-- header has been verified for this service. The RPC never depends on CAPTCHA.
create or replace function public.get_welcome_credit_ip_status(p_ip_hash text)
returns table (status text, retry_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_retry_at timestamptz;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'WC001', message = '무료 체험 확인 정보가 올바르지 않습니다.';
  end if;

  select min(g.granted_at + interval '24 hours')
  into v_retry_at
  from public.welcome_credit_ip_grants as g
  where g.ip_hash = p_ip_hash
    and g.granted_at > now() - interval '24 hours';

  if v_retry_at is not null then
    return query select 'ip_limit'::text, v_retry_at;
  else
    return query select 'ready'::text, null::timestamptz;
  end if;
end;
$$;

revoke all on function public.get_welcome_credit_ip_status(text)
  from public, anon, authenticated;
grant execute on function public.get_welcome_credit_ip_status(text)
  to service_role;

create or replace function public.claim_welcome_credit_ip(
  p_user_id uuid,
  p_identity_hashes text[],
  p_email_confirmed boolean,
  p_ip_hash text,
  p_account_hash text
)
returns table (status text, credits integer, retry_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_eligibility public.welcome_credit_eligibility%rowtype;
  v_profile_balance integer;
  v_lot_balance integer;
  v_identity_claimed boolean;
  v_prior_grant boolean;
  v_retry_at timestamptz;
begin
  if p_user_id is null or coalesce(p_email_confirmed, false) is false then
    raise exception using errcode = 'WC004', message = '이메일 인증과 무료 체험 요청을 확인해주세요.';
  end if;

  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$'
     or coalesce(array_length(p_identity_hashes, 1), 0) = 0
     or exists (
       select 1 from unnest(coalesce(p_identity_hashes, '{}'::text[])) as value
       where value is null or btrim(value) !~ '^[0-9a-f]{64}$'
     ) then
    raise exception using errcode = 'WC001', message = '무료 체험 식별값이 올바르지 않습니다.';
  end if;

  -- Match credit operations and identity claim lock ordering, then serialize
  -- all grants from the same network before reading the rolling limit.
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

  select coalesce(p.credits, 0) into v_profile_balance
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

  select coalesce(sum(l.available), 0)::integer into v_lot_balance
  from public.credit_lots as l where l.user_id = p_user_id;
  if v_profile_balance <> v_lot_balance then
    raise exception using errcode = 'WC005', message = '크레딧 장부 잔액을 확인하지 못했습니다.';
  end if;

  -- Existing manual/legacy welcome credits count as fulfilled, without
  -- changing their balance or consuming the new network quota.
  select exists (
    select 1 from public.credit_lots as l
    where l.user_id = p_user_id and l.source = 'welcome'
  ) into v_prior_grant;
  if v_prior_grant then
    insert into public.welcome_credit_claims (identity_hash)
    select distinct btrim(value) from unnest(p_identity_hashes) as value
    order by btrim(value)
    on conflict (benefit_code, identity_hash) do nothing;
    update public.welcome_credit_eligibility as e set granted_at = now()
    where e.user_id = p_user_id;
    return query select 'already_granted'::text, v_profile_balance, null::timestamptz;
    return;
  end if;

  select exists (
    select 1 from public.welcome_credit_claims as c
    where c.benefit_code = 'welcome_10_minutes'
      and c.identity_hash = any(p_identity_hashes)
  ) into v_identity_claimed;
  if v_identity_claimed then
    delete from public.welcome_credit_eligibility as e where e.user_id = p_user_id;
    return query select 'identity_claimed'::text, v_profile_balance, null::timestamptz;
    return;
  end if;

  select min(g.granted_at + interval '24 hours') into v_retry_at
  from public.welcome_credit_ip_grants as g
  where g.ip_hash = p_ip_hash
    and g.granted_at > now() - interval '24 hours';
  if v_retry_at is not null then
    return query select 'ip_limit'::text, v_profile_balance, v_retry_at;
    return;
  end if;

  insert into public.welcome_credit_claims (identity_hash)
  select distinct btrim(value) from unnest(p_identity_hashes) as value
  order by btrim(value);

  update public.profiles as p
  set credits = coalesce(p.credits, 0) + 10, updated_at = now()
  where p.id = p_user_id returning coalesce(p.credits, 0) into v_profile_balance;

  insert into public.credit_lots (user_id, source, granted, available)
  values (p_user_id, 'welcome', 10, 10);
  insert into public.welcome_credit_ip_grants (ip_hash, account_hash)
  values (p_ip_hash, p_account_hash);
  update public.welcome_credit_eligibility as e set granted_at = now()
  where e.user_id = p_user_id;

  return query select 'granted'::text, v_profile_balance, null::timestamptz;
end;
$$;

revoke all on function public.claim_welcome_credit_ip(uuid, text[], boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_welcome_credit_ip(uuid, text[], boolean, text, text)
  to service_role;

notify pgrst, 'reload schema';
