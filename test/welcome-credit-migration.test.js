import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260716114218_welcome_credit_once.sql',
  import.meta.url,
);

test('stores only protected welcome-credit identity markers', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const tableDefinition = sql.match(
    /create table public\.welcome_credit_claims \([\s\S]*?\n\);/i,
  )?.[0] || '';

  assert.match(sql, /create table public\.welcome_credit_claims/i);
  assert.match(sql, /identity_hash text not null[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /alter table public\.welcome_credit_claims enable row level security/i);
  assert.match(sql, /revoke all on table public\.welcome_credit_claims from public, anon, authenticated/i);
  assert.doesNotMatch(tableDefinition, /email\s+text|provider_id\s+text|user_id\s+uuid/i);
});

test('serializes identity claims and grants ten minutes only when unclaimed', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create or replace function public\.ensure_welcome_credit_profile/i);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*welcome-identity:/i);
  assert.match(sql, /v_granted := not v_already_claimed/i);
  assert.match(sql, /case when v_granted then 10 else 0 end/i);
  assert.match(sql, /on conflict \(benefit_code, identity_hash\) do nothing/i);
});

test('keeps welcome-credit functions unavailable to browser roles', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /security invoker/ig);
  assert.match(sql, /revoke all on function public\.register_welcome_credit_claims\(text\[\]\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.ensure_welcome_credit_profile\(uuid, text, text\[\]\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.ensure_welcome_credit_profile\(uuid, text, text\[\]\) to service_role/i);
});
