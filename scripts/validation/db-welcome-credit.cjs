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
  const claimIdentity = async (user, options = {}) => (await q(
    'select * from claim_welcome_credit_identity($1,$2,$3)', [
      user.userId, [user.identity], options.emailConfirmed ?? true,
    ],
  ))[0];
  const claimIp = async (user, ip, account = hash('f'), options = {}) => (await q(
    'select * from claim_welcome_credit_ip($1,$2,$3,$4,$5)', [
      user.userId, [user.identity], options.emailConfirmed ?? true, ip, account,
    ],
  ))[0];
  const ipStatus = async (ip) => (await q(
    'select * from get_welcome_credit_ip_status($1)', [ip],
  ))[0];

  // Automatic identity-mode claims pay exactly once, preserve a prior manual
  // welcome grant, and never modify an existing paid or support balance.
  const identityMode = await createUser(freshIdentity());
  assert.equal((await claimIdentity(identityMode)).status, 'granted');
  assert.equal((await claimIdentity(identityMode)).status, 'already_granted');
  assert.equal((await q('select credits from profiles where id=$1', [identityMode.userId]))[0].credits, 10);
  assert.equal((await q("select count(*)::int as n from credit_lots where user_id=$1 and source='welcome'", [identityMode.userId]))[0].n, 1);

  const manualWelcome = await createUser(freshIdentity());
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'welcome',10,10)", [manualWelcome.userId]);
  await q('update profiles set credits=10 where id=$1', [manualWelcome.userId]);
  const manualResult = await claimIdentity(manualWelcome);
  assert.equal(manualResult.status, 'already_granted');
  assert.equal(manualResult.credits, 10);
  assert.ok((await q('select granted_at from welcome_credit_eligibility where user_id=$1', [manualWelcome.userId]))[0].granted_at);
  assert.equal((await q("select count(*)::int as n from credit_lots where user_id=$1 and source='welcome'", [manualWelcome.userId]))[0].n, 1);

  const paidPending = await createUser(freshIdentity());
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'legacy',17,17)", [paidPending.userId]);
  await q('update profiles set credits=17 where id=$1', [paidPending.userId]);
  assert.deepEqual(await claimIdentity(paidPending), { status: 'granted', credits: 27 });

  const adjustmentPending = await createUser(freshIdentity());
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'adjustment',5,5)", [adjustmentPending.userId]);
  await q('update profiles set credits=5 where id=$1', [adjustmentPending.userId]);
  assert.deepEqual(await claimIdentity(adjustmentPending), { status: 'granted', credits: 15 });
  assert.equal((await q('select sum(available)::int as n from credit_lots where user_id=$1', [adjustmentPending.userId]))[0].n, 15);

  const unconfirmedIdentity = await createUser(freshIdentity());
  await assert.rejects(() => claimIdentity(unconfirmedIdentity, { emailConfirmed: false }), (error) => error.code === 'WC004');

  // IP mode applies the rolling window without CAPTCHA while preserving existing balances.
  const ipModeIp = hash('d');
  const ipModeFirst = await createUser(freshIdentity());
  assert.deepEqual(await claimIp(ipModeFirst, ipModeIp, hash('3')), { status: 'granted', credits: 10, retry_at: null });
  const ipModeBlocked = await createUser(freshIdentity());
  assert.equal(ipModeBlocked.userId === ipModeFirst.userId, false);
  assert.equal(ipModeBlocked.profile.credits, 0);
  assert.equal((await q('select credits from profiles where id=$1', [ipModeBlocked.userId]))[0].credits, 0);
  const ipModeLimit = await claimIp(ipModeBlocked, ipModeIp, hash('4'));
  assert.equal(ipModeLimit.status, 'ip_limit');
  assert.ok(ipModeLimit.retry_at);
  assert.equal((await ipStatus(ipModeIp)).status, 'ip_limit');
  assert.equal((await q('select credits from profiles where id=$1', [ipModeBlocked.userId]))[0].credits, 0);
  assert.equal((await q('select count(*)::int as n from credit_lots where user_id=$1', [ipModeBlocked.userId]))[0].n, 0);

  const differentIp = await createUser(freshIdentity());
  assert.equal((await claimIp(differentIp, hash('3'), hash('5'))).status, 'granted');

  await q("update welcome_credit_ip_grants set granted_at=now()-interval '24 hours' where ip_hash=$1", [ipModeIp]);
  assert.equal((await ipStatus(ipModeIp)).status, 'ready');
  assert.equal((await claimIp(ipModeBlocked, ipModeIp, hash('4'))).status, 'granted');

  const ipUnconfirmed = await createUser(freshIdentity());
  await assert.rejects(() => claimIp(ipUnconfirmed, hash('4'), hash('5'), { emailConfirmed: false }), (error) => error.code === 'WC004');

  const ipManualWelcome = await createUser(freshIdentity());
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'welcome',10,10)", [ipManualWelcome.userId]);
  await q('update profiles set credits=10 where id=$1', [ipManualWelcome.userId]);
  assert.deepEqual(await claimIp(ipManualWelcome, hash('5'), hash('6')), { status: 'already_granted', credits: 10, retry_at: null });
  assert.equal((await q('select count(*)::int as n from welcome_credit_ip_grants where account_hash=$1', [hash('6')]))[0].n, 0);

  const ipPaid = await createUser(freshIdentity());
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'legacy',17,17)", [ipPaid.userId]);
  await q('update profiles set credits=17 where id=$1', [ipPaid.userId]);
  assert.deepEqual(await claimIp(ipPaid, hash('6'), hash('7')), { status: 'granted', credits: 27, retry_at: null });

  const ipAdjustment = await createUser(freshIdentity());
  await q("insert into credit_lots(user_id,source,granted,available) values($1,'adjustment',5,5)", [ipAdjustment.userId]);
  await q('update profiles set credits=5 where id=$1', [ipAdjustment.userId]);
  assert.deepEqual(await claimIp(ipAdjustment, hash('7'), hash('8')), { status: 'granted', credits: 15, retry_at: null });
  assert.equal((await q('select sum(available)::int as n from credit_lots where user_id=$1', [ipAdjustment.userId]))[0].n, 15);

  // Duplicate identities terminate pending eligibility rather than creating an endless retry.
  const duplicateIpIdentity = freshIdentity();
  const ipIdentityOwner = await createUser(duplicateIpIdentity);
  const ipIdentityDuplicate = await createUser(duplicateIpIdentity);
  assert.equal((await claimIp(ipIdentityOwner, hash('b'), hash('9'))).status, 'granted');
  assert.equal((await claimIp(ipIdentityDuplicate, hash('5'), hash('a'))).status, 'identity_claimed');
  assert.equal((await q('select count(*)::int as n from welcome_credit_eligibility where user_id=$1', [ipIdentityDuplicate.userId]))[0].n, 0);
  assert.equal((await q('select credits from profiles where id=$1', [ipIdentityDuplicate.userId]))[0].credits, 0);
  assert.equal((await q("select count(*)::int as n from credit_lots where user_id=$1 and source='welcome'", [ipIdentityDuplicate.userId]))[0].n, 0);

  // Distinct accounts racing from one network serialize to one grant.
  const ipRace = hash('0');
  const ipRaceA = await createUser(freshIdentity());
  const ipRaceB = await createUser(freshIdentity());
  const [ipRaceResultA, ipRaceResultB] = await Promise.all([
    q('select * from claim_welcome_credit_ip($1,$2,true,$3,$4)', [ipRaceA.userId, [ipRaceA.identity], ipRace, hash('b')]),
    peer.query('select * from claim_welcome_credit_ip($1,$2,true,$3,$4)', [ipRaceB.userId, [ipRaceB.identity], ipRace, hash('c')]),
  ]);
  assert.deepEqual([ipRaceResultA[0].status, ipRaceResultB.rows[0].status].sort(), ['granted', 'ip_limit']);
  assert.equal((await q('select sum(credits)::int as n from profiles where id=any($1::uuid[])', [[ipRaceA.userId, ipRaceB.userId]]))[0].n, 10);

  const reusedIdentity = freshIdentity();
  const identityOwner = await createUser(reusedIdentity);
  const identityDuplicate = await createUser(reusedIdentity);
  assert.equal((await claimIdentity(identityOwner)).status, 'granted');
  assert.equal((await claimIdentity(identityDuplicate)).status, 'identity_claimed');
  assert.equal((await q('select count(*)::int as n from welcome_credit_eligibility where user_id=$1', [identityDuplicate.userId]))[0].n, 0);
  assert.equal((await q('select credits from profiles where id=$1', [identityDuplicate.userId]))[0].credits, 0);
  assert.equal((await q("select count(*)::int as n from credit_lots where user_id=$1 and source='welcome'", [identityDuplicate.userId]))[0].n, 0);

  const sameUserRetry = await createUser(freshIdentity());
  const retryPeer = await db.peer();
  const [retryA, retryB] = await Promise.all([
    q('select * from claim_welcome_credit_identity($1,$2,true)', [sameUserRetry.userId, [sameUserRetry.identity]]),
    retryPeer.query('select * from claim_welcome_credit_identity($1,$2,true)', [sameUserRetry.userId, [sameUserRetry.identity]]),
  ]);
  assert.deepEqual([retryA[0].status, retryB.rows[0].status].sort(), ['already_granted', 'granted']);
  assert.equal((await q("select count(*)::int as n from credit_lots where user_id=$1 and source='welcome'", [sameUserRetry.userId]))[0].n, 1);
  await retryPeer.end();

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
  await assert.rejects(() => q('select * from claim_welcome_credit_identity($1,$2,true)', [identityMode.userId, [identityMode.identity]]), (error) => error.code === '42501');
  await assert.rejects(() => q('select * from claim_welcome_credit_ip($1,$2,true,$3,$4)', [identityMode.userId, [identityMode.identity], hash('1'), hash('2')]), (error) => error.code === '42501');
  await db.exec('reset role');
  await peer.end();
  await db.close();
  console.log('PASS existing profile balance and eligibility preserved');
  console.log('PASS default identity claim, duplicate prevention, manual grant and paid-balance preservation');
  console.log('PASS email confirmation and same-user concurrent retries');
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
