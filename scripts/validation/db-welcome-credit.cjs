const { boot } = require('./db-replay.cjs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

(async () => {
  const db = await boot();
  const peer = await db.peer();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const hash = (char) => char.repeat(64);
  const freshIdentity = () => randomUUID().replaceAll('-', '').repeat(2);
  const createUser = async (identity, email = 'fixture@example.test') => {
    const userId = randomUUID();
    const profile = (await q('select * from ensure_welcome_credit_profile($1,$2,$3)', [
      userId, email, [identity],
    ]))[0];
    return { userId, profile, identity };
  };
  const prepare = async (user, ip, account) => (await q(
    'select * from prepare_welcome_credit_claim($1,$2,$3)', [user.userId, ip, account],
  ))[0];
  const claim = async (user, ip, account, options = {}) => (await q(
    'select * from claim_welcome_credit($1,$2,$3,$4,$5,$6,$7)', [
      user.userId, [user.identity], ip, account, options.emailConfirmed ?? true,
      options.nonce ?? null, options.turnstileValid ?? false,
    ],
  ))[0];

  // Existing profiles retain their balance and do not acquire retroactive eligibility.
  const existingId = randomUUID();
  await q('insert into profiles(id,email,credits) values($1,$2,37)', [existingId, 'existing@example.test']);
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'legacy',37,37)", [existingId]);
  const existing = (await q('select * from ensure_welcome_credit_profile($1,$2,$3)', [
    existingId, 'existing@example.test', [hash('a')],
  ]))[0];
  assert.equal(existing.credits, 37);
  assert.equal((await q('select count(*)::int as n from welcome_credit_eligibility where user_id=$1', [existingId]))[0].n, 0);

  const ip = hash('1');
  const a = await createUser(hash('2'));
  const b = await createUser(hash('3'));
  assert.equal(a.profile.credits, 0);
  assert.equal(b.profile.credits, 0);
  const firstAttempt = await prepare(a, ip, hash('4'));
  assert.equal(firstAttempt.reason, 'ready');
  assert.equal(firstAttempt.challenge_required, false);
  const secondAttempt = await prepare(b, ip, hash('5'));
  assert.equal(secondAttempt.challenge_required, true);
  assert.ok(secondAttempt.challenge_nonce);
  assert.equal((await claim(b, ip, hash('5'))).status, 'challenge_required');
  assert.equal((await claim(b, ip, hash('5'), {
    nonce: secondAttempt.challenge_nonce,
    turnstileValid: true,
  })).status, 'granted');
  assert.equal((await q('select credits from profiles where id=$1', [b.userId]))[0].credits, 10);
  assert.equal((await q('select count(*)::int as n from credit_lots where user_id=$1 and source=$2', [b.userId, 'welcome']))[0].n, 1);
  assert.equal((await claim(b, ip, hash('5'), {
    nonce: secondAttempt.challenge_nonce,
    turnstileValid: true,
  })).status, 'already_granted');

  const next = await createUser(hash('6'));
  const limited = await prepare(next, ip, hash('7'));
  assert.equal(limited.reason, 'ip_limit');
  assert.equal((await claim(next, ip, hash('7'), { turnstileValid: true, nonce: limited.challenge_nonce })).status, 'ip_limit');

  // The account remains blocked immediately before the exact 24-hour boundary,
  // then can claim after it when the same account has passed the repeat challenge.
  const boundaryIp = hash('2');
  const boundaryFirst = await createUser(freshIdentity());
  await prepare(boundaryFirst, boundaryIp, hash('4'));
  assert.equal((await claim(boundaryFirst, boundaryIp, hash('4'))).status, 'granted');
  const boundaryNext = await createUser(freshIdentity());
  assert.equal((await prepare(boundaryNext, boundaryIp, hash('6'))).reason, 'ip_limit');
  await q("update welcome_credit_ip_grants set granted_at=now()-interval '23 hours 59 minutes 59 seconds' where ip_hash=$1", [boundaryIp]);
  assert.equal((await prepare(boundaryNext, boundaryIp, hash('6'))).reason, 'ip_limit');
  await q("update welcome_credit_ip_grants set granted_at=now()-interval '24 hours 1 second' where ip_hash=$1", [boundaryIp]);
  const afterBoundary = await prepare(boundaryNext, boundaryIp, hash('6'));
  assert.equal(afterBoundary.reason, 'ready');
  assert.equal(afterBoundary.challenge_required, true);
  assert.equal((await claim(boundaryNext, boundaryIp, hash('6'), {
    nonce: afterBoundary.challenge_nonce,
    turnstileValid: true,
  })).status, 'granted');

  // A same-network account inside seven days needs a challenge; once the older
  // attempt is past the boundary, bounded cleanup makes it a first account again.
  const repeatIp = hash('7');
  const recentAttempt = await createUser(freshIdentity());
  await prepare(recentAttempt, repeatIp, hash('9'));
  await q("update welcome_credit_ip_attempts set first_attempt_at=now()-interval '7 days'+interval '1 second' where ip_hash=$1", [repeatIp]);
  const insideRepeat = await createUser(freshIdentity());
  assert.equal((await prepare(insideRepeat, repeatIp, hash('b'))).challenge_required, true);

  const expiredIp = hash('c');
  const expiredAttempt = await createUser(freshIdentity());
  await prepare(expiredAttempt, expiredIp, hash('e'));
  await q("update welcome_credit_ip_attempts set first_attempt_at=now()-interval '7 days 1 second' where ip_hash=$1", [expiredIp]);
  const outsideRepeat = await createUser(freshIdentity());
  const outsideBoundary = await prepare(outsideRepeat, expiredIp, hash('1'));
  assert.equal(outsideBoundary.challenge_required, false);
  assert.equal((await q('select count(*)::int as n from welcome_credit_ip_attempts where ip_hash=$1', [expiredIp]))[0].n, 1);

  const unconfirmed = await createUser(hash('8'));
  await prepare(unconfirmed, hash('8'), hash('9'));
  await assert.rejects(() => claim(unconfirmed, hash('8'), hash('9'), { emailConfirmed: false }), (error) => error.code === 'WC004');

  // Independent sessions racing from the same IP can only create one grant.
  const concurrentIp = hash('a');
  const c = await createUser(hash('b'));
  const d = await createUser(hash('c'));
  await prepare(c, concurrentIp, hash('d'));
  const da = await prepare(d, concurrentIp, hash('e'));
  const ca = await prepare(c, concurrentIp, hash('d'));
  const [cClaim, dClaim] = await Promise.all([
    db.query('select * from claim_welcome_credit($1,$2,$3,$4,true,$5,true)', [c.userId, [c.identity], concurrentIp, hash('d'), ca.challenge_nonce]),
    peer.query('select * from claim_welcome_credit($1,$2,$3,$4,true,$5,true)', [d.userId, [d.identity], concurrentIp, hash('e'), da.challenge_nonce]),
  ]);
  const results = [cClaim.rows[0].status, dClaim.rows[0].status].sort();
  assert.deepEqual(results, ['granted', 'ip_limit']);
  const sum = (await q('select sum(credits)::int as n from profiles where id=any($1::uuid[])', [[c.userId, d.userId]]))[0].n;
  assert.equal(sum, 10);

  // Profile and ledger are modified atomically if an identity insert conflicts.
  const conflict = await createUser(hash('f'));
  await prepare(conflict, hash('f'), hash('1'));
  await q("insert into welcome_credit_claims(benefit_code,identity_hash) values('welcome_10_minutes',$1)", [conflict.identity]);
  const conflictResult = await claim(conflict, hash('f'), hash('1'));
  assert.equal(conflictResult.status, 'identity_claimed');
  assert.equal((await q('select credits from profiles where id=$1', [conflict.userId]))[0].credits, 0);

  // Cleanup removes only expired rows and honors a short batch size.
  const cleanupIp = hash('e');
  await q("insert into welcome_credit_ip_attempts(ip_hash,account_hash,first_attempt_at) values($1,$2,now()-interval '8 days'),($1,$3,now()-interval '9 days'),($1,$4,now())", [cleanupIp, hash('1'), hash('2'), hash('3')]);
  await q("insert into welcome_credit_ip_grants(ip_hash,account_hash,granted_at) values($1,$2,now()-interval '8 days'),($1,$3,now()-interval '9 days'),($1,$4,now())", [cleanupIp, hash('4'), hash('5'), hash('6')]);
  const cleanup = (await q('select * from cleanup_welcome_credit_ip_records(1)'))[0];
  assert.equal(cleanup.attempts_deleted, 1);
  assert.equal(cleanup.grants_deleted, 1);
  assert.equal((await q('select count(*)::int as n from welcome_credit_ip_attempts where ip_hash=$1', [cleanupIp]))[0].n, 2);
  assert.equal((await q('select count(*)::int as n from welcome_credit_ip_grants where ip_hash=$1', [cleanupIp]))[0].n, 2);

  // Abuse records have no account FK: deletion removes eligibility but preserves
  // the rolling-rate evidence and the permanent identity marker.
  const deleted = await createUser(freshIdentity());
  const deleteIp = hash('8');
  await prepare(deleted, deleteIp, hash('9'));
  await claim(deleted, deleteIp, hash('9'));
  await q('delete from profiles where id=$1', [deleted.userId]);
  assert.equal((await q('select count(*)::int as n from welcome_credit_eligibility where user_id=$1', [deleted.userId]))[0].n, 0);
  assert.equal((await q('select count(*)::int as n from welcome_credit_ip_attempts where ip_hash=$1', [deleteIp]))[0].n, 1);
  assert.equal((await q('select count(*)::int as n from welcome_credit_ip_grants where ip_hash=$1', [deleteIp]))[0].n, 1);
  assert.equal((await q('select count(*)::int as n from welcome_credit_claims where identity_hash=$1', [deleted.identity]))[0].n, 1);

  await db.exec('set role authenticated');
  await assert.rejects(() => q('select * from welcome_credit_ip_attempts'), (error) => error.code === '42501');
  await assert.rejects(() => q('select * from claim_welcome_credit($1,$2,$3,$4,true)', [a.userId, [a.identity], hash('1'), hash('2')]), (error) => error.code === '42501');
  await db.exec('reset role');
  await peer.end();
  await db.close();
  console.log('PASS existing profile balance and eligibility preserved');
  console.log('PASS 0-minute setup, repeated-account challenge, identity and email protections');
  console.log('PASS rolling 24-hour limit survives successful challenge');
  console.log('PASS exact rolling 24-hour and seven-day boundaries');
  console.log('PASS bounded retention removes only expired rows');
  console.log('PASS account deletion preserves IP and permanent identity abuse markers');
  console.log('PASS concurrent same-IP claims grant exactly once');
  console.log('PASS browser roles cannot read abuse records or call claim RPC');
})().catch((error) => {
  console.error('FAIL', error.stack || error.message, error.code);
  process.exit(1);
});
