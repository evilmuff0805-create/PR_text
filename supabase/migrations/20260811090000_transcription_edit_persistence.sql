-- 편집기에서 다듬은 자막이 세션 안에서만 살아 있었다. 창을 닫으면 사라지고,
-- 재다운로드는 교정 직후 원본을 내려줘서 편집한 내용이 영구히 소실됐다.
-- 편집본을 원본과 나란히 보관하고, 재다운로드가 편집본을 우선 쓰게 한다.

alter table public.transcription_logs
  add column if not exists edited_segments jsonb,
  add column if not exists edited_at timestamptz;

create or replace function public.save_transcription_edits(
  p_log_id bigint,
  p_user_id uuid,
  p_segments jsonb
)
returns table (
  saved_count integer,
  edited_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid;
  v_original_count integer;
  v_next_count integer;
  v_edited_at timestamptz;
begin
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' then
    raise exception using errcode = 'TE001', message = '자막 형식이 올바르지 않습니다.';
  end if;

  v_next_count := jsonb_array_length(p_segments);
  if v_next_count = 0 or v_next_count > 5000 then
    raise exception using errcode = 'TE001', message = '자막 개수가 허용 범위를 벗어났습니다.';
  end if;

  select l.user_id, jsonb_array_length(coalesce(l.segments, '[]'::jsonb))
  into v_owner, v_original_count
  from public.transcription_logs as l
  where l.id = p_log_id
  for update;

  if not found or v_owner is null or v_owner <> p_user_id then
    raise exception using errcode = 'TE002', message = '변환 기록을 찾을 수 없습니다.';
  end if;

  -- 구간 수가 달라지면 타임코드와 자막이 어긋난다. 편집기도 같은 규칙으로 막고 있다.
  if v_next_count <> v_original_count then
    raise exception using errcode = 'TE003', message = '자막 개수가 원본과 다릅니다.';
  end if;

  -- 각 항목은 문자열 text를 가진 객체여야 한다. 타임코드는 원본 것을 그대로 쓴다.
  if exists (
    select 1
    from jsonb_array_elements(p_segments) as item(value)
    where jsonb_typeof(item.value) <> 'object'
      or jsonb_typeof(item.value -> 'text') <> 'string'
      or char_length(item.value ->> 'text') > 10000
  ) then
    raise exception using errcode = 'TE001', message = '자막 항목 형식이 올바르지 않습니다.';
  end if;

  update public.transcription_logs as l
  set edited_segments = p_segments,
      edited_at = now()
  where l.id = p_log_id
  returning l.edited_at into v_edited_at;

  return query select v_next_count, v_edited_at;
end;
$$;

revoke all on function public.save_transcription_edits(bigint, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_transcription_edits(bigint, uuid, jsonb) to service_role;
