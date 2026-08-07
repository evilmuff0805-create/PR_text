-- 자막 아이디어에 강조(emphasis) 모드를 추가합니다.
-- 기존 예능/상황/감성 모드와 이미 저장된 데이터는 변경하지 않습니다.

alter table public.caption_idea_requests
  drop constraint if exists caption_idea_requests_mode_check;

alter table public.caption_idea_requests
  add constraint caption_idea_requests_mode_check
  check (mode in ('entertainment', 'situation', 'emphasis', 'emotion'));

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
  if p_mode is null or p_mode not in ('entertainment', 'situation', 'emphasis', 'emotion') then
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
