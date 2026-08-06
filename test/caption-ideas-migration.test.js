import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260722090000_caption_ideas.sql',
  import.meta.url,
);
const historyMigrationUrl = new URL(
  '../supabase/migrations/20260722100000_caption_idea_history.sql',
  import.meta.url,
);
const emphasisMigrationUrl = new URL(
  '../supabase/migrations/20260806060000_caption_idea_emphasis_mode.sql',
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

test('caption idea history extends available results to 90 days without changing table access', async () => {
  const sql = await readFile(historyMigrationUrl, 'utf8');

  assert.match(sql, /alter column ideas_expires_at set default \(now\(\) \+ interval '90 days'\)/i);
  assert.match(sql, /set ideas_expires_at = created_at \+ interval '90 days'/i);
  assert.match(sql, /where ideas is not null/i);
  assert.doesNotMatch(sql, /grant .* (anon|authenticated)/i);
  assert.doesNotMatch(sql, /disable row level security/i);
});

test('emphasis mode is accepted by both the table constraint and the charging function', async () => {
  const sql = await readFile(emphasisMigrationUrl, 'utf8');

  // 테이블 제약과 RPC 검증 두 곳 모두에서 네 가지 모드를 허용해야 한다.
  assert.match(
    sql,
    /add constraint caption_idea_requests_mode_check[\s\S]*check \(mode in \('entertainment', 'situation', 'emphasis', 'emotion'\)\)/i,
  );
  assert.match(
    sql,
    /p_mode not in \('entertainment', 'situation', 'emphasis', 'emotion'\)/i,
  );
  assert.match(sql, /create or replace function public\.complete_caption_idea_request\(/i);
  // 기존 과금·크레딧 로직은 그대로 유지된다.
  assert.match(sql, /errcode = 'CI002'/);
  assert.match(sql, /v_remaining := 4;/);
  assert.doesNotMatch(sql, /grant .* (anon|authenticated)/i);
  assert.doesNotMatch(sql, /drop table|disable row level security/i);
});
