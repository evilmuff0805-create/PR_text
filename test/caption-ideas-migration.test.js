import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260722090000_caption_ideas.sql',
  import.meta.url,
);

test('caption idea tables are private service-only records with cascading account deletion', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create table public\.caption_idea_wallets/i);
  assert.match(sql, /create table public\.caption_idea_requests/i);
  assert.match(sql, /references public\.profiles\(id\) on delete cascade/gi);
  assert.match(sql, /alter table public\.caption_idea_wallets enable row level security/i);
  assert.match(sql, /alter table public\.caption_idea_requests enable row level security/i);
  assert.match(sql, /revoke all on table public\.caption_idea_wallets from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.caption_idea_requests from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.caption_idea_requests to service_role/i);
});

test('completion RPC serializes credit and wallet changes and records one five-use pack', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functionSql = sql.slice(
    sql.indexOf('create or replace function public.complete_caption_idea_request'),
    sql.indexOf('create or replace function public.cleanup_caption_idea_requests'),
  );

  assert.match(functionSql, /security invoker/i);
  assert.match(functionSql, /from public\.profiles as p[\s\S]*for update/i);
  assert.match(functionSql, /if found then[\s\S]*v_existing\.ideas[\s\S]*true;/i);
  assert.match(functionSql, /v_existing\.ideas_expires_at <= now\(\)/i);
  assert.match(functionSql, /from public\.caption_idea_wallets as w[\s\S]*for update/i);
  assert.match(functionSql, /v_remaining := 4/i);
  assert.match(functionSql, /set credits = p\.credits - 1/i);
  assert.match(functionSql, /'caption_ideas'[\s\S]*'자막 아이디어 생성권 5회'/i);
  assert.ok(
    functionSql.indexOf('select r.*') < functionSql.indexOf('set credits = p.credits - 1'),
    'idempotency lookup must happen before credit mutation',
  );
  assert.match(
    sql,
    /revoke all on function public\.complete_caption_idea_request\([\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.complete_caption_idea_request\([\s\S]*to service_role/i,
  );
});

test('temporary ideas are cleared after 24 hours and request metrics after 90 days', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /ideas_expires_at timestamptz not null default \(now\(\) \+ interval '24 hours'\)/i);
  assert.match(sql, /set ideas = null[\s\S]*ideas_expires_at <= now\(\)/i);
  assert.match(sql, /created_at < now\(\) - interval '90 days'/i);
});
