
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.profiles(id uuid primary key,email text,credits integer default 10,plan text default 'free',created_at timestamptz default now(),updated_at timestamptz default now());
create table public.usage_logs(id bigserial primary key,user_id uuid references profiles(id) on delete cascade,action text not null,credits_used integer default 0,audio_minutes numeric default 0,description text,created_at timestamptz default now(),order_id text);
create unique index usage_logs_order_id_unique on public.usage_logs(order_id) where order_id is not null;
create table public.transcription_logs(id bigserial primary key,user_id uuid not null references profiles(id) on delete cascade,filename text not null,duration_seconds numeric not null default 0,language text,segments_count integer not null default 0,text_preview text,created_at timestamptz not null default now(),segments jsonb default '[]');
alter table profiles enable row level security; alter table usage_logs enable row level security; alter table transcription_logs enable row level security;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
grant usage on schema public,auth,storage to service_role,authenticated,anon;
grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;