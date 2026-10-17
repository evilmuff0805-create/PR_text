// Independent QA: synthetic local PostgreSQL only. Never load application env.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { boot } = require('./db-replay.cjs');

assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST || '127.0.0.1'), 'QA requires a loopback database');
assert.ok(['fixture', 'qa_batch_admin'].includes(process.env.PGUSER || 'fixture'), 'QA requires an explicitly isolated fixture role');

const hash = 'd'.repeat(64);
const checks = [];
let db;
const peers = new Set();
const q = async (client, sql, parameters = []) => (await client.query(sql, parameters)).rows;
const value = async (client, sql, parameters = []) => (await q(client, sql, parameters))[0]?.value;
const rejected = (callback, code) => assert.rejects(callback, error => error.code === code);

async function peer() {
  const client = await db.peer();
  await client.query("set statement_timeout='15s'; set lock_timeout='5s'");
  peers.add(client);
  return client;
}

async function scenario(name, callback) {
  // Every row belongs to this fresh db-replay database, never to another suite.
  assert.match(db.database, /^fixture_\d+$/);
  await db.query('delete from public.profiles');
  await callback();
  checks.push(name);
  console.log('PASS ' + name);
}

async function user(credits = 50) {
  const id = randomUUID();
  await q(db, 'insert into profiles(id,credits) values($1,$2)', [id, credits]);
  if (credits > 0) await q(db, "insert into credit_lots(user_id,source,granted,available) values($1,'legacy',$2,$2)", [id, credits]);
  return id;
}

async function batch({ owner, count = 2, durations, credits = 50, key = randomUUID(), client = db } = {}) {
  owner ||= await user(credits);
  const files = Array.from({ length: count }, (_, index) => ({ clientId: randomUUID(), filename: 'same.wav', label: `track ${index + 1}` }));
  const id = await value(client, 'select create_transcription_batch($1,$2,$3,$4,$5) as value', [owner, key, hash, 'ko', JSON.stringify(files)]);
  const items = await q(db, 'select * from transcription_batch_items where batch_id=$1 order by item_order', [id]);
  return { id, owner, key, files, items, durations: durations || Array(count).fill(60), credits };
}

const manifest = (owner, operation) => [{ path: `${owner}/${operation}/0000`, bytes: 100, sha256: hash }];

async function stage(context, index, { complete = true, fingerprint = hash } = {}) {
  const item = context.items[index];
  const row = (await q(db, 'select * from stage_transcription_batch_item($1,$2,$3,$4,$5,$6,$7,$8)',
    [context.owner, context.id, item.id, fingerprint, item.filename, 'audio/wav', 100, context.durations[index]]))[0];
  item.current_operation_id = row.operation_id;
  if (complete) assert.equal(await value(db, 'select complete_transcription_batch_upload($1,$2,$3,$4,$5) as value',
    [context.owner, context.id, item.id, row.operation_id, JSON.stringify(manifest(context.owner, row.operation_id))]), true);
  return row.operation_id;
}

async function ready(context) { for (let index = 0; index < context.items.length; index++) await stage(context, index); return context; }
const cost = context => context.durations.reduce((sum, seconds) => sum + Math.max(1, Math.ceil(seconds / 60)), 0);
const start = (context, request = randomUUID(), client = db, expected = cost(context)) => value(client,
  'select start_transcription_batch($1,$2,$3,$4) as value', [context.owner, context.id, request, expected]);
const detail = (context, owner = context.owner) => value(db, 'select get_transcription_batch($1,$2) as value', [owner, context.id]);
const balance = owner => value(db, 'select credits as value from profiles where id=$1', [owner]);
const allocations = owner => value(db, 'select count(*)::int as value from credit_allocations where user_id=$1', [owner]);
const cancel = (context, client = db) => value(client, 'select cancel_transcription_batch($1,$2) as value', [context.owner, context.id]);
const claim = async (token = randomUUID(), client = db) => ({ token, row: (await q(client, 'select * from claim_transcription_operation($1)', [token]))[0] });
const checkpoint = (operation, token, segments = [{ start: 20, end: 20.2, text: 'synthetic response' }], client = db) => value(client,
  'select checkpoint_transcription_operation($1,$2,$3,$4,$5,$6) as value', [operation, token, 'synthetic response', JSON.stringify(segments), 'ko', '{}']);
const finalize = async (operation, token, client = db) => (await q(client, 'select * from finalize_transcription_operation($1,$2)', [operation, token]))[0];
const fail = async (operation, token, client = db) => (await q(client, 'select * from fail_transcription_operation($1,$2,$3)', [operation, token, 'synthetic provider failure']))[0];
const retry = (context, index, request, client = db) => value(client, 'select retry_transcription_batch_item($1,$2,$3,$4) as value', [context.owner, context.id, context.items[index].id, request]);

async function ordinary(owner, client = db) {
  return (await q(client, 'select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8)', [owner, randomUUID(), hash, 'ordinary.wav', 'audio/wav', 100, 'ko', 60]))[0].operation_id;
}

async function main() {
  const migration = path.join(__dirname, '../../supabase/migrations/20261017014800_person_audio_batches.sql');
  const migrationBefore = createHash('sha256').update(readFileSync(migration)).digest('hex');
  db = await boot();
  await db.query("set statement_timeout='15s'; set lock_timeout='5s'");
  const a = await peer(), b = await peer();

  await scenario('private batch tables and all batch RPCs deny public client roles', async () => {
    const tables = await q(db, "select relname,relrowsecurity from pg_class where relname in ('transcription_batches','transcription_batch_items','transcription_batch_requests')");
    assert.equal(tables.length, 3); assert.ok(tables.every(table => table.relrowsecurity));
    const functions = await q(db, "select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%transcription_batch%'");
    assert.ok(functions.length >= 10);
    for (const role of ['anon', 'authenticated']) {
      for (const entry of functions) assert.equal(await value(db, 'select has_function_privilege($1,$2,$3) as value', [role, entry.oid, 'execute']), false, entry.proname);
      await db.query(`set role ${role}`);
      try {
        for (const table of tables) await rejected(() => db.query(`select * from public.${table.relname}`), '42501');
        await rejected(() => db.query('select create_transcription_batch($1,$2,$3,$4,$5)', [randomUUID(), randomUUID(), hash, 'ko', '[]']), '42501');
      } finally { await db.query('reset role'); }
    }
  });

  await scenario('concurrent batch create is stable and same-key different payload is rejected', async () => {
    const owner = await user(), key = randomUUID();
    const files = [{ clientId: randomUUID(), filename: 'same.wav', label: 'one' }];
    const sql = 'select create_transcription_batch($1,$2,$3,$4,$5) as value';
    const parameters = [owner, key, hash, 'ko', JSON.stringify(files)];
    const result = await Promise.all([value(a, sql, parameters), value(b, sql, parameters)]);
    assert.equal(result[0], result[1]);
    assert.equal(await value(db, 'select count(*)::int as value from transcription_batches'), 1);
    await rejected(() => value(db, sql, [owner, key, 'a'.repeat(64), 'ko', JSON.stringify(files)]), 'TB409');
    const other = await user();
    assert.notEqual(await value(db, sql, [other, key, hash, 'ko', JSON.stringify(files)]), result[0]);
  });

  await scenario('invalid six-file create has no parent or child side effects', async () => {
    const owner = await user();
    const files = Array.from({ length: 6 }, () => ({ clientId: randomUUID(), filename: 'synthetic.wav', label: 'track' }));
    await rejected(() => value(db, 'select create_transcription_batch($1,$2,$3,$4,$5) as value', [owner, randomUUID(), hash, 'ko', JSON.stringify(files)]), 'TB400');
    assert.equal(await value(db, 'select count(*)::int as value from transcription_batches'), 0);
    assert.equal(await value(db, 'select count(*)::int as value from transcription_batch_items'), 0);
  });

  await scenario('staging is unbilled and ceil costs include complete per-file duration', async () => {
    const context = await batch({ count: 5, durations: [.2, 60, 60.00001, 180.01, 600] });
    await ready(context);
    const data = await detail(context);
    assert.equal(data.totalCredits, 18); assert.equal(data.canStart, true);
    assert.equal(await balance(context.owner), 50); assert.equal(await allocations(context.owner), 0);
    assert.deepEqual(data.items.map(item => item.clientId), context.files.map(item => item.clientId));
    assert.equal(new Set(data.items.map(item => item.id)).size, 5);
    assert.ok(data.items.every(item => item.filename === 'same.wav' && item.status === 'ready'));
  });

  await scenario('one missing upload blocks every reservation', async () => {
    const context = await batch(); await stage(context, 0);
    await rejected(() => start(context), 'TB409');
    assert.equal(await allocations(context.owner), 0); assert.equal(await balance(context.owner), 50);
  });

  await scenario('second child insufficient balance rolls back the whole FEFO reservation', async () => {
    const context = await ready(await batch({ credits: 3, durations: [120, 120] }));
    await rejected(() => start(context), 'TB402');
    assert.equal(await balance(context.owner), 3); assert.equal(await allocations(context.owner), 0);
    assert.ok((await detail(context)).items.every(item => item.status === 'ready'));
    assert.equal(await value(db, 'select count(*)::int as value from transcription_batch_requests'), 0);
    assert.equal(await value(db, 'select sum(reserved)::int as value from credit_lots where user_id=$1', [context.owner]), 0);
  });

  await scenario('unexpected queue result rolls back earlier child allocations', async () => {
    const context = await ready(await batch());
    const poison = (await q(db, 'select id from transcription_operations where batch_id=$1 order by id desc limit 1', [context.id]))[0].id;
    const original = await value(db, "select pg_get_functiondef('queue_transcription_operation_internal(uuid,uuid,jsonb,integer)'::regprocedure) as value");
    await db.query(original.replace('queue_transcription_operation_internal(', 'qa_original_queue('));
    await db.query(`create or replace function public.queue_transcription_operation_internal(p_operation_id uuid,p_user_id uuid,p_storage_manifest jsonb,p_credits integer)
      returns table(operation_id uuid,status text,credits_remaining integer,already_queued boolean) language plpgsql security invoker set search_path='' as $$
      declare r record; begin select * into r from public.qa_original_queue(p_operation_id,p_user_id,p_storage_manifest,p_credits);
      if not found then return; end if;
      return query select r.operation_id,case when p_operation_id='${poison}'::uuid then 'staged'::text else r.status end,r.credits_remaining,r.already_queued;
      end $$`);
    try {
      await rejected(() => start(context), 'TB409');
      assert.equal(await balance(context.owner), 50); assert.equal(await allocations(context.owner), 0);
      assert.ok((await detail(context)).items.every(item => item.status === 'ready'));
    } finally { await db.query(original); await db.query('drop function qa_original_queue(uuid,uuid,jsonb,integer)'); }
  });

  await scenario('concurrent identical start reserves each child once with no parent allocation', async () => {
    const context = await ready(await batch({ durations: [61, 61] })), request = randomUUID();
    const results = await Promise.all([start(context, request, a), start(context, request, b)]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await balance(context.owner), 46);
    assert.equal(await value(db, 'select count(distinct operation_id)::int as value from credit_allocations where user_id=$1', [context.owner]), 2);
    const keys = (await q(db, 'select distinct operation_id from credit_allocations where user_id=$1', [context.owner])).map(row => row.operation_id);
    assert.deepEqual(keys.sort(), context.items.map(item => `operation:${item.current_operation_id}`).sort());
    await rejected(() => start(context, request, db, 5), 'TB409');
    await rejected(() => start(context), 'TB409');
  });

  await scenario('a five-file batch consumes one of the existing three active group slots', async () => {
    const owner = await user(); await ordinary(owner); await ordinary(owner);
    const context = await ready(await batch({ owner, count: 5 }));
    assert.equal(await value(db, 'select transcription_active_group_count($1) as value', [owner]), 3);
    await rejected(() => ordinary(owner), 'TO429');
    await rejected(() => batch({ owner }), 'TB429');
    await cancel(context); await ordinary(owner);
    assert.equal(await value(db, 'select transcription_active_group_count($1) as value', [owner]), 3);
  });

  await scenario('an accepted parent awaiting every upload blocks account deletion before any child exists', async () => {
    const context = await batch();
    assert.equal(await value(db, 'select count(*)::int as value from transcription_operations where batch_id=$1', [context.id]), 0);
    const preview = (await q(db, 'select * from preview_account_deletion($1)', [context.owner]))[0];
    assert.equal(preview.active_job_count, 1); assert.equal(preview.can_delete, false); assert.equal(preview.blocker_reason, 'active_job');
    const accountHash = createHash('sha256').update(context.owner).digest('hex');
    await rejected(() => q(db, 'select * from begin_account_deletion($1,$2)', [context.owner, accountHash]), 'AD002');
    assert.equal(await balance(context.owner), 50);
    await cancel(context);
    assert.equal((await q(db, 'select * from preview_account_deletion($1)', [context.owner]))[0].active_job_count, 0);
    assert.equal((await q(db, 'select * from begin_account_deletion($1,$2)', [context.owner, accountHash]))[0].deletion_status, 'prepared');
    assert.equal(await value(db, 'select count(*)::int as value from transcription_batches where id=$1', [context.id]), 0);
  });

  await scenario('old generic create queue cancel and claim cannot bypass batch start', async () => {
    const context = await ready(await batch()), item = context.items[0];
    await rejected(() => q(db, 'select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8)',
      [context.owner, item.operation_key, hash, 'same.wav', 'audio/wav', 100, 'ko', 60]), 'TB409');
    await rejected(() => q(db, 'select * from queue_transcription_operation($1,$2,$3,$4)',
      [item.current_operation_id, context.owner, JSON.stringify(manifest(context.owner, item.current_operation_id)), 1]), 'TB409');
    await rejected(() => q(db, 'select * from cancel_transcription_operation($1,$2)', [item.current_operation_id, context.owner]), 'TB409');
    assert.equal((await claim()).row, undefined); assert.equal(await allocations(context.owner), 0);
  });

  await scenario('two database workers share one batch lease and advance after settlement', async () => {
    const context = await ready(await batch()); await start(context);
    const claims = await Promise.all([claim(randomUUID(), a), claim(randomUUID(), b)]);
    assert.equal(claims.filter(entry => entry.row).length, 1);
    const first = claims.find(entry => entry.row);
    assert.equal(await value(db, 'select renew_transcription_operation_lease($1,$2) as value', [first.row.id, first.token]), true);
    const slot = (await q(db, 'select * from transcription_batches where id=$1', [context.id]))[0];
    assert.equal(slot.slot_operation_id, first.row.id); assert.equal(slot.slot_worker_token, first.token);
    assert.equal((await claim()).row, undefined);
    assert.equal(await checkpoint(first.row.id, first.token), true); assert.equal((await finalize(first.row.id, first.token)).completed, true);
    const next = await claim(); assert.ok(next.row); assert.notEqual(next.row.id, first.row.id);
    assert.equal(await value(db, "select count(*)::int as value from transcription_operations where batch_id=$1 and status in ('running','finalizing')", [context.id]), 1);
  });

  await scenario('expired shared lease reclaims the saved checkpoint and fences every old worker action', async () => {
    const context = await ready(await batch()); await start(context); const first = await claim();
    assert.equal(await checkpoint(first.row.id, first.token), true);
    await q(db, "update transcription_operations set locked_at=now()-interval '11 minutes' where id=$1", [first.row.id]);
    await q(db, "update transcription_batches set slot_locked_at=now()-interval '11 minutes' where id=$1", [context.id]);
    assert.equal(await value(db, 'select renew_transcription_operation_lease($1,$2) as value', [first.row.id, first.token]), false);
    const second = await claim(); assert.equal(second.row.id, first.row.id); assert.equal(second.row.status, 'finalizing');
    assert.deepEqual(second.row.checkpoint_segments, [{ start: 20, end: 20.2, text: 'synthetic response' }]);
    assert.equal(await checkpoint(first.row.id, first.token), false);
    assert.equal((await finalize(first.row.id, first.token)).completed, false);
    assert.equal((await fail(first.row.id, first.token)).updated, false);
    assert.equal(await value(db, 'select release_transcription_operation_lease($1,$2,$3) as value', [first.row.id, first.token, 0]), false);
    assert.equal((await finalize(second.row.id, second.token)).completed, true);
    assert.equal((await finalize(second.row.id, second.token)).completed, false);
    assert.equal(await value(db, 'select count(*)::int as value from transcription_logs where user_id=$1', [context.owner]), 1);
    assert.equal(await balance(context.owner), 48);
  });

  await scenario('lease release clears only its owned slot and preserves the reservation', async () => {
    const context = await ready(await batch()); await start(context); const first = await claim();
    assert.equal(await value(db, 'select release_transcription_operation_lease($1,$2,$3) as value', [first.row.id, first.token, 30]), true);
    assert.equal((await q(db, 'select slot_operation_id from transcription_batches where id=$1', [context.id]))[0].slot_operation_id, null);
    assert.equal(await balance(context.owner), 48);
    assert.equal(await checkpoint(first.row.id, first.token), false);
    assert.ok((await claim()).row);
  });

  await scenario('batch ownership is enforced by reads and every mutating entry point', async () => {
    const context = await ready(await batch()), other = await user();
    assert.equal(await detail(context, other), null);
    assert.deepEqual(await value(db, 'select list_transcription_batches($1) as value', [other]), []);
    await rejected(() => value(db, 'select start_transcription_batch($1,$2,$3,$4) as value', [other, context.id, randomUUID(), 2]), 'TB404');
    await rejected(() => value(db, 'select cancel_transcription_batch($1,$2) as value', [other, context.id]), 'TB404');
    await rejected(() => value(db, 'select retry_transcription_batch_item($1,$2,$3,$4) as value', [other, context.id, context.items[0].id, randomUUID()]), 'TB404');
    await rejected(() => q(db, 'select * from stage_transcription_batch_item($1,$2,$3,$4,$5,$6,$7,$8)', [other, context.id, context.items[0].id, hash, 'same.wav', 'audio/wav', 100, 60]), 'TB404');
    assert.equal(await balance(context.owner), 50); assert.equal(await balance(other), 50);
  });

  await scenario('failed-only retry is stable within an attempt and accepts a distinct second attempt', async () => {
    const context = await ready(await batch()); await start(context);
    const completed = await claim(); await checkpoint(completed.row.id, completed.token); await finalize(completed.row.id, completed.token);
    const failed = await claim(); await fail(failed.row.id, failed.token);
    const index = context.items.findIndex(item => item.current_operation_id === failed.row.id);
    const completeIndex = 1 - index, request = randomUUID();
    await rejected(() => retry(context, completeIndex, randomUUID()), 'TB409');
    assert.equal(await retry(context, index, request), true); assert.equal(await retry(context, index, request), false);
    assert.equal((await detail(context)).items[index].attemptIndex, 1);
    await rejected(() => stage(context, index, { fingerprint: 'a'.repeat(64) }), 'TB409');
    await stage(context, index); await start(context, randomUUID(), db, 1);
    const failedAgain = await claim(); assert.notEqual(failedAgain.row.id, failed.row.id); await fail(failedAgain.row.id, failedAgain.token);
    assert.equal(await retry(context, index, randomUUID()), true);
    assert.equal((await detail(context)).items[index].attemptIndex, 2);
    await stage(context, index); await start(context, randomUUID(), db, 1);
    const final = await claim(); await checkpoint(final.row.id, final.token); await finalize(final.row.id, final.token);
    const data = await detail(context);
    assert.equal(data.status, 'completed'); assert.equal(data.items[completeIndex].operationId, completed.row.id);
    assert.equal(data.creditsUsed, 2); assert.equal(data.creditsReserved, 0); assert.equal(data.creditsRestored, 2);
    assert.equal(await balance(context.owner), 48);
    assert.equal(await value(db, 'select count(*)::int as value from transcription_logs where user_id=$1', [context.owner]), 2);
  });

  await scenario('cancel versus checkpointed completion settles once without a deadlock', async () => {
    const context = await ready(await batch()); await start(context); const worker = await claim(); await checkpoint(worker.row.id, worker.token);
    await Promise.all([finalize(worker.row.id, worker.token, a), cancel(context, b)]);
    const data = await detail(context), completed = data.items.filter(item => item.status === 'completed').length;
    assert.ok([0, 1].includes(completed)); assert.ok(data.items.every(item => ['completed', 'cancelled'].includes(item.status)));
    assert.equal(await balance(context.owner), 50 - completed);
    assert.equal(await value(db, "select count(*)::int as value from credit_allocations where user_id=$1 and state='reserved'", [context.owner]), 0);
    assert.equal(await value(db, 'select count(*)::int as value from transcription_logs where user_id=$1', [context.owner]), completed);
    assert.equal(await cancel(context), false); assert.equal(await checkpoint(worker.row.id, worker.token), false);
  });

  await scenario('expired FEFO allocations are not revived by batch cancellation', async () => {
    const owner = await user(0), lots = [];
    for (const [index, amount] of [3, 10].entries()) {
      const order = `qa-batch-${randomUUID()}`;
      await q(db, "insert into payment_orders(order_id,user_id,plan_id,plan_name,amount,credits,status) values($1,$2,'fixture','fixture',1000,$3,'paid')", [order, owner, amount]);
      lots.push(await value(db, "insert into credit_lots(user_id,source,payment_order_id,granted,available,expires_at) values($1,'payment',$2,$3,$3,now()+($4::text)::interval) returning id as value", [owner, order, amount, index ? '1 year' : '1 hour']));
    }
    await q(db, 'update profiles set credits=13 where id=$1', [owner]);
    const context = await ready(await batch({ owner, durations: [120, 120] })); await start(context);
    assert.equal(await value(db, 'select reserved as value from credit_lots where id=$1', [lots[0]]), 3);
    assert.equal(await value(db, 'select reserved as value from credit_lots where id=$1', [lots[1]]), 1);
    await q(db, "update credit_lots set expires_at=now()-interval '1 second' where id=$1", [lots[0]]);
    await cancel(context); assert.equal(await balance(owner), 10);
    assert.equal(await value(db, 'select available+reserved as value from credit_lots where id=$1', [lots[0]]), 0);
    assert.equal(await value(db, 'select available+reserved as value from credit_lots where id=$1', [lots[1]]), 10);
  });

  await scenario('batch expiry cancels queued siblings while allowing its leased result to settle', async () => {
    const context = await ready(await batch()); await start(context); const worker = await claim();
    await q(db, "update transcription_batches set expires_at=now()-interval '1 second' where id=$1", [context.id]);
    await value(db, 'select expire_transcription_batches() as value');
    assert.equal((await claim()).row, undefined);
    assert.equal(await checkpoint(worker.row.id, worker.token), true); assert.equal((await finalize(worker.row.id, worker.token)).completed, true);
    await value(db, 'select expire_transcription_batches() as value');
    assert.deepEqual((await detail(context)).items.map(item => item.status).sort(), ['cancelled', 'completed']);
    assert.equal(await balance(context.owner), 49);
    assert.equal(await value(db, 'select transcription_active_group_count($1) as value', [context.owner]), 0);
  });

  await scenario('shared slot is per batch and does not accidentally serialize every ordinary job', async () => {
    const context = await ready(await batch()); await start(context);
    const single = await ordinary(context.owner);
    await q(db, 'select * from queue_transcription_operation($1,$2,$3,$4)', [single, context.owner, JSON.stringify(manifest(context.owner, single)), 1]);
    const first = await claim(); assert.equal(first.row.batch_id, context.id);
    const second = await claim(); assert.equal(second.row.id, single); assert.equal(second.row.batch_id, null);
    assert.equal((await claim()).row, undefined);
  });

  await scenario('legacy cancellation concurrent with batch start follows one lock order', async () => {
    for (let round = 0; round < 4; round++) {
      const owner = await user(), single = await ordinary(owner);
      await q(db, 'select * from queue_transcription_operation($1,$2,$3,$4)', [single, owner, JSON.stringify(manifest(owner, single)), 1]);
      const context = await ready(await batch({ owner }));
      await Promise.all([start(context, randomUUID(), a), q(b, 'select * from cancel_transcription_operation($1,$2)', [single, owner])]);
      assert.equal(await balance(owner), 48);
      assert.ok((await detail(context)).items.every(item => item.status === 'queued'));
      await cancel(context);
    }
  });

  await scenario('empty recognized result retains full billable duration and exposes review metadata', async () => {
    const context = await ready(await batch({ count: 1, durations: [600.25] })); await start(context); const worker = await claim();
    assert.equal(await checkpoint(worker.row.id, worker.token, []), true); assert.equal((await finalize(worker.row.id, worker.token)).completed, true);
    const data = await detail(context);
    assert.equal(data.items[0].durationSeconds, 600.25); assert.equal(data.items[0].recognitionStatus, 'no_speech'); assert.equal(data.items[0].needsReview, true);
    assert.equal(data.creditsUsed, 11); assert.equal(await balance(context.owner), 39);
    const before = await allocations(context.owner);
    for (let index = 0; index < 3; index++) { await detail(context); await value(db, 'select list_transcription_batches($1) as value', [context.owner]); }
    assert.equal(await allocations(context.owner), before); assert.equal(await balance(context.owner), 39);
  });

  const migrationAfter = createHash('sha256').update(readFileSync(migration)).digest('hex');
  assert.equal(migrationAfter, migrationBefore, 'migration changed during independent QA; rerun after freeze');
  const report = { passed: checks.length, failed: 0, node: process.version, postgres: await value(db, 'select version() as value'),
    migrationSha256: migrationAfter, sourceUnchanged: true,
    scope: 'full migration replay in disposable loopback-only fixture database; SQL synthetic data only',
    realProviderCalls: 0, productionDatabaseConnections: 0, checks };
  if (process.env.BATCH_QA_REPORT) writeFileSync(process.env.BATCH_QA_REPORT, JSON.stringify(report, null, 2));
  console.log('TOTAL', checks.length);
}

main().catch(error => { console.error('FAIL', error.code || error.name, error.message); process.exitCode = 1; }).finally(async () => {
  for (const client of peers) await client.end().catch(() => {});
  if (db) await db.close().catch(error => { console.error('QA cleanup failed', error.code || error.name); process.exitCode = 1; });
});
