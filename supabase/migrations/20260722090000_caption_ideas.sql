create table public.caption_idea_wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  remaining_uses smallint not null default 0
    check (remaining_uses between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.caption_idea_requests (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('entertainment', 'situation', 'emotion')),
  ideas jsonb,
  credits_charged smallint not null check (credits_charged in (0, 1)),
  remaining_uses_after smallint not null
    check (remaining_uses_after between 0 and 5),
  model text not null check (char_length(model) between 1 and 100),
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  cached_tokens integer not null default 0 check (cached_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  estimated_cost_usd numeric(12, 8)
    check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  ideas_expires_at timestamptz not null default (now() + interval '24 hours'),
  check (ideas is null or (jsonb_typeof(ideas) = 'array' and jsonb_array_length(ideas) = 3))
);

create index caption_idea_requests_user_created_at_idx
  on public.caption_idea_requests (user_id, created_at desc);

create index caption_idea_requests_ideas_expiry_idx
  on public.caption_idea_requests (ideas_expires_at)
  where ideas is not null;

alter table public.caption_idea_wallets enable row level security;
alter table public.caption_idea_requests enable row level security;

revoke all on table public.caption_idea_wallets from public, anon, authenticated;
revoke all on table public.caption_idea_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.caption_idea_wallets to service_role;
grant select, insert, update, delete on table public.caption_idea_requests to service_role;

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
  v_credits integer;
  v_remaining smallint;
  v_credits_charged integer := 0;
begin
  if p_mode is null or p_mode not in ('entertainment', 'situation', 'emotion') then
    raise exception using errcode = 'CI001', message = '자막 유형이 올바르지 않습니다.';
  end if;

  if p_ideas is null
    or jsonb_typeof(p_ideas) <> 'array' then
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

  -- Every request for one user takes the profile lock first. This keeps wallet and
  -- credit mutations in a stable order even when distinct request IDs arrive together.
  select p.credits
  into v_credits
  from public.profiles as p
  where p.id = p_user_id
  for update;

  if v_credits is null then
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
    if v_credits < 1 then
      raise exception using errcode = 'CI002', message = '변환 가능 시간이 부족합니다.';
    end if;

    update public.profiles as p
    set credits = p.credits - 1,
        updated_at = now()
    where p.id = p_user_id
    returning p.credits into v_credits;

    v_remaining := 4;
    v_credits_charged := 1;

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

create or replace function public.cleanup_caption_idea_requests()
returns table (ideas_cleared integer, requests_deleted integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cleared integer;
  v_deleted integer;
begin
  update public.caption_idea_requests as r
  set ideas = null
  where r.ideas is not null
    and r.ideas_expires_at <= now();
  get diagnostics v_cleared = row_count;

  delete from public.caption_idea_requests as r
  where r.created_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;

  return query select v_cleared, v_deleted;
end;
$$;

revoke all on function public.complete_caption_idea_request(
  uuid, uuid, text, jsonb, text, integer, integer, integer, numeric, bigint
) from public, anon, authenticated;
revoke all on function public.cleanup_caption_idea_requests()
  from public, anon, authenticated;

grant execute on function public.complete_caption_idea_request(
  uuid, uuid, text, jsonb, text, integer, integer, integer, numeric, bigint
) to service_role;
grant execute on function public.cleanup_caption_idea_requests() to service_role;

notify pgrst, 'reload schema';
