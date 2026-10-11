// Synthetic local PostgreSQL 17 verification only. Never run against a live DB.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { boot } = require('./db-replay.cjs');

(async () => {
  const db = await boot();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const actor = randomUUID();
  let passed = 0, sequence = 0;
  const ok = label => { passed++; console.log(`PASS ${label}`); };
  const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
  const input = changes => ({
    channelId: null, channelName: `Synthetic channel ${++sequence}`, channelUrl: 'https://example.com/channel',
    category: 'general', country: 'KR', subscriberCount: 120000, email: `fixture${sequence}@example.com`,
    publicEmailSource: 'https://example.com/contact', consentStatus: 'granted',
    consentEvidence: 'Explicit promotional email consent in a separately recorded reply.',
    consentGrantedAt: new Date(Date.now() - 60_000).toISOString(), koreaVerified: true, koreaEvidence: '',
    channelCheckedAt: new Date().toISOString(), metadataSource: 'manual', ...changes,
  });
  const save = async (data, existing = null) => q('select * from outreach_save_contacts($1,$2,$3)', [JSON.stringify(Array.isArray(data) ? data : [data]), actor, existing]);
  const contact = async changes => (await save(input(changes)))[0];
  const campaign = async contacts => (await q('select * from outreach_create_campaign($1,$2)', [JSON.stringify({ name: 'Synthetic campaign', subject: '(광고) {{channelName}} introduction', body: '{{channelName}} promotional service information.', contactIds: contacts.map(c => c.id) }), actor]))[0];
  const preview = async c => (await q('select outreach_preview_campaign($1) as result', [c.id])).at(0).result;
  const queue = async (c, options = {}) => {
    const p = await preview(c);
    const key = options.key || randomUUID();
    const result = (await q('select outreach_queue_campaign($1,$2,$3,$4) as result', [c.id, key, p.campaign.revision, options.scheduledAt || null]))[0].result;
    return { ...result, key, revision: p.campaign.revision };
  };
  const start = c => q("select * from outreach_set_campaign_state($1,'start')", [c.id]);
  const claim = async (token = randomUUID(), limit = 25, interval = 60, peer = db) => {
    const row = (await peer.query('select * from outreach_claim_message($1,$2,$3)', [token, limit, interval])).rows[0];
    return row ? { ...row, token } : null;
  };
  const begin = async (m, tokenHash = hash(), limit = 25) => (await q('select * from outreach_begin_send($1,$2,$3,$4,60)', [m.id, m.token, tokenHash, limit]))[0];
  const finish = (m, status, code = null) => q('select outreach_finish_message($1,$2,$3,$4,$5) as ok', [m.id, m.token, status, code, `<outreach-${m.id}@pr-text.com>`]);
  const isolate = async () => {
    await q("update outreach_messages set status='skipped',worker_token=null,lease_expires_at=null where status in ('pending','claimed','sending')");
    await q("update outreach_campaigns set status='paused' where status in ('running','queued')");
    await q("update outreach_dispatch_state set active_message_id=null,active_worker_token=null,lease_expires_at=null,next_allowed_at=now()-interval '1 second',daily_attempts=0,quota_day=(now() at time zone 'Asia/Seoul')::date");
  };
  try {
    assert.equal((await q('select outreach_database_status() as r'))[0].r.schemaVersion, 1);
    ok('all migrations replay and report outreach schema version');

    await db.query('set role authenticated');
    await assert.rejects(() => q('select * from outreach_contacts'), error => error.code === '42501');
    await assert.rejects(() => q('select outreach_database_status()'), error => error.code === '42501');
    await db.query('reset role');
    await db.query('set role anon');
    await assert.rejects(() => q('select * from outreach_messages'), error => error.code === '42501');
    await assert.rejects(() => q('select outreach_unsubscribe($1)', [hash()]), error => error.code === '42501');
    await db.query('reset role');
    assert.equal((await q("select count(*)::int n from pg_class where relname like 'outreach_%' and relkind='r' and not relrowsecurity"))[0].n, 0);
    assert.equal((await q("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'outreach_%' and p.prosecdef"))[0].n, 0);
    ok('anon/authenticated table and RPC access denied, all RLS on, no definer bypass');

    await db.query('set role service_role');
    assert.equal((await q('select outreach_database_status() as r'))[0].r.schemaVersion, 1);
    await db.query('reset role');
    ok('explicit service role grants survive changed platform defaults');

    const firstBatch = input();
    await assert.rejects(() => save([firstBatch, { ...input(), email: firstBatch.email }]), error => error.code === '23505');
    assert.equal((await q('select count(*)::int n from outreach_contacts where email=$1', [firstBatch.email]))[0].n, 0);
    await assert.rejects(() => save([input(), { ...input(), consentStatus: 'granted', consentEvidence: '' }]), error => error.code === 'OM001');
    assert.equal((await q('select count(*)::int n from outreach_contacts'))[0].n, 0);
    ok('duplicate and invalid batches rollback all contact inserts');

    const fresh = await contact();
    const noConsent = await contact({ consentStatus: 'unknown', consentEvidence: '', consentGrantedAt: null });
    const foreign = await contact({ country: 'US', koreaVerified: true });
    const hidden = await contact({ subscriberCount: null });
    const unchecked = await contact({ country: '', koreaVerified: false });
    const old = await contact({ channelCheckedAt: new Date(Date.now() - 31 * 86400000).toISOString() });
    const eligibility = await campaign([fresh, noConsent, foreign, hidden, unchecked, old]);
    const reasons = (await preview(eligibility)).recipients.map(r => r.reason);
    assert.deepEqual(reasons, [null, 'consent_required', 'foreign_channel', 'subscribers_unverified', 'korea_unverified', 'channel_check_expired']);
    await q("update outreach_contacts set consent_granted_at=now()+interval '4 minutes' where id=$1", [fresh.id]);
    assert.equal((await q('select outreach_contact_block_reason($1) as r', [fresh.id]))[0].r, 'consent_required');
    await q("update outreach_contacts set consent_granted_at=now()-interval '1 minute' where id=$1", [fresh.id]);
    await assert.rejects(() => save(input({ consentGrantedAt: new Date(Date.now() + 4 * 60_000).toISOString() })), error => error.code === 'OM001');
    ok('eligibility blocks missing consent, foreign/unknown/hidden/expired metadata and future consent');

    const queued = await queue(eligibility);
    assert.equal(queued.queuedCount, 1); assert.equal(queued.excluded.length, 5);
    const retry = (await q('select outreach_queue_campaign($1,$2,$3,null) as r', [eligibility.id, queued.key, queued.revision]))[0].r;
    assert.equal(retry.alreadyQueued, true);
    assert.equal((await q('select count(*)::int n from outreach_messages where campaign_id=$1', [eligibility.id]))[0].n, 1);
    assert.equal(await claim(), null);
    ok('queue snapshots eligible contacts once and unscheduled queue does not send before start');

    const snapshot = (await q('select * from outreach_messages where campaign_id=$1', [eligibility.id]))[0];
    const renamed = { ...input(), channelName: 'Renamed after queue', email: fresh.email };
    await save(renamed, fresh.id);
    assert.equal((await q('select subject from outreach_messages where id=$1', [snapshot.id]))[0].subject, snapshot.subject);
    const retryAfterChange = (await q('select outreach_queue_campaign($1,$2,$3,null) as r', [eligibility.id, queued.key, queued.revision]))[0].r;
    assert.equal(retryAfterChange.alreadyQueued, true);
    ok('queued snapshots are immutable and response-loss retry precedes preview revalidation');

    await isolate();
    const changing = await contact(); const draft = await campaign([changing]);
    await assert.rejects(() => q('select outreach_queue_campaign($1,$2,1,null)', [draft.id, randomUUID()]), error => error.code === 'OM409');
    let p = await preview(draft);
    await save({ ...input(), email: changing.email, channelName: 'Changed preview channel' }, changing.id);
    await assert.rejects(() => q('select outreach_queue_campaign($1,$2,$3,null)', [draft.id, randomUUID(), p.campaign.revision]), error => error.code === 'OM409');
    p = await preview(draft);
    await q("insert into outreach_suppressions(email) values($1)", [changing.email]);
    await assert.rejects(() => q('select outreach_queue_campaign($1,$2,$3,null)', [draft.id, randomUUID(), p.campaign.revision]), error => error.code === 'OM409');
    ok('queue requires a preview and rejects contact/eligibility changes after it');

    const timeBoundary = await contact({ channelCheckedAt: new Date(Date.now() - 30 * 86400000 + 60_000).toISOString() });
    const timeDraft = await campaign([timeBoundary]); const timePreview = await preview(timeDraft);
    // A stored contact update also changes the fingerprint. Preview reason is
    // included so the same protection covers time-only eligibility transitions.
    await q("update outreach_contacts set channel_checked_at=now()-interval '31 days' where id=$1", [timeBoundary.id]);
    await assert.rejects(() => q('select outreach_queue_campaign($1,$2,$3,null)', [timeDraft.id, randomUUID(), timePreview.campaign.revision]), error => error.code === 'OM409');
    const deleted = await contact(); const missingDraft = await campaign([deleted]); await q('delete from outreach_contacts where id=$1', [deleted.id]);
    assert.equal((await preview(missingDraft)).recipients[0].reason, 'contact_missing');
    ok('expired and deleted recipients are explicit preview exclusions');

    await isolate();
    const scheduledContact = await contact(); const scheduled = await campaign([scheduledContact]);
    await queue(scheduled, { scheduledAt: new Date(Date.now() + 3600000).toISOString() });
    assert.equal(await claim(), null);
    await q("update outreach_campaigns set scheduled_at=now()-interval '1 second' where id=$1", [scheduled.id]);
    let m = await claim(); assert.equal(m.campaign_id, scheduled.id);
    assert.equal((await q('select status from outreach_campaigns where id=$1', [scheduled.id]))[0].status, 'running');
    assert.equal(await claim(), null);
    const wrong = { ...m, token: randomUUID() }; assert.equal(await begin(wrong), undefined);
    await begin(m); await finish(m, 'sent');
    assert.equal((await q('select status from outreach_campaigns where id=$1', [scheduled.id]))[0].status, 'completed');
    ok('reservation starts only when due and current lease fences other workers');

    await isolate();
    const revoked = await contact(); const revokedCampaign = await campaign([revoked]); await queue(revokedCampaign); await start(revokedCampaign);
    m = await claim(); await save({ ...input(), email: revoked.email, consentStatus: 'revoked' }, revoked.id);
    assert.equal(await begin(m), undefined);
    assert.equal((await q('select status from outreach_messages where id=$1', [m.id]))[0].status, 'skipped');
    assert.equal((await q('select status from outreach_campaigns where id=$1', [revokedCampaign.id]))[0].status, 'completed');
    ok('consent withdrawal immediately before begin skips and completes the last pending message');

    await isolate();
    const recent = await contact(); const uncertainCampaign = await campaign([recent]); await queue(uncertainCampaign); await start(uncertainCampaign);
    m = await claim(); await begin(m); await finish(m, 'uncertain', 'SMTP_SEND_UNCERTAIN');
    assert.equal((await q('select status from outreach_campaigns where id=$1', [uncertainCampaign.id]))[0].status, 'paused');
    const repeatCampaign = await campaign([recent]);
    assert.equal((await preview(repeatCampaign)).recipients[0].reason, 'recently_contacted');
    await assert.rejects(() => queue(repeatCampaign), error => error.code === 'OM409');
    await q("update outreach_messages set finished_at=now()-interval '31 days' where id=$1", [m.id]);
    assert.equal((await preview(repeatCampaign)).recipients[0].reason, null);
    ok('uncertain messages pause the campaign and block the same email across campaigns for 30 days');

    await isolate();
    const staleContact = await contact(); const staleCampaign = await campaign([staleContact]); await queue(staleCampaign); await start(staleCampaign);
    const stale = await claim();
    await q("update outreach_messages set lease_expires_at=now()-interval '1 second' where id=$1", [stale.id]);
    await q("update outreach_dispatch_state set lease_expires_at=now()-interval '1 second' where singleton");
    const reclaimed = await claim(); assert.equal(reclaimed.id, stale.id); assert.notEqual(reclaimed.token, stale.token);
    assert.equal(await begin(stale), undefined);
    await begin(reclaimed);
    await q("update outreach_dispatch_state set lease_expires_at=now()-interval '1 second' where singleton");
    await q('select outreach_recover_dispatch()');
    assert.equal((await q('select status from outreach_messages where id=$1', [stale.id]))[0].status, 'uncertain');
    assert.equal((await finish(reclaimed, 'sent'))[0].ok, false); assert.equal(await claim(), null);
    ok('stale pre-SMTP claims resume, stale sending becomes uncertain and stale completion is fenced');

    await isolate();
    const unsubContact = await contact(); const firstCampaign = await campaign([unsubContact]); await queue(firstCampaign); await start(firstCampaign);
    m = await claim(); const tokenHash = hash(); await begin(m, tokenHash); await finish(m, 'sent');
    await q("update outreach_messages set finished_at=now()-interval '31 days' where id=$1", [m.id]);
    await q("update outreach_dispatch_state set next_allowed_at=now()-interval '1 second'");
    const secondCampaign = await campaign([unsubContact]); await queue(secondCampaign); await start(secondCampaign); const second = await claim();
    assert.equal((await q('select outreach_unsubscribe($1) as ok', [tokenHash]))[0].ok, true);
    assert.equal((await q('select outreach_unsubscribe($1) as ok', [tokenHash]))[0].ok, true);
    assert.equal(await begin(second), undefined);
    assert.equal((await q('select status from outreach_campaigns where id=$1', [secondCampaign.id]))[0].status, 'completed');
    assert.equal((await q('select consent_status from outreach_contacts where id=$1', [unsubContact.id]))[0].consent_status, 'revoked');
    ok('unsubscribe before begin is repeatable, clears a claim and blocks future messages');

    await isolate();
    const inFlightContact = await contact(); const inFlightCampaign = await campaign([inFlightContact]); await queue(inFlightCampaign); await start(inFlightCampaign);
    m = await claim(); const inFlightHash = hash(); await begin(m, inFlightHash);
    await q('select outreach_unsubscribe($1)', [inFlightHash]);
    assert.equal((await q('select status from outreach_messages where id=$1', [m.id]))[0].status, 'sending');
    assert.equal((await finish(m, 'sent'))[0].ok, true);
    ok('unsubscribe after begin preserves the already-started send without promising recall');

    await isolate();
    const parallelA = await contact(), parallelB = await contact(); const parallel = await campaign([parallelA, parallelB]); await queue(parallel); await start(parallel);
    const peerA = await db.peer(), peerB = await db.peer();
    try {
      await db.query('begin'); await db.query('select * from outreach_dispatch_state where singleton for update');
      assert.equal(await claim(randomUUID(), 25, 60, peerA), null);
      await db.query('commit');
      const claims = await Promise.all([claim(randomUUID(), 1, 60, peerA), claim(randomUUID(), 1, 60, peerB)]);
      assert.equal(claims.filter(Boolean).length, 1);
      m = claims.find(Boolean); await begin(m, hash(), 1); await finish(m, 'sent');
      assert.equal(await claim(randomUUID(), 25, 60, peerA), null);
      await q("update outreach_dispatch_state set next_allowed_at=now()-interval '1 second'");
      assert.equal(await claim(randomUUID(), 1, 60, peerB), null);
      assert.equal((await q('select daily_attempts from outreach_dispatch_state'))[0].daily_attempts, 1);
      await q("update outreach_dispatch_state set quota_day=((now() at time zone 'Asia/Seoul')::date)-1");
      assert.ok(await claim(randomUUID(), 1, 60, peerB));
    } finally { await peerA.end(); await peerB.end(); }
    await assert.rejects(() => claim(randomUUID(), 0, 60), error => error.code === 'OM001');
    await assert.rejects(() => claim(randomUUID(), 25, 59), error => error.code === 'OM001');
    ok('multiple workers obey one global claim, 60-second interval and Korea-day attempt limit');

    await isolate();
    const self = (await q('select * from outreach_queue_test($1,$2,$3)', ['(광고) Synthetic self test', 'Synthetic test body.', actor]))[0];
    assert.equal(self.email, 'codemeet@naver.com'); assert.equal(self.kind, 'test');
    m = await claim(); await begin(m); await finish(m, 'sent');
    assert.equal((await q('select daily_attempts from outreach_dispatch_state'))[0].daily_attempts, 1);
    await q("update outreach_dispatch_state set next_allowed_at=now()-interval '1 second'");
    await q("insert into outreach_suppressions(email) values('codemeet@naver.com') on conflict do nothing");
    await q('select * from outreach_queue_test($1,$2,$3)', ['(광고) Synthetic self test', 'Synthetic test body.', actor]);
    m = await claim(); assert.equal(await begin(m), undefined);
    ok('fixed self-test goes through the same queue, quota, interval and suppression guard');

    await isolate();
    const api = await contact({ metadataSource: 'youtube_api' }), manual = await contact();
    const apiCampaign = await campaign([api]); await queue(apiCampaign); await start(apiCampaign);
    m = await claim(); const persistentHash = hash(); await begin(m, persistentHash); await finish(m, 'uncertain', 'SMTP_SEND_UNCERTAIN');
    await q("update outreach_contacts set channel_checked_at=now()-interval '31 days' where id=any($1::uuid[])", [[api.id, manual.id]]);
    await q("update outreach_messages set channel_checked_at=now()-interval '31 days' where id=$1", [m.id]);
    const expired = (await q('select outreach_expire_api_metadata() as r'))[0].r;
    assert.equal(expired.contactsExpired, 1); assert.equal(expired.snapshotsExpired, 1);
    const expiredContact = (await q('select * from outreach_contacts where id=$1', [api.id]))[0];
    const expiredMessage = (await q('select * from outreach_messages where id=$1', [m.id]))[0];
    assert.equal(expiredContact.channel_name, null); assert.equal(expiredContact.subscriber_count, null);
    assert.equal(expiredContact.email, api.email); assert.equal(expiredContact.consent_status, 'granted');
    assert.equal(expiredMessage.subject, null); assert.equal(expiredMessage.body, null); assert.equal(expiredMessage.channel_name, null);
    assert.equal(expiredMessage.status, 'uncertain'); assert.equal(expiredMessage.unsubscribe_token_hash, persistentHash);
    assert.notEqual((await q('select channel_name from outreach_contacts where id=$1', [manual.id]))[0].channel_name, null);
    await save({ ...input(), channelName: null, channelId: null, channelUrl: '', country: '', subscriberCount: null, email: api.email,
      metadataSource: 'youtube_api', channelCheckedAt: null, koreaVerified: false, consentStatus: 'revoked' }, api.id);
    assert.equal((await q('select consent_status from outreach_contacts where id=$1', [api.id]))[0].consent_status, 'revoked');
    await assert.rejects(() => save({ ...input(), email: api.email, metadataSource: 'manual' }, api.id), error => error.code === 'OM409');
    await q('delete from outreach_contacts where id=$1', [api.id]);
    assert.equal((await q('select contact_id from outreach_messages where id=$1', [m.id]))[0].contact_id, null);
    ok('30-day API cleanup erases derived metadata/snapshots while preserving consent, suppression token and uncertainty');

    console.log('TOTAL', passed);
  } finally { await db.close(); }
})().catch(error => { console.error('FAIL', error.code || error.name, error.message); process.exitCode = 1; });
