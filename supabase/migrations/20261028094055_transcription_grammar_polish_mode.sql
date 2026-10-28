alter table public.transcription_operations
  add column polish_mode text not null default 'preserve'
  check (polish_mode in ('preserve', 'grammar'));
alter table public.transcription_batches
  add column polish_mode text not null default 'preserve'
  check (polish_mode in ('preserve', 'grammar'));
alter table public.transcription_jobs
  add column polish_mode text not null default 'preserve'
  check (polish_mode in ('preserve', 'grammar'));

create function public.bind_transcription_operation_polish_mode()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.batch_id is not null then
    select polish_mode into new.polish_mode from public.transcription_batches
      where id=new.batch_id and user_id=new.user_id;
    if not found then raise exception using errcode='TB404',message='묶음 작업을 찾을 수 없습니다.'; end if;
  end if;
  return new;
end;
$$;
create trigger transcription_operation_polish_mode_parent
before insert or update of batch_id on public.transcription_operations
for each row execute function public.bind_transcription_operation_polish_mode();
revoke all on function public.bind_transcription_operation_polish_mode() from public,anon,authenticated;

-- Keep the established 8-argument RPC intact for old clients.
create function public.create_transcription_operation(
  p_user_id uuid,p_operation_key uuid,p_payload_hash text,p_filename text,p_content_type text,
  p_byte_size bigint,p_requested_language text,p_duration_seconds numeric,p_polish_mode text
) returns table(operation_id uuid,status text,existing boolean,credits_remaining integer)
language plpgsql security invoker set search_path = '' as $$
declare v public.transcription_operations%rowtype; balance integer;
begin
  if p_polish_mode is null or p_polish_mode not in ('preserve','grammar') then raise exception using errcode='TO001',message='변환 옵션을 확인해주세요.'; end if;
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
    if v.payload_hash<>p_payload_hash or v.polish_mode<>p_polish_mode then raise exception using errcode='TO409',message='같은 작업 키에 다른 파일이나 옵션을 사용할 수 없습니다.'; end if;
    select credits into balance from public.profiles where id=p_user_id;
    return query select v.id,v.status,true,coalesce(balance,0); return;
  end if;
  if public.transcription_active_group_count(p_user_id)>=3 then raise exception using errcode='TO429',message='진행 중인 작업을 완료하거나 취소한 뒤 새 변환을 시작해주세요.'; end if;
  insert into public.transcription_operations(user_id,operation_key,payload_hash,filename,content_type,byte_size,requested_language,duration_seconds,polish_mode)
    values(p_user_id,p_operation_key,p_payload_hash,p_filename,nullif(p_content_type,''),p_byte_size,nullif(p_requested_language,''),p_duration_seconds,p_polish_mode) returning * into v;
  select credits into balance from public.profiles where id=p_user_id;
  return query select v.id,v.status,false,coalesce(balance,0);
end;
$$;
revoke all on function public.create_transcription_operation(uuid,uuid,text,text,text,bigint,text,numeric,text) from public,anon,authenticated;
grant execute on function public.create_transcription_operation(uuid,uuid,text,text,text,bigint,text,numeric,text) to service_role;

-- Keep the established 5-argument RPC intact for old clients.
create function public.create_transcription_batch(p_user_id uuid,p_batch_key uuid,p_payload_hash text,p_requested_language text,p_items jsonb,p_polish_mode text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; b public.transcription_batches%rowtype;
begin
  if p_polish_mode is null or p_polish_mode not in ('preserve','grammar') then raise exception using errcode='TB400',message='변환 옵션을 확인해주세요.'; end if;
  if p_user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('credit-user:'||p_user_id::text,0));
    perform 1 from public.profiles where id=p_user_id for update;
    if not found then raise exception using errcode='TB404',message='계정 정보를 찾을 수 없습니다.'; end if;
    select * into b from public.transcription_batches where user_id=p_user_id and batch_key=p_batch_key for update;
    if found then
      if b.payload_hash<>p_payload_hash or b.polish_mode<>p_polish_mode then raise exception using errcode='TB409',message='같은 묶음 키의 파일과 옵션은 변경할 수 없습니다.'; end if;
      return b.id;
    end if;
  end if;
  v_id:=public.create_transcription_batch(p_user_id,p_batch_key,p_payload_hash,p_requested_language,p_items);
  update public.transcription_batches set polish_mode=p_polish_mode
    where id=v_id and user_id=p_user_id and payload_hash=p_payload_hash and polish_mode='preserve';
  if not found then raise exception using errcode='TB409',message='같은 묶음 키의 파일과 옵션은 변경할 수 없습니다.'; end if;
  return v_id;
end;
$$;
revoke all on function public.create_transcription_batch(uuid,uuid,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_transcription_batch(uuid,uuid,text,text,jsonb,text) to service_role;

create or replace function public.stage_transcription_batch_item(p_user_id uuid,p_batch_id uuid,p_item_id uuid,p_payload_hash text,p_filename text,p_content_type text,p_byte_size bigint,p_duration_seconds numeric)
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
    if o.user_id<>p_user_id or o.batch_id<>b.id or o.batch_item_id<>i.id or o.payload_hash<>p_payload_hash or o.polish_mode<>b.polish_mode or o.status in ('failed','cancelled') then
      raise exception using errcode='TB409',message='확정 실패한 파일은 재시도 버튼으로 접수해주세요.';
    end if;
    return query select o.id,o.status,jsonb_array_length(o.storage_manifest)>0; return;
  end if;
  insert into public.transcription_operations(user_id,operation_key,payload_hash,filename,content_type,byte_size,requested_language,duration_seconds,batch_id,batch_item_id,expires_at,polish_mode)
    values(p_user_id,i.operation_key,p_payload_hash,p_filename,p_content_type,p_byte_size,b.requested_language,p_duration_seconds,b.id,i.id,b.expires_at,b.polish_mode) returning * into o;
  update public.transcription_batch_items set current_operation_id=o.id,source_hash=coalesce(source_hash,p_payload_hash) where id=i.id;
  update public.transcription_batches set updated_at=now() where id=b.id;
  return query select o.id,o.status,false;
end;
$$;

create or replace function public.get_transcription_batch(p_user_id uuid,p_batch_id uuid)
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
  select jsonb_build_object('id',b.id,'batchKey',b.batch_key,'language',b.requested_language,'polishMode',b.polish_mode,
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

create function public.enqueue_diarization_job(p_user_id uuid,p_filename text,p_storage_path text,p_requested_language text,p_duration_seconds numeric,p_credits integer,p_polish_mode text)
returns table(job_id uuid,credits_remaining integer) language plpgsql security invoker set search_path = '' as $$
declare v record;
begin
  if p_polish_mode is null or p_polish_mode not in ('preserve','grammar') then raise exception using errcode='22023',message='변환 옵션을 확인해주세요.'; end if;
  select * into v from public.enqueue_diarization_job(p_user_id,p_filename,p_storage_path,p_requested_language,p_duration_seconds,p_credits);
  if not found then return; end if;
  if v.job_id is not null then update public.transcription_jobs set polish_mode=p_polish_mode where id=v.job_id; end if;
  return query select v.job_id,v.credits_remaining;
end;
$$;
revoke all on function public.enqueue_diarization_job(uuid,text,text,text,numeric,integer,text) from public,anon,authenticated;
grant execute on function public.enqueue_diarization_job(uuid,text,text,text,numeric,integer,text) to service_role;

notify pgrst, 'reload schema';
