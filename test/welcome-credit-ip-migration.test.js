import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20261012080104_welcome_ip_verification.sql',
  import.meta.url,
);
const restoreMigrationUrl = new URL(
  '../supabase/migrations/20261013015526_restore_welcome_credit_identity_mode.sql',
  import.meta.url,
);

test('identity-mode restoration is service-only, serialized, and cannot repeat a welcome lot', async () => {
  const sql = await readFile(restoreMigrationUrl, 'utf8');
  const claim = sql.match(/create or replace function public\.claim_welcome_credit_identity\([\s\S]*?\n\$\$;/i)?.[0] || '';

  assert.match(claim, /coalesce\(p_email_confirmed, false\) is false/i);
  assert.match(claim, /credit-user:/i);
  assert.match(claim, /welcome-user:/i);
  assert.match(claim, /welcome-identity:/i);
  assert.match(claim, /v_profile_balance <> v_lot_balance/i);
  assert.match(claim, /where l\.user_id = p_user_id and l\.source = 'welcome'/i);
  assert.match(claim, /delete from public\.welcome_credit_eligibility/i);
  assert.match(claim, /insert into public\.credit_lots \(user_id, source, granted, available\)\s+values \(p_user_id, 'welcome', 10, 10\)/i);
  assert.doesNotMatch(claim, /ip_hash|turnstile|source in \('welcome', 'adjustment'\)/i);
  assert.match(sql, /revoke all on function public\.claim_welcome_credit_identity\(uuid, text\[\], boolean\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.claim_welcome_credit_identity\(uuid, text\[\], boolean\)\s+to service_role/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
});

test('new profiles wait at zero minutes and existing profiles are preserved', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const ensure = sql.match(/create or replace function public\.ensure_welcome_credit_profile\([\s\S]*?\n\$\$;/i)?.[0] || '';

  assert.match(ensure, /values \(p_user_id, lower\(btrim\(p_email\)\), 0, 'free'\)/i);
  assert.match(ensure, /insert into public\.welcome_credit_eligibility \(user_id\)/i);
  assert.match(ensure, /if found then\s+return query select v_credits, v_plan, false;/i);
  assert.doesNotMatch(ensure, /insert into public\.credit_lots/i);
  assert.doesNotMatch(ensure, /insert into public\.welcome_credit_claims/i);
});

test('IP, account, and credit eligibility records are server-only HMAC tables', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of ['welcome_credit_eligibility', 'welcome_credit_ip_attempts', 'welcome_credit_ip_grants']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  assert.match(sql, /ip_hash text not null check \(ip_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(sql, /account_hash text not null check \(account_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  for (const table of ['welcome_credit_ip_attempts', 'welcome_credit_ip_grants']) {
    const definition = sql.match(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`, 'i'))?.[0] || '';
    assert.doesNotMatch(definition, /email\s+text/i);
    assert.doesNotMatch(definition, /provider_id\s+text/i);
  }
});

test('claim checks email, challenge, identity, rolling limit, and ledger before one atomic grant', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const claim = sql.match(/create or replace function public\.claim_welcome_credit\([\s\S]*?\n\$\$;/i)?.[0] || '';

  assert.match(claim, /coalesce\(p_email_confirmed, false\) is false/i);
  assert.match(claim, /v_attempt_count >= 2/i);
  assert.match(claim, /v_attempt\.challenge_nonce is distinct from p_challenge_nonce/i);
  assert.match(claim, /v_attempt\.challenge_expires_at is null/i);
  assert.match(claim, /g\.granted_at > now\(\) - interval '24 hours'/i);
  assert.match(claim, /v_profile_balance <> v_lot_balance/i);
  assert.match(claim, /insert into public\.credit_lots \(user_id, source, granted, available\)\s+values \(p_user_id, 'welcome', 10, 10\)/i);
  assert.doesNotMatch(claim, /on conflict/i);
});

test('retention is bounded and functions are unavailable to browser roles', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /least\(coalesce\(p_limit, 1000\), 5000\)/i);
  assert.match(sql, /where a\.first_attempt_at < now\(\) - interval '7 days'/i);
  assert.match(sql, /where g\.granted_at < now\(\) - interval '7 days'/i);
  for (const functionName of ['prepare_welcome_credit_claim', 'claim_welcome_credit', 'cleanup_welcome_credit_ip_records']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${functionName}\\([\\s\\S]*?from public, anon, authenticated`, 'i'));
  }
  assert.match(sql, /grant execute on function public\.claim_welcome_credit\(uuid, text\[\], text, text, boolean, uuid, boolean\) to service_role/i);
});
