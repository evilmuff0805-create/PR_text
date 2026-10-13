-- Restore new-account welcome credits by default while keeping the IP/CAPTCHA
-- path available only when the operator explicitly selects guarded mode.
create or replace function public.claim_welcome_credit_identity(
  p_user_id uuid,
  p_identity_hashes text[],
  p_email_confirmed boolean
)
returns table (status text, credits integer)
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
begin
  if p_user_id is null or coalesce(p_email_confirmed, false) is false then
    raise exception using errcode = 'WC004', message = '이메일 인증과 무료 체험 요청을 확인해주세요.';
  end if;

  if coalesce(array_length(p_identity_hashes, 1), 0) = 0 or exists (
    select 1
    from unnest(coalesce(p_identity_hashes, '{}'::text[])) as value
    where value is null or btrim(value) !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = 'WC001', message = '무료 체험 식별값이 올바르지 않습니다.';
  end if;

  -- Match credit operations and the existing identity lock order.
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

  select * into v_eligibility
  from public.welcome_credit_eligibility as e
  where e.user_id = p_user_id
  for update;

  if not found then
    return query select 'not_eligible'::text, null::integer;
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
    return query select 'already_granted'::text, v_profile_balance;
    return;
  end if;

  select coalesce(sum(l.available), 0)::integer
  into v_lot_balance
  from public.credit_lots as l
  where l.user_id = p_user_id;

  if v_profile_balance <> v_lot_balance then
    raise exception using errcode = 'WC005', message = '크레딧 장부 잔액을 확인하지 못했습니다.';
  end if;

  -- A welcome lot already delivered the benefit.
  -- Mark this pending eligibility and identity so the automatic retry is safe.
  select exists (
    select 1
    from public.credit_lots as l
    where l.user_id = p_user_id and l.source = 'welcome'
  ) into v_prior_grant;

  if v_prior_grant then
    insert into public.welcome_credit_claims (identity_hash)
    select distinct btrim(value)
    from unnest(p_identity_hashes) as value
    order by btrim(value)
    on conflict (benefit_code, identity_hash) do nothing;

    update public.welcome_credit_eligibility as e
    set granted_at = now()
    where e.user_id = p_user_id;

    return query select 'already_granted'::text, v_profile_balance;
    return;
  end if;

  select exists (
    select 1
    from public.welcome_credit_claims as c
    where c.benefit_code = 'welcome_10_minutes'
      and c.identity_hash = any(p_identity_hashes)
  ) into v_identity_claimed;

  if v_identity_claimed then
    delete from public.welcome_credit_eligibility as e
    where e.user_id = p_user_id;
    return query select 'identity_claimed'::text, v_profile_balance;
    return;
  end if;

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

  return query select 'granted'::text, v_profile_balance;
end;
$$;

revoke all on function public.claim_welcome_credit_identity(uuid, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.claim_welcome_credit_identity(uuid, text[], boolean)
  to service_role;

notify pgrst, 'reload schema';
