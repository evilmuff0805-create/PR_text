import { randomUUID } from 'node:crypto';
import { outreachStore } from './outreach-store.js';
import { createOutreachMailer } from './outreach-mail.js';
import { hashUnsubscribeToken, newUnsubscribeToken, readOutreachConfig } from './outreach-validation.js';

// A worker only resumes a claim made before SMTP. Once begin() marks sending,
// every loss/exception is uncertain; neither this process nor a successor resends it.
export function createOutreachWorker({
  store = outreachStore, mailer = createOutreachMailer(), env = () => process.env,
  now = Date.now, logger = console, pollMs = 5000, maintenanceMs = 60 * 60 * 1000,
} = {}) {
  let timer, stopped = true, inFlight = null, controller = null, lastMaintenance = -Infinity, lastFailure = null;
  function logFailure(code) {
    if (lastFailure === code) return;
    lastFailure = code;
    // Never log recipient addresses, request bodies, tokens, SMTP credentials or provider errors.
    logger.warn?.('[outreach.worker]', JSON.stringify({ code }));
  }
  async function once() {
    if (stopped) return;
    try {
      if (now() - lastMaintenance >= maintenanceMs) {
        await store.expireApiMetadata();
        lastMaintenance = now();
      }
      // Recovery and API retention are independent from automatic sending.
      await store.recoverDispatch();
      const config = readOutreachConfig(env());
      if (!config.sendingEnabled || !config.smtpConfigured || !config.publicUrlConfigured || !config.limitsConfigured || stopped) return;
      const workerToken = randomUUID();
      const claimed = await store.claim(workerToken, config);
      if (!claimed) { lastFailure = null; return; }
      if (stopped || !readOutreachConfig(env()).sendingEnabled) {
        await store.releaseClaim(claimed.id, workerToken); return;
      }
      const rawToken = newUnsubscribeToken();
      const started = await store.begin(claimed.id, workerToken, hashUnsubscribeToken(rawToken), readOutreachConfig(env()));
      if (!started) return;
      // A delayed RPC response is not a fresh authorization. Leave enough time
      // for the hard SMTP deadline before this owner's lease can expire.
      const leaseEnd = typeof started.lease_expires_at === 'string' ? Date.parse(started.lease_expires_at) : NaN;
      if (!Number.isFinite(leaseEnd) || leaseEnd - now() < 60_000) {
        await store.finish(started.id, workerToken, 'uncertain', 'SMTP_LEASE_UNCERTAIN');
        logFailure('SMTP_LEASE_UNCERTAIN'); return;
      }
      if (stopped) {
        await store.finish(started.id, workerToken, 'failed', 'WORKER_STOPPED_BEFORE_SMTP'); return;
      }
      const messageId = `<outreach-${started.id}@pr-text.com>`;
      const unsubscribeUrl = new URL('/api/outreach/unsubscribe', config.publicUrl);
      unsubscribeUrl.searchParams.set('token', rawToken);
      controller = new AbortController();
      let accepted = false;
      try {
        const info = await mailer.send({
          email: started.email, subject: started.subject, body: started.body,
          unsubscribeUrl: unsubscribeUrl.toString(), messageId, signal: controller.signal,
        });
        accepted = Array.isArray(info?.accepted) && info.accepted.some(email => typeof email === 'string' && email.toLowerCase() === started.email)
          && (!Array.isArray(info.rejected) || info.rejected.length === 0);
        if (!accepted) throw new Error('acceptance_uncertain');
        const persisted = await store.finish(started.id, workerToken, 'sent', null, messageId);
        if (!persisted) logFailure('OUTREACH_STALE_RESULT');
      } catch (error) {
        const code = accepted ? 'SMTP_RESULT_PERSISTENCE_UNCERTAIN'
          : error?.code === 'EAUTH' ? 'SMTP_AUTH_UNCERTAIN' : 'SMTP_SEND_UNCERTAIN';
        try { await store.finish(started.id, workerToken, 'uncertain', code); }
        catch { /* A lost DB result remains sending; stale recovery marks it uncertain. */ }
        logFailure(code);
      } finally { controller = null; }
    } catch (error) { logFailure(error?.code === 'OUTREACH_DATABASE_NOT_READY' ? error.code : 'OUTREACH_WORKER_UNAVAILABLE'); }
  }
  function tick() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = once().finally(() => { inFlight = null; });
    return inFlight;
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(() => { void tick(); }, pollMs);
      timer.unref?.();
      void tick();
    },
    async stop() {
      stopped = true; clearInterval(timer); controller?.abort();
      if (inFlight) await inFlight;
    },
    tick,
  };
}

const worker = createOutreachWorker();
export function startOutreachWorker() { worker.start(); }
export function stopOutreachWorker() { return worker.stop(); }
