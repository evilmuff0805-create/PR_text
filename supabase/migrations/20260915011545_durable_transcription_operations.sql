-- Durable ordinary transcription operations are intentionally separate from transcription_jobs.
create table public.transcription_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  operation_key uuid not null,
  payload_hash text not null check (char_length(payload_hash) = 64),
  filename text not null check (char_length(filename) between 1 and 500),
  content_type text,
  byte_size bigint not null check (byte_size between 1 and 157286400),
  requested_language text,
  duration_seconds numeric check (duration_seconds is null or duration_seconds >= 0),
  credits_reserved integer not null default 0 check (credits_reserved >= 0),
  status text not null default 'staged' check (status in ('staged', 'queued', 'running', 'finalizing', 'completed', 'failed', 'cancelled')),
  storage_manifest jsonb not null default '[]'::jsonb check (jsonb_typeof(storage_manifest) = 'array'),
  worker_token uuid,
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  checkpoint_text text,
  checkpoint_segments jsonb,
  checkpoint_language text,
  result_text text,
  result_segments jsonb,
  result_language text,
  transcription_log_id bigint references public.transcription_logs(id) on delete set null,
  credits_restored integer not null default 0 check (credits_restored between 0 and credits_reserved),
  error_message text,
  timings jsonb,
  audio_deleted_at timestamptz,
  ready_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, operation_key)
);
create index transcription_operations_claim_idx on public.transcription_operations (status, created_at) where status in ('queued', 'running', 'finalizing');
create index transcription_operations_user_created_idx on public.transcription_operations (user_id, created_at desc);
alter table public.transcription_operations enable row level security;
revoke all on table public.transcription_operations from public, anon, authenticated;
grant select, insert, update, delete on table public.transcription_operations to service_role;

-- Split source parts stay below projects that enforce a 50MB Storage object ceiling.
insert into storage.buckets (id, name, public, file_size_limit)
values ('transcription-operation-audio', 'transcription-operation-audio', false, 41943040)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function public.create_transcription_operation(
  p_user_id uuid, p_operation_key uuid, p_payload_hash text, p_filename text, p_content_type text,
  p_byte_size bigint, p_requested_language text, p_duration_seconds numeric
) returns table (operation_id uuid, status text, existing boolean, credits_remaining integer)
language plpgsql security invoker set search_path = '' as $$
declare v public.transcription_operations%rowtype; balance integer;
begin
  if p_user_id is null or p_operation_key is null or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_filename is null or char_length(p_filename) not between 1 and 500
    or coalesce(p_byte_size, 0) not between 1 and 157286400 then
    raise exception using errcode = 'TO001', message = '변환 작업 정보가 올바르지 않습니다.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then raise exception using errcode = 'TO404', message = '계정 정보를 찾을 수 없습니다.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('transcription-operation:' || p_user_id::text || ':' || p_operation_key::text, 0));
  select * into v from public.transcription_operations where user_id = p_user_id and operation_key = p_operation_key for update;
  if found then
    if v.payload_hash <> p_payload_hash then
      raise exception using errcode = 'TO409', message = '같은 작업 키에 다른 파일이나 옵션을 사용할 수 없습니다.';
    end if;
    select credits into balance from public.profiles where id = p_user_id;
    return query select v.id, v.status, true, coalesce(balance, 0); return;
  end if;
  if (select count(*) from public.transcription_operations as op where op.user_id=p_user_id and op.status in ('staged','queued','running','finalizing')) >= 3 then
    raise exception using errcode='TO429', message='진행 중인 작업을 완료하거나 취소한 뒤 새 변환을 시작해주세요.';
  end if;
  insert into public.transcription_operations (user_id, operation_key, payload_hash, filename, content_type, byte_size, requested_language, duration_seconds)
  values (p_user_id, p_operation_key, p_payload_hash, p_filename, nullif(p_content_type, ''), p_byte_size, nullif(p_requested_language, ''), p_duration_seconds)
  returning * into v;
  select credits into balance from public.profiles where id = p_user_id;
  return query select v.id, v.status, false, coalesce(balance, 0);
end;
$$;

create or replace function public.queue_transcription_operation(
  p_operation_id uuid, p_user_id uuid, p_storage_manifest jsonb, p_credits integer
) returns table (operation_id uuid, status text, credits_remaining integer, already_queued boolean)
language plpgsql security invoker set search_path = '' as $$
declare v public.transcription_operations%rowtype; credit record;
begin
  if p_storage_manifest is null or jsonb_typeof(p_storage_manifest) <> 'array' or jsonb_array_length(p_storage_manifest) < 1 or coalesce(p_credits, 0) < 1 then
    raise exception using errcode = 'TO001', message = '변환 저장 정보가 올바르지 않습니다.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  perform 1 from public.profiles where id = p_user_id for update;
  select * into v from public.transcription_operations where id = p_operation_id and user_id = p_user_id for update;
  if not found then raise exception using errcode = 'TO404', message = '변환 작업을 찾을 수 없습니다.'; end if;
  if (select coalesce(sum((part.value->>'bytes')::bigint), 0) from jsonb_array_elements(p_storage_manifest) as part(value)) <> v.byte_size
    or jsonb_array_length(p_storage_manifest) > 4 or (select count(distinct part.value->>'path') from jsonb_array_elements(p_storage_manifest) part(value)) <> jsonb_array_length(p_storage_manifest)
    or exists (select 1 from jsonb_array_elements(p_storage_manifest) as part(value) where coalesce(part.value->>'path','') !~ ('^' || p_user_id::text || '/' || p_operation_id::text || '/[0-9]{4}$') or coalesce((part.value->>'bytes')::bigint, 0) not between 1 and 41943040 or coalesce(part.value->>'sha256','') !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = 'TO001', message = '변환 원본 목록이 올바르지 않습니다.';
  end if;
  if v.duration_seconds is null or v.duration_seconds <= 0 or greatest(ceil(v.duration_seconds / 60.0)::integer,1) <> p_credits then raise exception using errcode = 'TO001', message = '예약 시간이 파일 길이와 일치하지 않습니다.'; end if;
  if v.status <> 'staged' then
    select credits into credit from public.profiles where id = p_user_id;
    return query select v.id, v.status, coalesce(credit.credits, 0), true; return;
  end if;
  select * into credit from public.consume_credit_lots(p_user_id, p_credits, 'transcription', 'operation:' || p_operation_id::text, true);
  if not found then return; end if;
  update public.transcription_operations set storage_manifest = p_storage_manifest, credits_reserved = p_credits, status = 'queued', updated_at = now() where id = p_operation_id;
  return query select p_operation_id, 'queued'::text, credit.credits_remaining, false;
end;
$$;

create or replace function public.claim_transcription_operation(p_worker_token uuid)
returns setof public.transcription_operations language plpgsql security invoker set search_path = '' as $$
begin
  if p_worker_token is null then raise exception using errcode = 'TO001', message = '작업자 식별값이 필요합니다.'; end if;
  return query with candidate as (
    select id from public.transcription_operations
    where (status = 'queued' and ready_at <= now()) or (status in ('running', 'finalizing') and locked_at < now() - interval '10 minutes')
    order by created_at for update skip locked limit 1
  ) update public.transcription_operations as o set
    status = case when o.checkpoint_segments is null then 'running' else 'finalizing' end,
    worker_token = p_worker_token, locked_at = now(), started_at = coalesce(o.started_at, now()),
    attempt_count = o.attempt_count + 1, error_message = null, updated_at = now()
  from candidate where o.id = candidate.id returning o.*;
end;
$$;

create or replace function public.renew_transcription_operation_lease(p_operation_id uuid, p_worker_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.transcription_operations set locked_at = now(), updated_at = now()
  where id = p_operation_id and status in ('running', 'finalizing') and worker_token = p_worker_token;
  return found;
end;
$$;

create or replace function public.checkpoint_transcription_operation(
  p_operation_id uuid, p_worker_token uuid, p_text text, p_segments jsonb, p_language text, p_timings jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' then raise exception using errcode = 'TO001', message = '변환 결과가 올바르지 않습니다.'; end if;
  update public.transcription_operations set status = 'finalizing', checkpoint_text = p_text, checkpoint_segments = p_segments,
    checkpoint_language = p_language, timings = p_timings, locked_at = now(), updated_at = now()
  where id = p_operation_id and status = 'running' and worker_token = p_worker_token;
  return found;
end;
$$;

-- Same FEFO/expiry/cancelled-payment reclamation as the established diarization release path.
create or replace function public.release_transcription_operation_credits(
  p_operation_id uuid,
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
      and a.operation_type = 'transcription'
      and a.operation_id = 'operation:' || p_operation_id::text
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

create or replace function public.assert_transcription_operation_reservation(p_operation_id uuid, p_user_id uuid, p_expected integer)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if (select coalesce(sum(amount),0) from public.credit_allocations where user_id=p_user_id and operation_type='transcription' and operation_id='operation:'||p_operation_id::text and state='reserved') <> p_expected
    or exists (select 1 from public.credit_allocations a join public.credit_lots l on l.id=a.lot_id where a.user_id=p_user_id and a.operation_type='transcription' and a.operation_id='operation:'||p_operation_id::text and (a.state<>'reserved' or l.reserved<a.amount)) then
    raise exception using errcode='CR003', message='예약 크레딧 장부가 일치하지 않습니다.';
  end if;
end; $$;
revoke all on function public.assert_transcription_operation_reservation(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.assert_transcription_operation_reservation(uuid,uuid,integer) to service_role;

create or replace function public.finalize_transcription_operation(p_operation_id uuid, p_worker_token uuid)
returns table (completed boolean, credits_remaining integer) language plpgsql security invoker set search_path = '' as $$
declare v public.transcription_operations%rowtype; a public.credit_allocations%rowtype; remaining integer; log_id bigint;
begin
  select user_id into v.user_id from public.transcription_operations where id = p_operation_id;
  if not found then return query select false, null::integer; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || v.user_id::text, 0));
  perform 1 from public.profiles where id = v.user_id for update;
  select * into v from public.transcription_operations where id = p_operation_id and status = 'finalizing' and worker_token = p_worker_token for update;
  if not found then return query select false, null::integer; return; end if;
  if v.checkpoint_segments is null then raise exception using errcode = 'TO001', message = '확정할 변환 결과가 없습니다.'; end if;
  perform public.assert_transcription_operation_reservation(v.id, v.user_id, v.credits_reserved);
  insert into public.transcription_logs (user_id, filename, duration_seconds, language, segments_count, text_preview, segments)
  values (v.user_id, v.filename, coalesce(v.duration_seconds, 0), coalesce(v.checkpoint_language, 'unknown'), jsonb_array_length(v.checkpoint_segments), left(coalesce(v.checkpoint_text, ''), 200), v.checkpoint_segments) returning id into log_id;
  if (select coalesce(sum(amount),0) from public.credit_allocations where user_id = v.user_id and operation_type = 'transcription' and operation_id = 'operation:' || v.id::text and state = 'reserved') <> v.credits_reserved then raise exception using errcode = 'CR003', message = '예약 크레딧 합계가 일치하지 않습니다.'; end if;
  for a in select * from public.credit_allocations where user_id = v.user_id and operation_type = 'transcription' and operation_id = 'operation:' || v.id::text and state = 'reserved' order by id for update loop
    update public.credit_lots set reserved = reserved - a.amount, updated_at = now() where id = a.lot_id and reserved >= a.amount;
    if not found then raise exception using errcode = 'CR003', message = '예약 크레딧 장부 잔액이 일치하지 않습니다.'; end if;
    update public.credit_allocations set state = 'consumed', updated_at = now() where id = a.id;
  end loop;
  insert into public.usage_logs (user_id, action, credits_used, audio_minutes, description)
  values (v.user_id, 'transcribe', v.credits_reserved, round((coalesce(v.duration_seconds, 0) / 60)::numeric, 1), left(format('%s (변환 완료)', v.filename), 500));
  update public.transcription_operations set status = 'completed', completed_at = now(), result_text = checkpoint_text, result_segments = checkpoint_segments,
    result_language = checkpoint_language, transcription_log_id = log_id, updated_at = now() where id = v.id;
  select credits into remaining from public.profiles where id = v.user_id;
  return query select true, remaining;
end;
$$;

create or replace function public.fail_transcription_operation(p_operation_id uuid, p_worker_token uuid, p_error_message text)
returns table (updated boolean, credits_remaining integer, credits_restored integer) language plpgsql security invoker set search_path = '' as $$
declare v public.transcription_operations%rowtype; remaining integer; restored integer;
begin
  select user_id into v.user_id from public.transcription_operations where id = p_operation_id;
  if not found then return query select false, null::integer, null::integer; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || v.user_id::text, 0));
  perform 1 from public.profiles where id = v.user_id for update;
  select * into v from public.transcription_operations where id = p_operation_id and status in ('queued','running','finalizing') and worker_token = p_worker_token for update;
  if not found then return query select false, null::integer, null::integer; return; end if;
  perform public.assert_transcription_operation_reservation(v.id, v.user_id, v.credits_reserved);
  restored := public.release_transcription_operation_credits(v.id, v.user_id);
  insert into public.usage_logs (user_id, action, credits_used, audio_minutes, description) values (v.user_id, 'refund', -restored, round((coalesce(v.duration_seconds,0)/60)::numeric,1), left(format('%s (변환 실패, 유효한 예약 %s/%s분 반환)', v.filename, restored, v.credits_reserved), 500));
  update public.transcription_operations set status = 'failed', completed_at = now(), credits_restored = restored, error_message = left(coalesce(p_error_message, '작업 처리 중 오류가 발생했습니다.'), 500), updated_at = now() where id = v.id;
  select credits into remaining from public.profiles where id = v.user_id;
  return query select true, remaining, restored;
end;
$$;

create or replace function public.cancel_transcription_operation(p_operation_id uuid, p_user_id uuid)
returns table (updated boolean, credits_remaining integer, credits_restored integer) language plpgsql security invoker set search_path = '' as $$
declare v public.transcription_operations%rowtype; remaining integer; restored integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  perform 1 from public.profiles where id = p_user_id for update;
  select * into v from public.transcription_operations where id = p_operation_id and user_id = p_user_id and status in ('staged', 'queued', 'running', 'finalizing') for update;
  if not found then return query select false, null::integer, null::integer; return; end if;

  perform public.assert_transcription_operation_reservation(v.id, v.user_id, v.credits_reserved);
  restored := public.release_transcription_operation_credits(v.id, v.user_id);
  insert into public.usage_logs (user_id, action, credits_used, audio_minutes, description) values (v.user_id, 'refund', -restored, round((coalesce(v.duration_seconds,0)/60)::numeric,1), left(format('%s (변환 취소, 유효한 예약 %s/%s분 반환)', v.filename, restored, v.credits_reserved), 500));
  update public.transcription_operations set status = 'cancelled', completed_at = now(), credits_restored = restored, error_message = '작업이 취소되었습니다. 유효한 예약 시간만 반환되었습니다.', updated_at = now() where id = v.id;
  select credits into remaining from public.profiles where id = v.user_id;
  return query select true, remaining, restored;
end;
$$;

revoke all on function public.create_transcription_operation(uuid, uuid, text, text, text, bigint, text, numeric) from public, anon, authenticated;
revoke all on function public.queue_transcription_operation(uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.claim_transcription_operation(uuid) from public, anon, authenticated;
revoke all on function public.renew_transcription_operation_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.checkpoint_transcription_operation(uuid, uuid, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_transcription_operation_credits(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_transcription_operation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_transcription_operation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_transcription_operation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_transcription_operation(uuid, uuid, text, text, text, bigint, text, numeric) to service_role;
grant execute on function public.queue_transcription_operation(uuid, uuid, jsonb, integer) to service_role;
grant execute on function public.claim_transcription_operation(uuid) to service_role;
grant execute on function public.renew_transcription_operation_lease(uuid, uuid) to service_role;
grant execute on function public.checkpoint_transcription_operation(uuid, uuid, text, jsonb, text, jsonb) to service_role;
grant execute on function public.release_transcription_operation_credits(uuid, uuid) to service_role;
grant execute on function public.finalize_transcription_operation(uuid, uuid) to service_role;
grant execute on function public.fail_transcription_operation(uuid, uuid, text) to service_role;
grant execute on function public.cancel_transcription_operation(uuid, uuid) to service_role;

create or replace function public.release_transcription_operation_lease(p_operation_id uuid, p_worker_token uuid, p_delay_seconds integer default 0)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.transcription_operations set status = 'queued', worker_token = null, locked_at = null, ready_at = now() + make_interval(secs => least(greatest(coalesce(p_delay_seconds,0),0),300)), updated_at = now()
  where id = p_operation_id and worker_token = p_worker_token and status in ('running', 'finalizing');
  return found;
end;
$$;
revoke all on function public.release_transcription_operation_lease(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.release_transcription_operation_lease(uuid, uuid, integer) to service_role;
notify pgrst, 'reload schema';
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

  v_active_jobs := v_active_jobs + (select count(*)::integer from public.transcription_operations
    where user_id = p_user_id and status in ('staged', 'queued', 'running', 'finalizing'));

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

  v_active_jobs := v_active_jobs + (select count(*)::integer from public.transcription_operations
    where user_id = p_user_id and status in ('staged', 'queued', 'running', 'finalizing'));

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


notify pgrst, 'reload schema';
