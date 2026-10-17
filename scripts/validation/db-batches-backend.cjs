const { boot } = require('./db-replay.cjs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

(async () => {
  const db = await boot();
  const q = async (sql, params = [], client = db) => (await client.query(sql, params)).rows;
  let passed = 0;
  const ok = (name) => { passed++; console.log('PASS ' + name); };
  const fingerprint = 'a'.repeat(64);
  const manifest = (user, id) => JSON.stringify([{ path: `${user}/${id}/0000`, bytes: 100, sha256: fingerprint }]);
  async function user(credits = 100) {
    const id = randomUUID();
    await q('insert into profiles(id,credits) values($1,$2)', [id, credits]);
    await q("insert into credit_lots(user_id,source,granted,available) values($1,'legacy',$2,$2)", [id, credits]);
    return id;
  }
  async function batch(owner, count = 2, key = randomUUID()) {
    const files = Array.from({ length: count }, (_, index) => ({ clientId: randomUUID(), filename: `track-${index}.wav`, label: `Track ${index + 1}` }));
    const id = (await q('select create_transcription_batch($1,$2,$3,$4,$5) id', [owner, key, fingerprint, 'ko', JSON.stringify(files)]))[0].id;
    return { owner, key, id, files, items: (await get({ owner, id })).items };
  }
  async function get(b) { return (await q('select get_transcription_batch($1,$2) batch', [b.owner, b.id]))[0].batch; }
  async function stage(b, index = 0, duration = 120, hash = fingerprint) {
    const item = b.items[index];
    const o = (await q('select * from stage_transcription_batch_item($1,$2,$3,$4,$5,$6,$7,$8)', [b.owner, b.id, item.id, hash, item.filename, 'audio/wav', 100, duration]))[0];
    await q('select complete_transcription_batch_upload($1,$2,$3,$4,$5)', [b.owner, b.id, item.id, o.operation_id, manifest(b.owner, o.operation_id)]);
    return o.operation_id;
  }
  async function start(b, cost = 4, request = randomUUID()) { return q('select start_transcription_batch($1,$2,$3,$4) started', [b.owner, b.id, request, cost]); }
  async function cancel(b) { await q('select cancel_transcription_batch($1,$2)', [b.owner, b.id]); }
  async function balance(owner) { return (await q('select credits from profiles where id=$1', [owner]))[0].credits; }
  async function claim(token = randomUUID(), client = db) { return (await q('select * from claim_transcription_operation($1)', [token], client))[0]; }
  async function finish(o, token, segments = []) {
    assert.equal((await q('select checkpoint_transcription_operation($1,$2,$3,$4,$5,$6) changed', [o.id, token, '', JSON.stringify(segments), 'ko', '{}']))[0].changed, true);
    assert.equal((await q('select * from finalize_transcription_operation($1,$2)', [o.id, token]))[0].completed, true);
  }
  try {
    const owner = await user(), b = await batch(owner, 5);
    assert.deepEqual(b.items.map(i => i.order), [0, 1, 2, 3, 4]);
    assert.equal((await q('select create_transcription_batch($1,$2,$3,$4,$5) id', [owner, b.key, fingerprint, 'ko', JSON.stringify(b.files)]))[0].id, b.id);
    await assert.rejects(() => q('select create_transcription_batch($1,$2,$3,$4,$5)', [owner, b.key, 'b'.repeat(64), 'ko', JSON.stringify(b.files)]), e => e.code === 'TB409');
    ok('stable batch identity retains five ordered labels and rejects a changed fingerprint');
    for (let index = 0; index < 5; index++) await stage(b, index);
    assert.equal((await get(b)).totalCredits, 10);
    assert.equal(await balance(owner), 100);
    assert.equal((await q('select count(*)::int n from credit_allocations where user_id=$1', [owner]))[0].n, 0);
    ok('staging quotes per-file full duration without reserving credits');
    const request = randomUUID();
    await start(b, 10, request); await start(b, 10, request);
    assert.equal(await balance(owner), 90);
    assert.equal((await q('select count(*)::int n from credit_allocations where user_id=$1', [owner]))[0].n, 5);
    ok('whole-batch start reserves only child operation allocations once');
    const peer = await db.peer(), token = randomUUID(), token2 = randomUUID();
    const claims = await Promise.all([claim(token), claim(token2, peer)]);
    await peer.end();
    const active = claims.find(Boolean), activeToken = claims[0] ? token : token2;
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await claim()), undefined);
    ok('two database connections share one batch slot');
    await finish(active, activeToken);
    assert.equal((await get(b)).items.find(i => i.operationId === active.id).recognitionStatus, 'no_speech');
    assert.equal((await get(b)).items.find(i => i.operationId === active.id).needsReview, true);
    ok('empty recognized output completes with explicit review and releases the slot');
    const oldToken = randomUUID(), current = await claim(oldToken);
    await q("update transcription_operations set locked_at=now()-interval '11 minutes' where id=$1", [current.id]);
    await q("update transcription_batches set slot_locked_at=now()-interval '11 minutes' where id=$1", [b.id]);
    const newToken = randomUUID(), recovered = await claim(newToken);
    assert.equal(recovered.id, current.id);
    assert.equal((await q('select renew_transcription_operation_lease($1,$2) changed', [current.id, oldToken]))[0].changed, false);
    assert.equal((await q('select checkpoint_transcription_operation($1,$2,$3,$4,$5,$6) changed', [current.id, oldToken, '', '[]', 'ko', '{}']))[0].changed, false);
    assert.equal((await q('select release_transcription_operation_lease($1,$2,0) changed', [current.id, oldToken]))[0].changed, false);
    ok('reclaim resumes the same child and fences former heartbeat, checkpoint and release');
    await q('select * from fail_transcription_operation($1,$2,$3)', [current.id, newToken, 'synthetic failure']);
    await cancel(b);
    assert.equal(await balance(owner), 98);
    assert.equal((await get(b)).creditsUsed, 2);
    assert.equal((await get(b)).creditsRestored, 8);
    await cancel(b); assert.equal(await balance(owner), 98);
    ok('batch cancellation retains success and refunds valid child sources once');

    const poor = await batch(await user(3));
    await stage(poor, 0); await stage(poor, 1);
    await assert.rejects(() => start(poor), e => e.code === 'TB402');
    assert.equal(await balance(poor.owner), 3);
    assert.ok((await get(poor)).items.every(i => i.status === 'ready'));
    assert.equal((await q('select count(*)::int n from credit_allocations where user_id=$1', [poor.owner]))[0].n, 0);
    await cancel(poor); ok('insufficient second-file balance rolls back every earlier reservation');

    const invalid = await batch(await user());
    const invalidOps = [await stage(invalid, 0), await stage(invalid, 1)].sort();
    await q('update transcription_operations set storage_manifest=$2 where id=$1', [invalidOps[1], JSON.stringify([{ path: `${invalid.owner}/${invalidOps[1]}/0000`, bytes: 99, sha256: fingerprint }])]);
    await assert.rejects(() => start(invalid), e => e.code === 'TO001');
    assert.equal(await balance(invalid.owner), 100);
    assert.equal((await q('select count(*)::int n from credit_allocations where user_id=$1', [invalid.owner]))[0].n, 0);
    await cancel(invalid); ok('late manifest validation failure rolls back all queued children');

    const retryBatch = await batch(await user(), 1), retryOp = await stage(retryBatch);
    await start(retryBatch, 2);
    const retryToken = randomUUID(); assert.equal((await claim(retryToken)).id, retryOp);
    await q('select * from fail_transcription_operation($1,$2,$3)', [retryOp, retryToken, 'synthetic failure']);
    const retryRequest = randomUUID(), retryItem = retryBatch.items[0].id;
    await q('select retry_transcription_batch_item($1,$2,$3,$4)', [retryBatch.owner, retryBatch.id, retryItem, retryRequest]);
    await q('select retry_transcription_batch_item($1,$2,$3,$4)', [retryBatch.owner, retryBatch.id, retryItem, retryRequest]);
    assert.equal((await get(retryBatch)).items[0].attemptIndex, 1);
    await assert.rejects(() => stage(retryBatch, 0, 120, 'b'.repeat(64)), e => e.code === 'TB409');
    const retryOp2 = await stage(retryBatch); assert.notEqual(retryOp2, retryOp);
    assert.equal((await get(retryBatch)).totalCredits, 2);
    await start(retryBatch, 2);
    const doneToken = randomUUID(), done = await claim(doneToken); await finish(done, doneToken, [{ text: 'Synthetic', start: 3, end: 4 }]);
    await assert.rejects(() => q('select retry_transcription_batch_item($1,$2,$3,$4)', [retryBatch.owner, retryBatch.id, retryItem, randomUUID()]), e => e.code === 'TB409');
    ok('confirmed-failure retry preserves source identity and never reruns completed work');

    const guarded = await batch(await user(), 1), guardedOp = await stage(guarded);
    const key = (await q('select operation_key from transcription_operations where id=$1', [guardedOp]))[0].operation_key;
    await assert.rejects(() => q('select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8)', [guarded.owner, key, fingerprint, 'track.wav', 'audio/wav', 100, 'ko', 120]), e => e.code === 'TB409');
    await assert.rejects(() => q('select * from queue_transcription_operation($1,$2,$3,$4)', [guardedOp, guarded.owner, manifest(guarded.owner, guardedOp), 2]), e => e.code === 'TB409');
    await assert.rejects(() => q('select * from cancel_transcription_operation($1,$2)', [guardedOp, guarded.owner]), e => e.code === 'TB409');
    assert.equal(await claim(), undefined);
    await cancel(guarded); ok('generic create, queue, cancel and claim cannot bypass staged batch admission');

    const admissionUser = await user(), admission = await batch(admissionUser, 5);
    for (let n = 0; n < 2; n++) await q('select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8)', [admissionUser, randomUUID(), fingerprint, 'single.wav', 'audio/wav', 100, 'ko', 120]);
    await assert.rejects(() => q('select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8)', [admissionUser, randomUUID(), fingerprint, 'single.wav', 'audio/wav', 100, 'ko', 120]), e => e.code === 'TO429');
    await assert.rejects(() => batch(admissionUser), e => e.code === 'TB429');
    assert.equal((await q('select active_job_count from preview_account_deletion($1)', [admissionUser]))[0].active_job_count, 3);
    await assert.rejects(() => q('select * from begin_account_deletion($1,$2)', [admissionUser, fingerprint]), e => e.code === 'AD002');
    await cancel(admission); ok('one batch plus two singles fills admission and upload drafts block account deletion');

    const expired = await batch(await user(), 1);
    await q("update transcription_batches set expires_at=now()-interval '1 second' where id=$1", [expired.id]);
    await q('select expire_transcription_batches()');
    assert.equal((await get(expired)).status, 'cancelled');
    assert.equal((await q('select transcription_active_group_count($1) n', [expired.owner]))[0].n, 0);
    ok('batch expiry cleans items without an operation and releases admission');

    const draining = await batch(await user(), 2);
    await stage(draining, 0); await stage(draining, 1); await start(draining);
    const drainingToken = randomUUID(), inFlight = await claim(drainingToken);
    await q("update transcription_batches set expires_at=now()-interval '1 second' where id=$1", [draining.id]);
    await q('select expire_transcription_batches()');
    assert.equal((await q('select renew_transcription_operation_lease($1,$2) changed', [inFlight.id, drainingToken]))[0].changed, true);
    await finish(inFlight, drainingToken);
    assert.equal(await claim(), undefined);
    assert.deepEqual((await get(draining)).items.map(i => i.status).sort(), ['cancelled', 'completed']);
    assert.equal(await balance(draining.owner), 98);
    ok('expiry returns pending reservations while already-running speech can finish');

    const ownership = await batch(await user(), 1), stranger = await user();
    assert.equal((await q('select get_transcription_batch($1,$2) batch', [stranger, ownership.id]))[0].batch, null);
    await assert.rejects(() => q('select start_transcription_batch($1,$2,$3,$4)', [stranger, ownership.id, randomUUID(), 2]), e => e.code === 'TB404');
    await cancel(ownership); ok('batch reads and mutations retain owner checks');
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role);
      await assert.rejects(() => q('select * from transcription_batches'), e => e.code === '42501');
      await assert.rejects(() => q('select list_transcription_batches($1)', [owner]), e => e.code === '42501');
      await assert.rejects(() => q('select * from queue_transcription_operation_internal($1,$2,$3,$4)', [active.id, owner, manifest(owner, active.id), 2]), e => e.code === '42501');
      await db.exec('reset role');
    }
    ok('public API roles cannot access metadata or private ledger helpers');
    assert.equal((await q("select count(*)::int n from credit_lots where available<0 or reserved<0 or available+reserved>granted"))[0].n, 0);
    assert.equal((await q('select count(*)::int n from profiles p where p.credits<>(select coalesce(sum(available),0) from credit_lots l where l.user_id=p.id)'))[0].n, 0);
    ok('all synthetic batch flows preserve profile and source ledger invariants');
    console.log('TOTAL', passed);
  } finally { await db.close(); }
})().catch((error) => { console.error('FAIL', error.message, error.code || ''); process.exitCode = 1; });
