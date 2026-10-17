-- Batch metadata is private; existing child operations retain the credit ledger,
-- checkpoints and audio retention policy. A batch never reserves credits itself.
create table public.transcription_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  batch_key uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  requested_language text,
  initial_credits integer,
  started_at timestamptz,
  cancelled_at timestamptz,
  slot_operation_id uuid,
  slot_worker_token uuid,
  slot_locked_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, batch_key),
  check ((slot_operation_id is null and slot_worker_token is null and slot_locked_at is null)
    or (slot_operation_id is not null and slot_worker_token is not null and slot_locked_at is not null))
);
create table public.transcription_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.transcription_batches(id) on delete cascade,
  client_id uuid not null,
  item_order integer not null check (item_order between 0 and 4),
  filename text not null check (char_length(filename) between 1 and 500),
  label text not null check (char_length(label) between 1 and 80),
  operation_key uuid not null default gen_random_uuid(),
  current_operation_id uuid references public.transcription_operations(id) on delete set null,
  source_hash text check (source_hash is null or source_hash ~ '^[0-9a-f]{64}$'),
  attempt_index integer not null default 0 check (attempt_index >= 0),
  cancelled_at timestamptz,
  unique (batch_id, client_id), unique (batch_id, item_order), unique (current_operation_id)
);
create table public.transcription_batch_requests (
  batch_id uuid not null references public.transcription_batches(id) on delete cascade,
  request_id uuid not null,
  kind text not null check (kind in ('start','retry')),
  item_id uuid references public.transcription_batch_items(id) on delete cascade,
  expected_credits integer,
  created_at timestamptz not null default now(),
  primary key (batch_id, request_id)
);
alter table public.transcription_operations add column batch_id uuid references public.transcription_batches(id) on delete cascade;
alter table public.transcription_operations add column batch_item_id uuid references public.transcription_batch_items(id) on delete cascade;
alter table public.transcription_operations add constraint transcription_operation_batch_mapping check ((batch_id is null) = (batch_item_id is null));
create index transcription_operations_batch_idx on public.transcription_operations(batch_id, created_at) where batch_id is not null;
create index transcription_batches_user_created_idx on public.transcription_batches(user_id, created_at desc);
alter table public.transcription_batches enable row level security;
alter table public.transcription_batch_items enable row level security;
alter table public.transcription_batch_requests enable row level security;
revoke all on table public.transcription_batches, public.transcription_batch_items, public.transcription_batch_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.transcription_batches, public.transcription_batch_items, public.transcription_batch_requests to service_role;

create function public.transcription_batch_item_status(p_item public.transcription_batch_items, p_batch public.transcription_batches)
returns text language sql stable security invoker set search_path = '' as $$
  select case when p_item.cancelled_at is not null then 'cancelled'
    when p_item.current_operation_id is null then case when p_batch.expires_at <= now() or p_batch.cancelled_at is not null then 'cancelled' else 'awaiting_upload' end
    when o.status = 'staged' then case when jsonb_array_length(o.storage_manifest)>0 then 'ready' else 'awaiting_upload' end
    else coalesce(o.status,'awaiting_upload') end
  from (select 1) seed left join public.transcription_operations o on o.id=p_item.current_operation_id;
$$;

-- Keep the established credit allocation/refund implementation behind guarded
-- entry points. All helpers remain private to the server's service role.
alter function public.queue_transcription_operation(uuid,uuid,jsonb,integer) rename to queue_transcription_operation_internal;
alter function public.cancel_transcription_operation(uuid,uuid) rename to cancel_transcription_operation_internal;
alter function public.checkpoint_transcription_operation(uuid,uuid,text,jsonb,text,jsonb) rename to checkpoint_transcription_operation_internal;
alter function public.finalize_transcription_operation(uuid,uuid) rename to finalize_transcription_operation_internal;
alter function public.fail_transcription_operation(uuid,uuid,text) rename to fail_transcription_operation_internal;
alter function public.release_transcription_operation_lease(uuid,uuid,integer) rename to release_transcription_operation_lease_internal;
create function public.transcription_batch_is_active(p_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists(select 1 from public.transcription_batches b join public.transcription_batch_items i on i.batch_id=b.id
    where b.id=p_id and b.cancelled_at is null and public.transcription_batch_item_status(i,b) in ('awaiting_upload','ready','queued','running','finalizing'));
$$;
create function public.transcription_active_group_count(p_user_id uuid)
returns integer language sql stable security invoker set search_path = '' as $$
  select ((select count(*) from public.transcription_operations where user_id=p_user_id and batch_id is null and status in ('staged','queued','running','finalizing'))
    +(select count(*) from public.transcription_batches where user_id=p_user_id and public.transcription_batch_is_active(id)))::integer;
$$;
create function public.lock_transcription_batch(p_user_id uuid,p_batch_id uuid)
returns public.transcription_batches language plpgsql security invoker set search_path = '' as $$
declare b public.transcription_batches%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('credit-user:'||p_user_id::text,0));
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then raise exception using errcode='TB404',message='계정 정보를 찾을 수 없습니다.'; end if;
  select * into b from public.transcription_batches where id=p_batch_id and user_id=p_user_id for update;
  if not found then raise exception using errcode='TB404',message='묶음 작업을 찾을 수 없습니다.'; end if;
  perform o.id from public.transcription_operations o join public.transcription_batch_items i on i.current_operation_id=o.id
    where i.batch_id=b.id order by o.id for update of o;
  return b;
end;
$$;
create function public.create_transcription_batch(p_user_id uuid,p_batch_key uuid,p_payload_hash text,p_requested_language text,p_items jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare b public.transcription_batches%rowtype; item jsonb; index integer=0;
begin
  if p_user_id is null or p_batch_key is null or coalesce(p_payload_hash,'') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 5
    or (select count(distinct value->>'clientId') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then
    raise exception using errcode='TB400',message='묶음 파일 정보를 확인해주세요.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-user:'||p_user_id::text,0));
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then raise exception using errcode='TB404',message='계정 정보를 찾을 수 없습니다.'; end if;
  select * into b from public.transcription_batches where user_id=p_user_id and batch_key=p_batch_key for update;
  if found then
    if b.payload_hash<>p_payload_hash then raise exception using errcode='TB409',message='같은 묶음 키의 파일과 옵션은 변경할 수 없습니다.'; end if;
    return b.id;
  end if;
  if public.transcription_active_group_count(p_user_id)>=3 or exists(select 1 from public.transcription_batches where user_id=p_user_id and public.transcription_batch_is_active(id)) then
    raise exception using errcode='TB429',message='진행 중인 묶음 작업을 완료하거나 취소해주세요.';
  end if;
  insert into public.transcription_batches(user_id,batch_key,payload_hash,requested_language) values(p_user_id,p_batch_key,p_payload_hash,nullif(p_requested_language,'')) returning * into b;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'clientId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or char_length(coalesce(item->>'filename','')) not between 1 and 500 or char_length(coalesce(item->>'label','')) not between 1 and 80 then
      raise exception using errcode='TB400',message='파일 이름과 표시 이름을 확인해주세요.';
    end if;
    insert into public.transcription_batch_items(batch_id,client_id,item_order,filename,label) values(b.id,(item->>'clientId')::uuid,index,item->>'filename',item->>'label');
    index=index+1;
  end loop;
  return b.id;
end;
$$;
create function public.stage_transcription_batch_item(p_user_id uuid,p_batch_id uuid,p_item_id uuid,p_payload_hash text,p_filename text,p_content_type text,p_byte_size bigint,p_duration_seconds numeric)
returns table(operation_id uuid,status text,already_staged boolean) language plpgsql security invoker set search_path = '' as $$
declare b public.transcription_batches%rowtype; i public.transcription_batch_items%rowtype; o public.transcription_operations%rowtype;
begin
  b:=public.lock_transcription_batch(p_user_id,p_batch_id);
  if b.cancelled_at is not null or b.expires_at<=now() then raise exception using errcode='TB409',message='종료된 묶음에는 업로드할 수 없습니다.'; end if;
  if coalesce(p_payload_hash,'') !~ '^[0-9a-f]{64}$' or coalesce(p_byte_size,0) not between 1 and 157286400 or p_duration_seconds is null or p_duration_seconds<=0
    or char_length(coalesce(p_filename,'')) not between 1 and 500 then raise exception using errcode='TB400',message='파일 길이와 업로드 정보를 확인해주세요.'; end if;
  select * into i from public.transcription_batch_items where id=p_item_id and batch_id=b.id for update;
  if not found then raise exception using errcode='TB404',message='묶음 파일을 찾을 수 없습니다.'; end if;
  if i.cancelled_at is not null or (i.source_hash is not null and i.source_hash<>p_payload_hash) then raise exception using errcode='TB409',message='처음 선택한 파일과 같은 파일을 다시 선택해주세요.'; end if;
  if i.current_operation_id is not null then
    select * into o from public.transcription_operations where id=i.current_operation_id;
    if o.user_id<>p_user_id or o.batch_id<>b.id or o.batch_item_id<>i.id or o.payload_hash<>p_payload_hash or o.status in ('failed','cancelled') then
      raise exception using errcode='TB409',message='확정 실패한 파일은 재시도 버튼으로 접수해주세요.';
    end if;
    return query select o.id,o.status,jsonb_array_length(o.storage_manifest)>0; return;
  end if;
  insert into public.transcription_operations(user_id,operation_key,payload_hash,filename,content_type,byte_size,requested_language,duration_seconds,batch_id,batch_item_id,expires_at)
    values(p_user_id,i.operation_key,p_payload_hash,p_filename,p_content_type,p_byte_size,b.requested_language,p_duration_seconds,b.id,i.id,b.expires_at) returning * into o;
  update public.transcription_batch_items set current_operation_id=o.id,source_hash=coalesce(source_hash,p_payload_hash) where id=i.id;
  update public.transcription_batches set updated_at=now() where id=b.id;
  return query select o.id,o.status,false;
end;
$$;
create function public.complete_transcription_batch_upload(p_user_id uuid,p_batch_id uuid,p_item_id uuid,p_operation_id uuid,p_storage_manifest jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare b public.transcription_batches%rowtype; o public.transcription_operations%rowtype;
begin
  b:=public.lock_transcription_batch(p_user_id,p_batch_id);
  if b.cancelled_at is not null or b.expires_at<=now() then raise exception using errcode='TB409',message='종료된 묶음입니다.'; end if;
  select op.* into o from public.transcription_operations op join public.transcription_batch_items i on i.current_operation_id=op.id
    where op.id=p_operation_id and op.user_id=p_user_id and op.batch_id=b.id and op.batch_item_id=p_item_id and i.id=p_item_id and i.batch_id=b.id;
  if not found or o.status<>'staged' then raise exception using errcode='TB409',message='업로드 상태를 다시 확인해주세요.'; end if;
  if jsonb_typeof(p_storage_manifest) is distinct from 'array' or jsonb_array_length(p_storage_manifest) not between 1 and 4
    or (select coalesce(sum((value->>'bytes')::bigint),0) from jsonb_array_elements(p_storage_manifest))<>o.byte_size
    or (select count(distinct value->>'path') from jsonb_array_elements(p_storage_manifest))<>jsonb_array_length(p_storage_manifest)
    or exists(select 1 from jsonb_array_elements(p_storage_manifest) where coalesce(value->>'path','') !~ ('^'||p_user_id::text||'/'||o.id::text||'/[0-9]{4}$')
      or coalesce((value->>'bytes')::bigint,0) not between 1 and 41943040 or coalesce(value->>'sha256','') !~ '^[0-9a-f]{64}$') then
    raise exception using errcode='TB400',message='원본 저장 목록을 확인해주세요.';
  end if;
  update public.transcription_operations set storage_manifest=p_storage_manifest,updated_at=now() where id=o.id;
  update public.transcription_batches set updated_at=now() where id=b.id;
  return true;
end;
$$;

create function public.start_transcription_batch(p_user_id uuid,p_batch_id uuid,p_request_id uuid,p_expected_credits integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare b public.transcription_batches%rowtype; r public.transcription_batch_requests%rowtype;
  o public.transcription_operations%rowtype; queued record; required integer; ready_count integer;
begin
  b:=public.lock_transcription_batch(p_user_id,p_batch_id);
  select * into r from public.transcription_batch_requests where batch_id=b.id and request_id=p_request_id;
  if found then
    if r.kind<>'start' or r.expected_credits is distinct from p_expected_credits then raise exception using errcode='TB409',message='같은 요청 키의 시작 정보는 변경할 수 없습니다.'; end if;
    return false;
  end if;
  if p_request_id is null or p_expected_credits is null or p_expected_credits<1 then raise exception using errcode='TB400',message='시작 요청과 예약 시간을 확인해주세요.'; end if;
  if b.cancelled_at is not null or b.expires_at<=now() then raise exception using errcode='TB409',message='종료된 묶음입니다.'; end if;
  -- Every current mapping must be complete before any allocation is created.
  if exists(select 1 from public.transcription_batch_items i left join public.transcription_operations op on op.id=i.current_operation_id
      where i.batch_id=b.id and (public.transcription_batch_item_status(i,b) in ('awaiting_upload','queued','running','finalizing')
        or (i.current_operation_id is not null and (op.user_id is distinct from p_user_id or op.batch_id is distinct from b.id or op.batch_item_id is distinct from i.id)))) then
    raise exception using errcode='TB409',message='모든 파일의 업로드와 현재 작업 상태를 확인해주세요.';
  end if;
  select count(*),coalesce(sum(greatest(ceil(op.duration_seconds/60.0)::integer,1)),0)::integer into ready_count,required
    from public.transcription_batch_items i join public.transcription_operations op on op.id=i.current_operation_id
    where i.batch_id=b.id and public.transcription_batch_item_status(i,b)='ready';
  if ready_count=0 or required<>p_expected_credits then raise exception using errcode='TB409',message='필요 시간을 다시 확인한 뒤 시작해주세요.'; end if;
  if exists(select 1 from public.transcription_batch_items i join public.transcription_operations op on op.id=i.current_operation_id
    where i.batch_id=b.id and public.transcription_batch_item_status(i,b)='ready'
      and (op.status<>'staged' or op.duration_seconds is null or op.duration_seconds<=0 or jsonb_array_length(op.storage_manifest)<1 or op.credits_reserved<>0)) then
    raise exception using errcode='TB409',message='예약할 파일 상태가 올바르지 않습니다.';
  end if;
  for o in select op.* from public.transcription_batch_items i join public.transcription_operations op on op.id=i.current_operation_id
    where i.batch_id=b.id and public.transcription_batch_item_status(i,b)='ready' order by op.id loop
    select * into queued from public.queue_transcription_operation_internal(o.id,p_user_id,o.storage_manifest,greatest(ceil(o.duration_seconds/60.0)::integer,1));
    if not found then raise exception using errcode='TB402',message='묶음 전체를 예약할 변환 시간이 부족합니다.'; end if;
    if queued.operation_id is distinct from o.id or queued.status is distinct from 'queued' or queued.already_queued then
      raise exception using errcode='TB409',message='예약할 파일 상태가 변경되었습니다.';
    end if;
  end loop;
  insert into public.transcription_batch_requests(batch_id,request_id,kind,expected_credits) values(b.id,p_request_id,'start',required);
  update public.transcription_batches set started_at=coalesce(started_at,now()),initial_credits=coalesce(initial_credits,required),updated_at=now() where id=b.id;
  return true;
end;
$$;

create function public.retry_transcription_batch_item(p_user_id uuid,p_batch_id uuid,p_item_id uuid,p_request_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare b public.transcription_batches%rowtype; i public.transcription_batch_items%rowtype; r public.transcription_batch_requests%rowtype;
begin
  b:=public.lock_transcription_batch(p_user_id,p_batch_id);
  if p_request_id is null then raise exception using errcode='TB400',message='재시도 요청 키가 필요합니다.'; end if;
  select * into r from public.transcription_batch_requests where batch_id=b.id and request_id=p_request_id;
  if found then
    if r.kind<>'retry' or r.item_id is distinct from p_item_id then raise exception using errcode='TB409',message='같은 요청 키의 재시도 파일은 변경할 수 없습니다.'; end if;
    return false;
  end if;
  if b.cancelled_at is not null or b.expires_at<=now() then raise exception using errcode='TB409',message='종료된 묶음입니다.'; end if;
  select * into i from public.transcription_batch_items where id=p_item_id and batch_id=b.id for update;
  if not found then raise exception using errcode='TB404',message='묶음 파일을 찾을 수 없습니다.'; end if;
  if public.transcription_batch_item_status(i,b)<>'failed' or exists(select 1 from public.transcription_batch_items j where j.batch_id=b.id
    and public.transcription_batch_item_status(j,b) in ('queued','running','finalizing')) then
    raise exception using errcode='TB409',message='확정 실패한 파일만 진행 작업이 없을 때 재시도할 수 있습니다.';
  end if;
  if not public.transcription_batch_is_active(b.id) and (public.transcription_active_group_count(p_user_id)>=3
    or exists(select 1 from public.transcription_batches other where other.user_id=p_user_id and other.id<>b.id and public.transcription_batch_is_active(other.id))) then
    raise exception using errcode='TB429',message='다른 진행 작업을 완료하거나 취소해주세요.';
  end if;
  insert into public.transcription_batch_requests(batch_id,request_id,kind,item_id) values(b.id,p_request_id,'retry',i.id);
  update public.transcription_batch_items set current_operation_id=null,operation_key=gen_random_uuid(),attempt_index=attempt_index+1 where id=i.id;
  update public.transcription_batches set updated_at=now() where id=b.id;
  return true;
end;
$$;

create function public.cancel_transcription_batch(p_user_id uuid,p_batch_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare b public.transcription_batches%rowtype; o public.transcription_operations%rowtype;
begin
  b:=public.lock_transcription_batch(p_user_id,p_batch_id);
  if b.cancelled_at is not null then return false; end if;
  for o in select op.* from public.transcription_operations op join public.transcription_batch_items i on i.current_operation_id=op.id
    where i.batch_id=b.id and op.status in ('staged','queued','running','finalizing') order by op.id loop
    perform public.cancel_transcription_operation_internal(o.id,p_user_id);
  end loop;
  update public.transcription_batch_items set cancelled_at=now() where batch_id=b.id and current_operation_id is null;
  update public.transcription_batches set cancelled_at=now(),slot_operation_id=null,slot_worker_token=null,slot_locked_at=null,updated_at=now() where id=b.id;
  return true;
end;
$$;

-- Pending uploads/queued files expire at the existing 24-hour deadline. Already
-- running/finalizing work keeps its lease and may finish; no new file starts.
create function public.expire_transcription_batches()
returns integer language plpgsql security invoker set search_path = '' as $$
declare candidate record; b public.transcription_batches%rowtype; o public.transcription_operations%rowtype; changed integer=0;
begin
  for candidate in select id,user_id from public.transcription_batches where expires_at<=now() and cancelled_at is null order by created_at limit 20 loop
    b:=public.lock_transcription_batch(candidate.user_id,candidate.id);
    for o in select op.* from public.transcription_operations op join public.transcription_batch_items i on i.current_operation_id=op.id
      where i.batch_id=b.id and op.status in ('staged','queued') order by op.id loop
      perform public.cancel_transcription_operation_internal(o.id,b.user_id);
    end loop;
    update public.transcription_batch_items set cancelled_at=coalesce(cancelled_at,now()) where batch_id=b.id and current_operation_id is null;
    if not exists(select 1 from public.transcription_operations where batch_id=b.id and status in ('running','finalizing')) then
      update public.transcription_batches set cancelled_at=now(),slot_operation_id=null,slot_worker_token=null,slot_locked_at=null,updated_at=now() where id=b.id;
    end if;
    changed=changed+1;
  end loop;
  return changed;
end;
$$;

create or replace function public.create_transcription_operation(
  p_user_id uuid,p_operation_key uuid,p_payload_hash text,p_filename text,p_content_type text,p_byte_size bigint,p_requested_language text,p_duration_seconds numeric
) returns table(operation_id uuid,status text,existing boolean,credits_remaining integer)
language plpgsql security invoker set search_path = '' as $$
declare v public.transcription_operations%rowtype; balance integer;
begin
  if p_user_id is null or p_operation_key is null or coalesce(p_payload_hash,'') !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(p_filename,'')) not between 1 and 500 or coalesce(p_byte_size,0) not between 1 and 157286400 then
    raise exception using errcode='TO001',message='변환 작업 정보가 올바르지 않습니다.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-user:'||p_user_id::text,0));
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then raise exception using errcode='TO404',message='계정 정보를 찾을 수 없습니다.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('transcription-operation:'||p_user_id::text||':'||p_operation_key::text,0));
  select * into v from public.transcription_operations where user_id=p_user_id and operation_key=p_operation_key for update;
  if found then
    if v.batch_id is not null then raise exception using errcode='TB409',message='묶음 파일은 묶음 작업에서 처리해주세요.'; end if;
    if v.payload_hash<>p_payload_hash then raise exception using errcode='TO409',message='같은 작업 키에 다른 파일이나 옵션을 사용할 수 없습니다.'; end if;
    select credits into balance from public.profiles where id=p_user_id;
    return query select v.id,v.status,true,coalesce(balance,0); return;
  end if;
  if public.transcription_active_group_count(p_user_id)>=3 then raise exception using errcode='TO429',message='진행 중인 작업을 완료하거나 취소한 뒤 새 변환을 시작해주세요.'; end if;
  insert into public.transcription_operations(user_id,operation_key,payload_hash,filename,content_type,byte_size,requested_language,duration_seconds)
    values(p_user_id,p_operation_key,p_payload_hash,p_filename,nullif(p_content_type,''),p_byte_size,nullif(p_requested_language,''),p_duration_seconds) returning * into v;
  select credits into balance from public.profiles where id=p_user_id;
  return query select v.id,v.status,false,coalesce(balance,0);
end;
$$;
create function public.queue_transcription_operation(p_operation_id uuid,p_user_id uuid,p_storage_manifest jsonb,p_credits integer)
returns table(operation_id uuid,status text,credits_remaining integer,already_queued boolean)
language plpgsql security invoker set search_path = '' as $$
begin
  if exists(select 1 from public.transcription_operations where id=p_operation_id and user_id=p_user_id and batch_id is not null) then
    raise exception using errcode='TB409',message='묶음 전체를 확인한 뒤 시작해주세요.';
  end if;
  return query select * from public.queue_transcription_operation_internal(p_operation_id,p_user_id,p_storage_manifest,p_credits);
end;
$$;
create function public.cancel_transcription_operation(p_operation_id uuid,p_user_id uuid)
returns table(updated boolean,credits_remaining integer,credits_restored integer)
language plpgsql security invoker set search_path = '' as $$
begin
  if exists(select 1 from public.transcription_operations where id=p_operation_id and user_id=p_user_id and batch_id is not null) then
    raise exception using errcode='TB409',message='묶음 작업에서 취소해주세요.';
  end if;
  return query select * from public.cancel_transcription_operation_internal(p_operation_id,p_user_id);
end;
$$;

create or replace function public.claim_transcription_operation(p_worker_token uuid)
returns setof public.transcription_operations language plpgsql security invoker set search_path = '' as $$
declare candidate record; o public.transcription_operations%rowtype; b public.transcription_batches%rowtype;
begin
  if p_worker_token is null then raise exception using errcode='TO001',message='작업자 식별값이 필요합니다.'; end if;
  for candidate in select id,user_id,batch_id from public.transcription_operations
    where (status='queued' and ready_at<=now()) or (status in ('running','finalizing') and locked_at<now()-interval '10 minutes')
    order by created_at,id limit 100 loop
    -- Acquire the same user/profile/parent/child lock order as reservations.
    if not pg_try_advisory_xact_lock(hashtextextended('credit-user:'||candidate.user_id::text,0)) then continue; end if;
    perform 1 from public.profiles where id=candidate.user_id for update skip locked;
    if not found then continue; end if;
    if candidate.batch_id is not null then
      b:=public.lock_transcription_batch(candidate.user_id,candidate.batch_id);
      if b.cancelled_at is not null then continue; end if;
      if b.slot_operation_id is not null and exists(select 1 from public.transcription_operations op where op.id=b.slot_operation_id and op.status in ('running','finalizing')) then
        if b.slot_locked_at>=now()-interval '10 minutes' or b.slot_operation_id<>candidate.id then continue; end if;
      end if;
      if exists(select 1 from public.transcription_operations op where op.batch_id=b.id and op.id<>candidate.id and op.status in ('running','finalizing')) then continue; end if;
    end if;
    select * into o from public.transcription_operations where id=candidate.id for update skip locked;
    if not found or not ((o.status='queued' and o.ready_at<=now()) or (o.status in ('running','finalizing') and o.locked_at<now()-interval '10 minutes')) then continue; end if;
    if o.batch_id is not null then
      if o.status='queued' and b.expires_at<=now() then continue; end if;
      if not exists(select 1 from public.transcription_batch_items i where i.id=o.batch_item_id and i.batch_id=b.id and i.current_operation_id=o.id and i.cancelled_at is null) then continue; end if;
      update public.transcription_batches set slot_operation_id=o.id,slot_worker_token=p_worker_token,slot_locked_at=now(),updated_at=now() where id=b.id;
    end if;
    return query update public.transcription_operations op set status=case when op.checkpoint_segments is null then 'running' else 'finalizing' end,
      worker_token=p_worker_token,locked_at=now(),started_at=coalesce(op.started_at,now()),attempt_count=op.attempt_count+1,error_message=null,updated_at=now()
      where op.id=o.id returning op.*;
    return;
  end loop;
end;
$$;

-- A stale worker must not checkpoint, settle credits, or release a newer slot.
create function public.lock_transcription_batch_operation(p_operation_id uuid,p_worker_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare o public.transcription_operations%rowtype; b public.transcription_batches%rowtype;
begin
  select * into o from public.transcription_operations where id=p_operation_id;
  if not found then return false; end if;
  if o.batch_id is null then return true; end if;
  b:=public.lock_transcription_batch(o.user_id,o.batch_id);
  select * into o from public.transcription_operations where id=p_operation_id;
  return b.cancelled_at is null and b.slot_operation_id=o.id and b.slot_worker_token=p_worker_token
    and b.slot_locked_at>=now()-interval '10 minutes' and o.worker_token=p_worker_token
    and o.locked_at>=now()-interval '10 minutes' and o.status in ('running','finalizing')
    and exists(select 1 from public.transcription_batch_items i where i.id=o.batch_item_id and i.batch_id=b.id and i.current_operation_id=o.id and i.cancelled_at is null);
end;
$$;
create function public.clear_transcription_batch_slot(p_operation_id uuid,p_worker_token uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.transcription_batches set slot_operation_id=null,slot_worker_token=null,slot_locked_at=null,updated_at=now()
    where slot_operation_id=p_operation_id and slot_worker_token=p_worker_token;
$$;
create or replace function public.renew_transcription_operation_lease(p_operation_id uuid,p_worker_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if not public.lock_transcription_batch_operation(p_operation_id,p_worker_token) then return false; end if;
  update public.transcription_operations set locked_at=now(),updated_at=now() where id=p_operation_id and status in ('running','finalizing') and worker_token=p_worker_token;
  if not found then return false; end if;
  update public.transcription_batches set slot_locked_at=now(),updated_at=now() where slot_operation_id=p_operation_id and slot_worker_token=p_worker_token;
  return true;
end;
$$;
create function public.checkpoint_transcription_operation(p_operation_id uuid,p_worker_token uuid,p_text text,p_segments jsonb,p_language text,p_timings jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed boolean;
begin
  if not public.lock_transcription_batch_operation(p_operation_id,p_worker_token) then return false; end if;
  changed:=public.checkpoint_transcription_operation_internal(p_operation_id,p_worker_token,p_text,p_segments,p_language,p_timings);
  if changed then update public.transcription_batches set slot_locked_at=now(),updated_at=now() where slot_operation_id=p_operation_id and slot_worker_token=p_worker_token; end if;
  return changed;
end;
$$;
create function public.finalize_transcription_operation(p_operation_id uuid,p_worker_token uuid)
returns table(completed boolean,credits_remaining integer) language plpgsql security invoker set search_path = '' as $$
declare result record;
begin
  if not public.lock_transcription_batch_operation(p_operation_id,p_worker_token) then return query select false,null::integer; return; end if;
  select * into result from public.finalize_transcription_operation_internal(p_operation_id,p_worker_token);
  if result.completed then perform public.clear_transcription_batch_slot(p_operation_id,p_worker_token); end if;
  return query select result.completed,result.credits_remaining;
end;
$$;
create function public.fail_transcription_operation(p_operation_id uuid,p_worker_token uuid,p_error_message text)
returns table(updated boolean,credits_remaining integer,credits_restored integer) language plpgsql security invoker set search_path = '' as $$
declare result record;
begin
  if not public.lock_transcription_batch_operation(p_operation_id,p_worker_token) then return query select false,null::integer,null::integer; return; end if;
  select * into result from public.fail_transcription_operation_internal(p_operation_id,p_worker_token,p_error_message);
  if result.updated then perform public.clear_transcription_batch_slot(p_operation_id,p_worker_token); end if;
  return query select result.updated,result.credits_remaining,result.credits_restored;
end;
$$;
create function public.release_transcription_operation_lease(p_operation_id uuid,p_worker_token uuid,p_delay_seconds integer default 0)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed boolean;
begin
  if not public.lock_transcription_batch_operation(p_operation_id,p_worker_token) then return false; end if;
  changed:=public.release_transcription_operation_lease_internal(p_operation_id,p_worker_token,p_delay_seconds);
  if changed then perform public.clear_transcription_batch_slot(p_operation_id,p_worker_token); end if;
  return changed;
end;
$$;

create function public.get_transcription_batch(p_user_id uuid,p_batch_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with parent as (select * from public.transcription_batches where id=p_batch_id and user_id=p_user_id),
  items as (select i.*,public.transcription_batch_item_status(i,b) item_status,op.duration_seconds,op.credits_reserved,op.status operation_status,
    op.transcription_log_id,op.result_segments,op.error_message,op.attempt_count
    from parent b join public.transcription_batch_items i on i.batch_id=b.id left join public.transcription_operations op on op.id=i.current_operation_id),
  totals as (select count(*) filter(where item_status='ready') ready_count,
    coalesce(sum(greatest(ceil(duration_seconds/60.0)::integer,1)) filter(where item_status='ready'),0) next_credits,
    count(*) filter(where item_status='completed') completed_count,
    count(*) filter(where item_status in ('awaiting_upload','queued','running','finalizing')) blockers,
    bool_or(item_status='running' or item_status='finalizing') running,
    bool_or(item_status='queued') queued,bool_or(item_status='awaiting_upload') uploading,bool_or(item_status='failed') failed
    from items),
  accounting as (select coalesce(sum(credits_reserved) filter(where status='completed'),0) used,
    coalesce(sum(credits_reserved) filter(where status in ('queued','running','finalizing')),0) reserved,
    coalesce(sum(credits_restored),0) restored from public.transcription_operations where batch_id=p_batch_id and user_id=p_user_id)
  select jsonb_build_object('id',b.id,'batchKey',b.batch_key,'language',b.requested_language,
    'status',case when t.running then 'running' when t.queued then 'queued' when t.uploading then 'uploading' when t.ready_count>0 then 'ready'
      when t.completed_count=(select count(*) from items) then 'completed' when t.completed_count>0 then 'partial_failed' when t.failed then 'failed' else 'cancelled' end,
    'totalCredits',t.next_credits,'initialCredits',b.initial_credits,'creditsRemaining',(select credits from public.profiles where id=b.user_id),
    'creditsUsed',a.used,'creditsReserved',a.reserved,'creditsRestored',a.restored,
    'canStart',t.ready_count>0 and t.blockers=0 and b.cancelled_at is null and b.expires_at>now(),
    'createdAt',b.created_at,'expiresAt',b.expires_at,
    'items',(select jsonb_agg(jsonb_build_object('id',i.id,'clientId',i.client_id,'order',i.item_order,'filename',i.filename,'label',i.label,
      'status',i.item_status,'durationSeconds',i.duration_seconds,'creditsNeeded',case when i.duration_seconds>0 then greatest(ceil(i.duration_seconds/60.0)::integer,1) else null end,
      'operationId',i.current_operation_id,'transcriptionLogId',i.transcription_log_id,'attemptIndex',i.attempt_index,
      'recognitionStatus',case when i.item_status='completed' then case when jsonb_array_length(i.result_segments)=0 then 'no_speech' else 'speech' end else null end,
      'needsReview',i.item_status='completed' and jsonb_array_length(i.result_segments)=0,'error',i.error_message) order by i.item_order) from items i))
  from parent b cross join totals t cross join accounting a;
$$;
create function public.list_transcription_batches(p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(public.get_transcription_batch(p_user_id,id) order by created_at desc),'[]'::jsonb)
    from (select id,created_at from public.transcription_batches where user_id=p_user_id order by created_at desc limit 20) recent;
$$;

-- Explicitly fence every new/replaced RPC (including renamed ledger helpers).
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like '%transcription_batch%' or p.proname='transcription_active_group_count'
      or p.proname in ('create_transcription_operation','queue_transcription_operation','queue_transcription_operation_internal',
       'claim_transcription_operation','renew_transcription_operation_lease','checkpoint_transcription_operation','checkpoint_transcription_operation_internal',
       'finalize_transcription_operation','finalize_transcription_operation_internal','fail_transcription_operation','fail_transcription_operation_internal',
       'cancel_transcription_operation','cancel_transcription_operation_internal','release_transcription_operation_lease','release_transcription_operation_lease_internal')) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- Accepted upload drafts also block account deletion; ledger/deletion behavior is unchanged.
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

  v_active_jobs := v_active_jobs + public.transcription_active_group_count(p_user_id);

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

  v_active_jobs := v_active_jobs + public.transcription_active_group_count(p_user_id);

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
