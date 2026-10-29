const { boot } = require('./db-replay.cjs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

(async () => {
  const db = await boot();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const user = randomUUID(), noCredits = randomUUID(), oldKey = randomUUID(), newKey = randomUUID();
  const files = [{ clientId: randomUUID(), filename: 'track.wav', label: 'Track' }];
  const hash = 'a'.repeat(64), grammarHash = 'b'.repeat(64), audioHash = 'c'.repeat(64);
  await q('insert into profiles(id,credits) values($1,30),($2,0)', [user, noCredits]);
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'legacy',30,30)", [user]);

  const oldRpc = (key) => q('select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8)',
    [user, key, hash, 'old.wav', 'audio/wav', 100, 'ko', 1]);
  const old = (await oldRpc(oldKey))[0];
  assert.ok(old?.operation_id);
  assert.equal((await q('select polish_mode from transcription_operations where id=$1', [old.operation_id]))[0].polish_mode, 'preserve');
  console.log('PASS old 8-argument RPC remains callable and defaults to preserve');

  const createGrammar = (mode = 'grammar', payloadHash = grammarHash) => q(
    'select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [user, newKey, payloadHash, 'grammar.wav', 'audio/wav', 100, 'ko', 1, mode]);
  const created = (await createGrammar())[0];
  assert.equal(created.status, 'staged');
  assert.equal((await q('select polish_mode from transcription_operations where id=$1', [created.operation_id]))[0].polish_mode, 'grammar');
  assert.equal((await createGrammar())[0].existing, true);
  await assert.rejects(() => createGrammar('preserve', grammarHash), error => error.code === 'TO409');
  console.log('PASS grammar mode persists, same-mode retries reuse, and changed mode conflicts');

  const batchKey = randomUUID();
  const batchId = (await q('select create_transcription_batch($1,$2,$3,$4,$5,$6) id',
    [user, batchKey, 'd'.repeat(64), 'ko', JSON.stringify(files), 'grammar']))[0].id;
  const batch = (await q('select get_transcription_batch($1,$2) result', [user, batchId]))[0].result;
  assert.equal(batch.polishMode, 'grammar');
  await assert.rejects(() => q('select create_transcription_batch($1,$2,$3,$4,$5,$6)',
    [user, batchKey, 'd'.repeat(64), 'ko', JSON.stringify(files), 'preserve']), error => error.code === 'TB409');
  const itemId = (await q('select id from transcription_batch_items where batch_id=$1', [batchId]))[0].id;
  const stageParams = [user, batchId, itemId, audioHash, 'track.wav', 'audio/wav', 100, 1];
  const firstStage = (await q('select * from stage_transcription_batch_item($1,$2,$3,$4,$5,$6,$7,$8)', stageParams))[0];
  assert.equal((await q('select polish_mode from transcription_operations where id=$1', [firstStage.operation_id]))[0].polish_mode, 'grammar');
  await q("update transcription_operations set status='failed' where id=$1", [firstStage.operation_id]);
  const retryId = randomUUID();
  await q('select retry_transcription_batch_item($1,$2,$3,$4)', [user, batchId, itemId, retryId]);
  await q('select * from stage_transcription_batch_item($1,$2,$3,$4,$5,$6,$7,$8)', stageParams);
  const retried = (await q('select current_operation_id from transcription_batch_items where id=$1', [itemId]))[0].current_operation_id;
  assert.notEqual(retried, firstStage.operation_id);
  assert.equal((await q('select polish_mode from transcription_operations where id=$1', [retried]))[0].polish_mode, 'grammar');
  assert.equal((await q('select get_transcription_batch($1,$2) result', [user, batchId]))[0].result.polishMode, 'grammar');
  console.log('PASS batch JSON, stage, retry, and recreated operation retain the batch mode');

  const jobId = randomUUID();
  const job = (await q('select * from enqueue_diarization_job($1,$2,$3,$4,$5,$6,$7)',
    [user, 'multi.wav', `${user}/${jobId}`, 'ko', 60, 1, 'grammar']))[0];
  assert.ok(job?.job_id);
  assert.equal((await q('select polish_mode from transcription_jobs where id=$1', [job.job_id]))[0].polish_mode, 'grammar');
  const rejectedJob = await q('select * from enqueue_diarization_job($1,$2,$3,$4,$5,$6,$7)',
    [noCredits, 'none.wav', `${noCredits}/${randomUUID()}`, 'ko', 60, 1, 'grammar']);
  assert.equal(rejectedJob.length, 0);
  console.log('PASS multi-speaker worker mode persists and insufficient-credit RPC returns zero rows');

  await db.exec('set role authenticated');
  await assert.rejects(() => q('select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [user, randomUUID(), hash, 'denied.wav', 'audio/wav', 100, 'ko', 1, 'grammar']), error => error.code === '42501');
  await assert.rejects(() => q('select * from transcription_operations'), error => error.code === '42501');
  await db.exec('reset role');
  console.log('PASS mode RPC and operation table remain unavailable to authenticated clients');
  await db.close();
})().catch(error => {
  console.error('FAIL', error.message, error.code);
  process.exit(1);
});
