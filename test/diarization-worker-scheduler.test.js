import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDiarizationWorkerScheduler,
  DIARIZATION_AUDIO_CLEANUP_INTERVAL_MS,
  DIARIZATION_JOB_POLL_INTERVAL_MS,
} from '../src/services/diarization-worker-scheduler.js';

function createFakeTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    timers,
    setIntervalFn(callback, delay) {
      const timer = { id: ++nextId, callback, delay };
      timers.set(timer.id, timer);
      return timer.id;
    },
    clearIntervalFn(id) {
      timers.delete(id);
    },
    async tick(delay) {
      const timer = [...timers.values()].find((entry) => entry.delay === delay);
      assert.ok(timer, `expected a ${delay}ms timer`);
      await timer.callback();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('keeps job claims at five seconds and runs them independently of slow cleanup', async () => {
  const fakeTimers = createFakeTimers();
  let releaseCleanup;
  let claims = 0;
  const scheduler = createDiarizationWorkerScheduler({
    processNext: async () => { claims += 1; },
    cleanFinishedAudioBatch: () => new Promise((resolve) => { releaseCleanup = resolve; }),
    ...fakeTimers,
  });

  scheduler.start();
  await flush();
  assert.equal(claims, 1, 'claim runs immediately at startup');
  assert.deepEqual([...fakeTimers.timers.values()].map(({ delay }) => delay).sort((a, b) => a - b), [
    DIARIZATION_JOB_POLL_INTERVAL_MS,
    DIARIZATION_AUDIO_CLEANUP_INTERVAL_MS,
  ]);

  await fakeTimers.tick(DIARIZATION_JOB_POLL_INTERVAL_MS);
  assert.equal(claims, 2, 'claim timer is not waiting for cleanup');
  releaseCleanup({ count: 0, complete: true });
  await flush();
  scheduler.stop();
});

test('drains full cleanup batches up to the bounded per-cycle limit', async () => {
  const fakeTimers = createFakeTimers();
  let batchCount = 0;
  const scheduler = createDiarizationWorkerScheduler({
    processNext: async () => {},
    cleanFinishedAudioBatch: async () => {
      batchCount += 1;
      return { count: 10, complete: true };
    },
    ...fakeTimers,
  });

  scheduler.start();
  await flush();
  assert.equal(batchCount, 12, 'initial cleanup is bounded to twelve batches');
  await fakeTimers.tick(DIARIZATION_AUDIO_CLEANUP_INTERVAL_MS);
  assert.equal(batchCount, 24, 'the next cleanup interval resumes backlog processing');
  scheduler.stop();
});

test('stops a cleanup pass after a failed deletion and continues claiming work', async () => {
  const fakeTimers = createFakeTimers();
  let claims = 0;
  let cleanupCalls = 0;
  const errors = [];
  const scheduler = createDiarizationWorkerScheduler({
    processNext: async () => { claims += 1; },
    cleanFinishedAudioBatch: async () => {
      cleanupCalls += 1;
      return { count: 10, complete: false };
    },
    reportError: (label) => errors.push(label),
    ...fakeTimers,
  });

  scheduler.start();
  await flush();
  assert.equal(cleanupCalls, 1, 'failed rows are not retried in a tight loop');
  await fakeTimers.tick(DIARIZATION_JOB_POLL_INTERVAL_MS);
  assert.equal(claims, 2);
  assert.deepEqual(errors, []);
  scheduler.stop();
});

test('reports cleanup errors, prevents duplicate timers, and supports restart', async () => {
  const fakeTimers = createFakeTimers();
  let claims = 0;
  let cleanups = 0;
  const errors = [];
  const scheduler = createDiarizationWorkerScheduler({
    processNext: async () => { claims += 1; },
    cleanFinishedAudioBatch: async () => {
      cleanups += 1;
      throw new Error('temporary storage outage');
    },
    reportError: (label) => errors.push(label),
    ...fakeTimers,
  });

  scheduler.start();
  await flush();
  assert.equal(cleanups, 1);
  assert.deepEqual(errors, ['오디오 정리 오류']);
  scheduler.start();
  assert.equal(fakeTimers.timers.size, 2, 'starting twice does not duplicate timers');
  scheduler.stop();
  assert.equal(fakeTimers.timers.size, 0);
  scheduler.start();
  await flush();
  assert.equal(claims, 2, 'restart performs an immediate claim');
  assert.equal(cleanups, 2, 'restart performs one cleanup without overlapping prior work');
  scheduler.stop();
});

test('does not overlap a cleanup across stop and restart', async () => {
  const fakeTimers = createFakeTimers();
  let releaseFirstCleanup;
  let activeCleanups = 0;
  let maximumActiveCleanups = 0;
  let cleanups = 0;
  const scheduler = createDiarizationWorkerScheduler({
    processNext: async () => {},
    cleanFinishedAudioBatch: async () => {
      cleanups += 1;
      activeCleanups += 1;
      maximumActiveCleanups = Math.max(maximumActiveCleanups, activeCleanups);
      if (cleanups === 1) {
        await new Promise((resolve) => { releaseFirstCleanup = resolve; });
      }
      activeCleanups -= 1;
      return { count: 0, complete: true };
    },
    ...fakeTimers,
  });

  scheduler.start();
  await flush();
  scheduler.stop();
  scheduler.start();
  await flush();
  assert.equal(cleanups, 1, 'restart waits for the in-flight cleanup instead of overlapping it');
  releaseFirstCleanup();
  await flush();
  assert.equal(cleanups, 2, 'the restart cleanup runs as soon as the previous call settles');
  assert.equal(maximumActiveCleanups, 1);
  scheduler.stop();
});

test('does not immediately retry a failed batch after a timer tick was queued', async () => {
  const fakeTimers = createFakeTimers();
  let releaseFirstCleanup;
  let cleanups = 0;
  const scheduler = createDiarizationWorkerScheduler({
    processNext: async () => {},
    cleanFinishedAudioBatch: async () => {
      cleanups += 1;
      if (cleanups === 1) {
        await new Promise((resolve) => { releaseFirstCleanup = resolve; });
        return { count: 10, complete: false };
      }
      return { count: 0, complete: true };
    },
    ...fakeTimers,
  });

  scheduler.start();
  await flush();
  await fakeTimers.tick(DIARIZATION_AUDIO_CLEANUP_INTERVAL_MS);
  releaseFirstCleanup();
  await flush();
  assert.equal(cleanups, 1, 'a queued tick does not turn a failed removal into a retry loop');
  await fakeTimers.tick(DIARIZATION_AUDIO_CLEANUP_INTERVAL_MS);
  assert.equal(cleanups, 2, 'the next scheduled interval retries the remaining row');
  scheduler.stop();
});
