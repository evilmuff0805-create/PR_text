-- Marketing contacts are independent from app profiles/credits. Only server-side
-- service_role can access these tables and SECURITY INVOKER RPCs.
create table public.outreach_contacts (
  id uuid primary key default gen_random_uuid(),
  channel_id text,
  channel_name text check (channel_name is null or (char_length(channel_name) between 1 and 200 and channel_name !~ '[[:cntrl:]]')),
  channel_url text not null default '',
  category text not null default 'general' check (category in ('web_entertainment','actor','general')),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  subscriber_count bigint check (subscriber_count is null or subscriber_count >= 0),
  email text not null unique check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and email ~ '^[^[:space:]<>;,]+@[^[:space:]<>;,]+\.[^[:space:]<>;,]+$'),
  public_email_source text not null check (char_length(public_email_source) between 1 and 1500),
  consent_status text not null default 'unknown' check (consent_status in ('unknown','granted','revoked')),
  consent_evidence text not null default '' check (char_length(consent_evidence) <= 2000),
  consent_granted_at timestamptz,
  korea_verified boolean not null default false,
  korea_evidence text not null default '' check (char_length(korea_evidence) <= 2000),
  channel_checked_at timestamptz,
  metadata_source text not null default 'manual' check (metadata_source in ('manual','youtube_api')),
  metadata_expired_at timestamptz,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (consent_status <> 'granted' or (char_length(consent_evidence) >= 10 and consent_granted_at is not null)),
  check (country <> '' or not korea_verified or char_length(korea_evidence) > 0)
);

create table public.outreach_suppressions (
  email text primary key,
  reason text not null default 'recipient_unsubscribed',
  created_at timestamptz not null default now()
);

create table public.outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  subject text not null check (char_length(subject) between 1 and 180 and subject !~ '[[:cntrl:]]' and left(subject,4) = '(광고)'),
  body text not null check (char_length(body) between 1 and 12000),
  contact_ids uuid[] not null check (cardinality(contact_ids) between 1 and 200),
  status text not null default 'draft' check (status in ('draft','queued','running','paused','completed')),
  revision integer not null default 1 check (revision > 0),
  preview_fingerprint text,
  queue_request_id uuid unique,
  scheduled_at timestamptz,
  queued_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.outreach_campaigns(id) on delete restrict,
  contact_id uuid references public.outreach_contacts(id) on delete set null,
  kind text not null default 'campaign' check (kind in ('campaign','test')),
  email text not null,
  channel_name text,
  subject text check (subject is null or (char_length(subject) between 1 and 400 and subject !~ '[[:cntrl:]]')),
  body text check (body is null or char_length(body) between 1 and 30000),
  metadata_source text not null default 'manual' check (metadata_source in ('manual','youtube_api')),
  channel_checked_at timestamptz,
  metadata_expired_at timestamptz,
  status text not null default 'pending' check (status in ('pending','claimed','sending','sent','failed','uncertain','skipped')),
  worker_token uuid,
  lease_expires_at timestamptz,
  unsubscribe_token_hash text unique check (unsubscribe_token_hash is null or unsubscribe_token_hash ~ '^[0-9a-f]{64}$'),
  error_code text,
  smtp_message_id text,
  started_at timestamptz,
  sent_at timestamptz,
  finished_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, email),
  check ((kind = 'campaign' and campaign_id is not null) or (kind = 'test' and campaign_id is null and email = 'codemeet@naver.com'))
);
create index outreach_messages_claim_idx on public.outreach_messages(created_at) where status = 'pending';
create index outreach_messages_recent_email_idx on public.outreach_messages(email, finished_at desc) where status in ('sent','uncertain');
create index outreach_messages_campaign_idx on public.outreach_messages(campaign_id,created_at);
create index outreach_contacts_api_expiry_idx on public.outreach_contacts(channel_checked_at) where metadata_source = 'youtube_api';

-- A shared gate enforces sequential sending across every application instance,
-- not merely one worker per process. Limits count attempts, including uncertain sends.
create table public.outreach_dispatch_state (
  singleton boolean primary key default true check (singleton),
  active_message_id uuid references public.outreach_messages(id),
  active_worker_token uuid,
  lease_expires_at timestamptz,
  next_allowed_at timestamptz not null default now(),
  quota_day date not null default ((now() at time zone 'Asia/Seoul')::date),
  daily_attempts integer not null default 0 check (daily_attempts >= 0)
);
insert into public.outreach_dispatch_state(singleton) values(true);

alter table public.outreach_contacts enable row level security;
alter table public.outreach_suppressions enable row level security;
alter table public.outreach_campaigns enable row level security;
alter table public.outreach_messages enable row level security;
alter table public.outreach_dispatch_state enable row level security;
revoke all on table public.outreach_contacts,public.outreach_suppressions,public.outreach_campaigns,public.outreach_messages,public.outreach_dispatch_state from public,anon,authenticated;
grant select,insert,update,delete on table public.outreach_contacts,public.outreach_suppressions,public.outreach_campaigns,public.outreach_messages,public.outreach_dispatch_state to service_role;

create function public.outreach_database_status() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('schemaVersion',1,'dailyAttempts',daily_attempts,'quotaDay',quota_day,'nextAllowedAt',next_allowed_at)
  from public.outreach_dispatch_state where singleton;
$$;

create function public.outreach_save_contacts(p_contacts jsonb,p_actor_id uuid,p_existing_id uuid default null)
returns setof public.outreach_contacts language plpgsql security invoker set search_path = '' as $$
declare item jsonb; existing public.outreach_contacts%rowtype; saved public.outreach_contacts%rowtype;
begin
  if p_actor_id is null or jsonb_typeof(p_contacts) <> 'array' or jsonb_array_length(p_contacts) not between 1 and 200
    or (p_existing_id is not null and jsonb_array_length(p_contacts) <> 1) then
    raise exception using errcode='OM001',message='연락처 입력값을 확인해주세요.';
  end if;
  perform 1 from public.outreach_dispatch_state where singleton for update;
  if p_existing_id is not null then
    select * into existing from public.outreach_contacts where id=p_existing_id for update;
    if not found then raise exception using errcode='OM404',message='연락처를 찾을 수 없습니다.'; end if;
  end if;
  for item in select value from jsonb_array_elements(p_contacts) loop
    if jsonb_typeof(item) <> 'object' or (coalesce(item->>'channelName','') = '' and not (p_existing_id is not null and existing.metadata_expired_at is not null
      and jsonb_typeof(item->'channelName')='null' and item->>'consentStatus' in ('unknown','revoked')))
      or coalesce(item->>'publicEmailSource','') !~ '^https?://'
      or (item->>'metadataSource'='youtube_api' and nullif(item->>'channelCheckedAt','') is null and not (p_existing_id is not null and existing.metadata_expired_at is not null))
      or (item->>'consentStatus'='granted' and (
        char_length(coalesce(item->>'consentEvidence','')) < 10 or item->>'consentEvidence'=item->>'publicEmailSource'
        or coalesce(item->>'consentEvidence','') ~ '^https?://[^[:space:]]+$'
        or nullif(item->>'consentGrantedAt','') is null or nullif(item->>'consentGrantedAt','')::timestamptz>now())) then
      raise exception using errcode='OM001',message='연락처와 별도 수신동의 근거를 확인해주세요.';
    end if;
    if p_existing_id is not null and ((existing.metadata_source='youtube_api' and item->>'metadataSource' is distinct from 'youtube_api') or item->>'email' is distinct from existing.email) then
      raise exception using errcode='OM409',message='등록된 출처와 이메일은 임의로 변경할 수 없습니다.';
    end if;
    if p_existing_id is null then
      insert into public.outreach_contacts(channel_id,channel_name,channel_url,category,country,subscriber_count,email,public_email_source,
        consent_status,consent_evidence,consent_granted_at,korea_verified,korea_evidence,channel_checked_at,metadata_source,created_by,updated_by)
      values(nullif(item->>'channelId',''),item->>'channelName',coalesce(item->>'channelUrl',''),item->>'category',coalesce(item->>'country',''),
        (item->>'subscriberCount')::bigint,item->>'email',item->>'publicEmailSource',item->>'consentStatus',coalesce(item->>'consentEvidence',''),
        nullif(item->>'consentGrantedAt','')::timestamptz,(item->>'koreaVerified')::boolean,coalesce(item->>'koreaEvidence',''),
        nullif(item->>'channelCheckedAt','')::timestamptz,item->>'metadataSource',p_actor_id,p_actor_id) returning * into saved;
    else
      update public.outreach_contacts set channel_id=nullif(item->>'channelId',''),channel_name=item->>'channelName',channel_url=coalesce(item->>'channelUrl',''),
        category=item->>'category',country=coalesce(item->>'country',''),subscriber_count=(item->>'subscriberCount')::bigint,
        public_email_source=item->>'publicEmailSource',consent_status=item->>'consentStatus',consent_evidence=coalesce(item->>'consentEvidence',''),
        consent_granted_at=nullif(item->>'consentGrantedAt','')::timestamptz,korea_verified=(item->>'koreaVerified')::boolean,korea_evidence=coalesce(item->>'koreaEvidence',''),
        channel_checked_at=nullif(item->>'channelCheckedAt','')::timestamptz,metadata_source=item->>'metadataSource',
        metadata_expired_at=case when item->>'channelName' is null then existing.metadata_expired_at else null end,updated_by=p_actor_id,updated_at=now()
      where id=p_existing_id returning * into saved;
    end if;
    return next saved;
  end loop;
end;
$$;

create function public.outreach_create_campaign(p_campaign jsonb,p_actor_id uuid)
returns public.outreach_campaigns language plpgsql security invoker set search_path = '' as $$
declare ids uuid[]; saved public.outreach_campaigns%rowtype;
begin
  if p_actor_id is null or jsonb_typeof(p_campaign->'contactIds') <> 'array' or jsonb_array_length(p_campaign->'contactIds') not between 1 and 200 then
    raise exception using errcode='OM001',message='캠페인 입력값을 확인해주세요.';
  end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_campaign->'contactIds');
  if cardinality(ids) <> (select count(distinct i) from unnest(ids) i)
    or cardinality(ids) <> (select count(*) from public.outreach_contacts where id=any(ids)) then
    raise exception using errcode='OM001',message='캠페인 연락처를 확인해주세요.';
  end if;
  insert into public.outreach_campaigns(name,subject,body,contact_ids,created_by)
  values(p_campaign->>'name',p_campaign->>'subject',p_campaign->>'body',ids,p_actor_id) returning * into saved;
  return saved;
end;
$$;

create function public.outreach_contact_block_reason(p_contact_id uuid,p_email text default null,p_message_id uuid default null)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare c public.outreach_contacts%rowtype;
begin
  select * into c from public.outreach_contacts where id=p_contact_id;
  if not found then return 'contact_missing'; end if;
  if p_email is not null and c.email <> p_email then return 'email_changed'; end if;
  if exists(select 1 from public.outreach_suppressions where email=c.email) then return 'unsubscribed'; end if;
  if c.consent_status <> 'granted' or char_length(c.consent_evidence) < 10 or c.consent_granted_at is null or c.consent_granted_at>now() then return 'consent_required'; end if;
  if c.country <> '' and c.country <> 'KR' then return 'foreign_channel'; end if;
  if c.country <> 'KR' and (not c.korea_verified or c.korea_evidence='') then return 'korea_unverified'; end if;
  if c.subscriber_count is null or c.subscriber_count < 100000 then return 'subscribers_unverified'; end if;
  if c.channel_name is null or c.channel_checked_at is null or c.channel_checked_at < now()-interval '30 days'
    or c.channel_checked_at > now()+interval '5 minutes' then return 'channel_check_expired'; end if;
  if exists(select 1 from public.outreach_messages m where m.email=c.email and m.kind='campaign'
    and m.id is distinct from p_message_id and ((m.status in ('sent','uncertain') and m.finished_at >= now()-interval '30 days') or m.status='sending')) then
    return 'recently_contacted';
  end if;
  return null;
end;
$$;

create function public.outreach_preview_snapshot(p_campaign_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('subject',c.subject,'body',c.body,'contactIds',to_jsonb(c.contact_ids),'recipients',(
    select coalesce(jsonb_agg(jsonb_build_object('contactId',i.id,'contact',to_jsonb(t),
      'reason',public.outreach_contact_block_reason(i.id)) order by i.ordinal),'[]'::jsonb)
    from unnest(c.contact_ids) with ordinality as i(id,ordinal) left join public.outreach_contacts t on t.id=i.id
  )) from public.outreach_campaigns c where c.id=p_campaign_id;
$$;

create function public.outreach_preview_campaign(p_campaign_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare c public.outreach_campaigns%rowtype; snapshot jsonb;
begin
  perform 1 from public.outreach_dispatch_state where singleton for update;
  select * into c from public.outreach_campaigns where id=p_campaign_id for update;
  if not found then raise exception using errcode='OM404',message='캠페인을 찾을 수 없습니다.'; end if;
  snapshot:=public.outreach_preview_snapshot(p_campaign_id);
  if c.status='draft' then
    update public.outreach_campaigns set revision=revision+1,preview_fingerprint=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),updated_at=now()
      where id=c.id returning * into c;
  end if;
  return jsonb_build_object('campaign',to_jsonb(c),'recipients',snapshot->'recipients');
end;
$$;

create function public.outreach_queue_campaign(p_campaign_id uuid,p_request_id uuid,p_expected_revision integer,p_scheduled_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c public.outreach_campaigns%rowtype; t public.outreach_contacts%rowtype; reason text; n integer:=0; excluded jsonb:='[]'; subj text; content text;
begin
  if p_request_id is null then raise exception using errcode='OM001',message='요청 식별값이 필요합니다.'; end if;
  perform 1 from public.outreach_dispatch_state where singleton for update;
  select * into c from public.outreach_campaigns where id=p_campaign_id for update;
  if not found then raise exception using errcode='OM404',message='캠페인을 찾을 수 없습니다.'; end if;
  if c.queue_request_id=p_request_id then return jsonb_build_object('campaign',to_jsonb(c),'alreadyQueued',true); end if;
  if c.status <> 'draft' or c.revision is distinct from p_expected_revision then raise exception using errcode='OM409',message='캠페인을 다시 미리보기해주세요.'; end if;
  if c.preview_fingerprint is null or c.preview_fingerprint is distinct from encode(sha256(convert_to(public.outreach_preview_snapshot(c.id)::text,'UTF8')),'hex') then
    raise exception using errcode='OM409',message='연락처와 발송 가능 상태가 변경되었습니다. 다시 미리보기해주세요.';
  end if;
  if p_scheduled_at is not null and (p_scheduled_at <= now() or p_scheduled_at > now()+interval '90 days') then raise exception using errcode='OM001',message='예약 시각을 확인해주세요.'; end if;
  for t in select * from public.outreach_contacts where id=any(c.contact_ids) order by array_position(c.contact_ids,id) for update loop
    reason:=public.outreach_contact_block_reason(t.id);
    subj:=replace(c.subject,'{{channelName}}',coalesce(t.channel_name,''));
    content:=replace(c.body,'{{channelName}}',coalesce(t.channel_name,''));
    if char_length(subj)>400 or char_length(content)>30000 then reason:='template_too_long'; end if;
    if reason is null then
      insert into public.outreach_messages(campaign_id,contact_id,email,channel_name,subject,body,metadata_source,channel_checked_at,created_by)
      values(c.id,t.id,t.email,t.channel_name,subj,content,t.metadata_source,t.channel_checked_at,c.created_by);
      n:=n+1;
    else excluded:=excluded||jsonb_build_array(jsonb_build_object('contactId',t.id,'reason',reason)); end if;
  end loop;
  if n=0 then raise exception using errcode='OM409',message='수신동의·채널 확인을 마친 발송 가능 연락처가 없습니다.'; end if;
  update public.outreach_campaigns set status='queued',queue_request_id=p_request_id,scheduled_at=p_scheduled_at,queued_at=now(),updated_at=now()
    where id=c.id returning * into c;
  return jsonb_build_object('campaign',to_jsonb(c),'alreadyQueued',false,'queuedCount',n,'excluded',excluded);
end;
$$;

create function public.outreach_set_campaign_state(p_campaign_id uuid,p_action text) returns public.outreach_campaigns
language plpgsql security invoker set search_path = '' as $$
declare c public.outreach_campaigns%rowtype;
begin
  perform 1 from public.outreach_dispatch_state where singleton for update;
  select * into c from public.outreach_campaigns where id=p_campaign_id for update;
  if not found then raise exception using errcode='OM404',message='캠페인을 찾을 수 없습니다.'; end if;
  if p_action='pause' and c.status in ('queued','running','paused') then
    update public.outreach_campaigns set status='paused',updated_at=now() where id=c.id returning * into c;
  elsif p_action='start' and c.status in ('queued','paused','running') then
    update public.outreach_campaigns set status='running',scheduled_at=now(),updated_at=now() where id=c.id returning * into c;
  else raise exception using errcode='OM409',message='이 상태에서는 캠페인을 시작하거나 일시정지할 수 없습니다.'; end if;
  return c;
end;
$$;

create function public.outreach_queue_test(p_subject text,p_body text,p_actor_id uuid) returns public.outreach_messages
language plpgsql security invoker set search_path = '' as $$
declare m public.outreach_messages%rowtype;
begin
  if p_actor_id is null then raise exception using errcode='OM001',message='관리자 식별값이 필요합니다.'; end if;
  perform 1 from public.outreach_dispatch_state where singleton for update;
  insert into public.outreach_messages(kind,email,channel_name,subject,body,created_by)
  values('test','codemeet@naver.com','코드밋 테스트',p_subject,p_body,p_actor_id) returning * into m;
  return m;
end;
$$;

create function public.outreach_recover_dispatch() returns void
language plpgsql security invoker set search_path = '' as $$
declare d public.outreach_dispatch_state%rowtype; m public.outreach_messages%rowtype;
begin
  select * into d from public.outreach_dispatch_state where singleton for update;
  if d.active_message_id is null or d.lease_expires_at > now() then return; end if;
  select * into m from public.outreach_messages where id=d.active_message_id for update;
  if m.status='sending' then
    update public.outreach_messages set status='uncertain',error_code='WORKER_LOST_DURING_SEND',finished_at=now(),worker_token=null,lease_expires_at=null,updated_at=now() where id=m.id;
    update public.outreach_campaigns set status='paused',updated_at=now() where id=m.campaign_id and status in ('running','queued');
  elsif m.status='claimed' then
    update public.outreach_messages set status='pending',worker_token=null,lease_expires_at=null,updated_at=now() where id=m.id;
  end if;
  update public.outreach_dispatch_state set active_message_id=null,active_worker_token=null,lease_expires_at=null where singleton;
end;
$$;

create function public.outreach_claim_message(p_worker_token uuid,p_daily_limit integer,p_interval_seconds integer)
returns setof public.outreach_messages language plpgsql security invoker set search_path = '' as $$
declare d public.outreach_dispatch_state%rowtype; m public.outreach_messages%rowtype; today date:=(now() at time zone 'Asia/Seoul')::date;
begin
  if p_worker_token is null or p_daily_limit is null or p_interval_seconds is null or p_daily_limit not between 1 and 100 or p_interval_seconds not between 60 and 86400 then raise exception using errcode='OM001',message='발송 한도 설정을 확인해주세요.'; end if;
  select * into d from public.outreach_dispatch_state where singleton for update skip locked;
  if not found then return; end if;
  perform public.outreach_recover_dispatch();
  select * into d from public.outreach_dispatch_state where singleton;
  if d.active_message_id is not null then return; end if;
  if d.quota_day <> today then
    update public.outreach_dispatch_state set quota_day=today,daily_attempts=0 where singleton;
    d.daily_attempts:=0;
  end if;
  if d.next_allowed_at>now() or d.daily_attempts>=p_daily_limit then return; end if;
  select q.* into m from public.outreach_messages q left join public.outreach_campaigns c on c.id=q.campaign_id
    where q.status='pending' and (q.kind='test' or c.status='running' or (c.status='queued' and c.scheduled_at is not null and c.scheduled_at<=now()))
    order by q.created_at,q.id for update of q skip locked limit 1;
  if not found then return; end if;
  update public.outreach_campaigns set status='running',updated_at=now() where id=m.campaign_id and status='queued';
  update public.outreach_messages set status='claimed',worker_token=p_worker_token,lease_expires_at=now()+interval '2 minutes',updated_at=now()
    where id=m.id returning * into m;
  update public.outreach_dispatch_state set active_message_id=m.id,active_worker_token=p_worker_token,lease_expires_at=m.lease_expires_at where singleton;
  return next m;
end;
$$;

create function public.outreach_begin_send(p_message_id uuid,p_worker_token uuid,p_token_hash text,p_daily_limit integer,p_interval_seconds integer)
returns setof public.outreach_messages language plpgsql security invoker set search_path = '' as $$
declare d public.outreach_dispatch_state%rowtype; m public.outreach_messages%rowtype; reason text; today date:=(now() at time zone 'Asia/Seoul')::date;
begin
  if p_message_id is null or p_worker_token is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_daily_limit is null or p_interval_seconds is null or p_daily_limit not between 1 and 100 or p_interval_seconds not between 60 and 86400 then raise exception using errcode='OM001',message='발송 정보를 확인해주세요.'; end if;
  select * into d from public.outreach_dispatch_state where singleton for update;
  select * into m from public.outreach_messages where id=p_message_id for update;
  if not found or m.status<>'claimed' or m.worker_token is distinct from p_worker_token
    or d.active_message_id is distinct from p_message_id or d.active_worker_token is distinct from p_worker_token
    or m.lease_expires_at<=now() then return; end if;
  if d.quota_day<>today then
    update public.outreach_dispatch_state set quota_day=today,daily_attempts=0 where singleton;
    d.daily_attempts:=0;
  end if;
  if d.daily_attempts>=p_daily_limit or d.next_allowed_at>now() then reason:='send_limit'; end if;
  if m.kind='campaign' then
    if (select status from public.outreach_campaigns where id=m.campaign_id)<>'running' then reason:='campaign_paused';
    else reason:=coalesce(reason,public.outreach_contact_block_reason(m.contact_id,m.email,m.id)); end if;
  elsif exists(select 1 from public.outreach_suppressions where email=m.email) then reason:='unsubscribed'; end if;
  if m.subject is null or m.body is null or (m.metadata_source='youtube_api' and m.channel_checked_at<now()-interval '30 days') then reason:='channel_check_expired'; end if;
  if reason is not null then
    update public.outreach_messages set status=case when reason in ('campaign_paused','send_limit') then 'pending' else 'skipped' end,
      error_code=reason,finished_at=case when reason in ('campaign_paused','send_limit') then null else now() end,worker_token=null,lease_expires_at=null,updated_at=now() where id=m.id;
    update public.outreach_dispatch_state set active_message_id=null,active_worker_token=null,lease_expires_at=null where singleton;
    update public.outreach_campaigns c set status='completed',updated_at=now() where c.id=m.campaign_id and c.status in ('running','queued')
      and not exists(select 1 from public.outreach_messages q where q.campaign_id=c.id and q.status in ('pending','claimed','sending'));
    return;
  end if;
  update public.outreach_messages set status='sending',unsubscribe_token_hash=p_token_hash,started_at=now(),error_code=null,
    lease_expires_at=now()+interval '2 minutes',updated_at=now() where id=m.id returning * into m;
  update public.outreach_dispatch_state set daily_attempts=daily_attempts+1,next_allowed_at=now()+make_interval(secs=>p_interval_seconds),lease_expires_at=m.lease_expires_at where singleton;
  return next m;
end;
$$;

create function public.outreach_finish_message(p_message_id uuid,p_worker_token uuid,p_status text,p_error_code text default null,p_smtp_message_id text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare d public.outreach_dispatch_state%rowtype; m public.outreach_messages%rowtype;
begin
  if p_status not in ('sent','failed','uncertain') or (p_error_code is not null and p_error_code !~ '^[A-Za-z0-9_]{1,80}$') then raise exception using errcode='OM001',message='발송 결과를 확인해주세요.'; end if;
  select * into d from public.outreach_dispatch_state where singleton for update;
  select * into m from public.outreach_messages where id=p_message_id for update;
  if not found or m.status not in ('claimed','sending') or m.worker_token is distinct from p_worker_token
    or d.active_message_id is distinct from p_message_id or d.active_worker_token is distinct from p_worker_token then return false; end if;
  if p_status in ('sent','uncertain') and m.status<>'sending' then return false; end if;
  update public.outreach_messages set status=p_status,error_code=p_error_code,smtp_message_id=left(p_smtp_message_id,300),
    sent_at=case when p_status='sent' then now() else null end,finished_at=now(),worker_token=null,lease_expires_at=null,updated_at=now() where id=m.id;
  update public.outreach_dispatch_state set active_message_id=null,active_worker_token=null,lease_expires_at=null where singleton;
  if p_status='uncertain' then
    update public.outreach_campaigns set status='paused',updated_at=now() where id=m.campaign_id and status in ('running','queued');
  end if;
  update public.outreach_campaigns c set status='completed',updated_at=now() where c.id=m.campaign_id and c.status in ('running','queued')
    and not exists(select 1 from public.outreach_messages q where q.campaign_id=c.id and q.status in ('pending','claimed','sending'));
  return true;
end;
$$;

create function public.outreach_unsubscribe(p_token_hash text) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare m public.outreach_messages%rowtype;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  perform 1 from public.outreach_dispatch_state where singleton for update;
  select * into m from public.outreach_messages where unsubscribe_token_hash=p_token_hash;
  if not found then return false; end if;
  insert into public.outreach_suppressions(email) values(m.email) on conflict(email) do nothing;
  update public.outreach_contacts set consent_status='revoked',updated_at=now() where email=m.email;
  update public.outreach_dispatch_state d set active_message_id=null,active_worker_token=null,lease_expires_at=null
    where singleton and exists(select 1 from public.outreach_messages q where q.id=d.active_message_id and q.email=m.email and q.status='claimed');
  update public.outreach_messages set status='skipped',error_code='unsubscribed',finished_at=now(),worker_token=null,lease_expires_at=null,updated_at=now()
    where email=m.email and status in ('pending','claimed');
  update public.outreach_campaigns c set status='completed',updated_at=now() where c.status in ('running','queued')
    and not exists(select 1 from public.outreach_messages q where q.campaign_id=c.id and q.status in ('pending','claimed','sending'));
  return true;
end;
$$;

create function public.outreach_expire_api_metadata() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare n_contacts integer; n_messages integer;
begin
  perform 1 from public.outreach_dispatch_state where singleton for update;
  perform public.outreach_recover_dispatch();
  update public.outreach_contacts set channel_id=null,channel_name=null,channel_url='',country='',subscriber_count=null,korea_verified=false,korea_evidence='',
    channel_checked_at=null,metadata_expired_at=now(),updated_at=now()
    where metadata_source='youtube_api' and metadata_expired_at is null and coalesce(channel_checked_at,created_at)<now()-interval '30 days';
  get diagnostics n_contacts = row_count;
  update public.outreach_dispatch_state d set active_message_id=null,active_worker_token=null,lease_expires_at=null
    where singleton and exists(select 1 from public.outreach_messages q where q.id=d.active_message_id and q.status='claimed'
      and q.metadata_source='youtube_api' and coalesce(q.channel_checked_at,q.created_at)<now()-interval '30 days');
  update public.outreach_messages set channel_name=null,subject=null,body=null,channel_checked_at=null,metadata_expired_at=now(),
    status=case when status in ('pending','claimed') then 'skipped' else status end,
    error_code=case when status in ('pending','claimed') then 'channel_check_expired' else error_code end,
    finished_at=case when status in ('pending','claimed') then now() else finished_at end,
    worker_token=case when status='claimed' then null else worker_token end,lease_expires_at=case when status='claimed' then null else lease_expires_at end,updated_at=now()
    where metadata_source='youtube_api' and metadata_expired_at is null and coalesce(channel_checked_at,created_at)<now()-interval '30 days';
  get diagnostics n_messages = row_count;
  update public.outreach_campaigns c set status='completed',updated_at=now() where c.status in ('running','queued')
    and not exists(select 1 from public.outreach_messages q where q.campaign_id=c.id and q.status in ('pending','claimed','sending'));
  return jsonb_build_object('contactsExpired',n_contacts,'snapshotsExpired',n_messages);
end;
$$;

-- Explicit grants are required even when a project opts out of automatic grants.
create function public.outreach_campaign_counts(p_campaign_ids uuid[]) returns table(campaign_id uuid,counts jsonb)
language sql stable security invoker set search_path = '' as $$
  select s.campaign_id,jsonb_object_agg(s.status,s.n) from (
    select m.campaign_id,m.status,count(*) as n from public.outreach_messages m
    where m.campaign_id=any(p_campaign_ids) group by m.campaign_id,m.status
  ) s group by s.campaign_id;
$$;

create function public.outreach_release_claim(p_message_id uuid,p_worker_token uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare d public.outreach_dispatch_state%rowtype;
begin
  select * into d from public.outreach_dispatch_state where singleton for update;
  if d.active_message_id is distinct from p_message_id or d.active_worker_token is distinct from p_worker_token then return false; end if;
  update public.outreach_messages set status='pending',worker_token=null,lease_expires_at=null,updated_at=now()
    where id=p_message_id and worker_token=p_worker_token and status='claimed';
  if not found then return false; end if;
  update public.outreach_dispatch_state set active_message_id=null,active_worker_token=null,lease_expires_at=null where singleton;
  return true;
end;
$$;

do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'outreach\_%' escape '\' loop
    execute format('revoke all on function %s from public, anon, authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end;
$$;
