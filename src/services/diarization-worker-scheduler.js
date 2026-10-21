export const DIARIZATION_JOB_POLL_INTERVAL_MS = 5_000;
export const DIARIZATION_AUDIO_CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 10;
const MAX_CLEANUP_BATCHES_PER_CYCLE = 12;

export function createDiarizationWorkerScheduler({
  processNext,
  cleanFinishedAudioBatch,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  reportError = (label, error) => console.error(`[diarization.job] ${label}: ${error.message}`),
}) {
  let claimTimer;
  let cleanupTimer;
  let claimRunning = false;
  let cleanupRunning = false;
  let cleanupRequested = false;
  let stopping = false;
  let generation = 0;

  const runClaim = async () => {
    if (stopping || claimRunning) return;
    claimRunning = true;
    try {
      await processNext();
    } catch (error) {
      reportError('worker 오류', error);
    } finally {
      claimRunning = false;
    }
  };

  const runCleanup = async () => {
    if (stopping) return;
    if (cleanupRunning) {
      cleanupRequested = true;
      return;
    }
    const runGeneration = generation;
    cleanupRunning = true;
    let cleanupPassHealthy = true;
    try {
      for (let batch = 0; batch < MAX_CLEANUP_BATCHES_PER_CYCLE
        && !stopping && runGeneration === generation; batch += 1) {
        const result = await cleanFinishedAudioBatch();
        if (!result?.complete) cleanupPassHealthy = false;
        if (!result?.complete || result.count < CLEANUP_BATCH_SIZE
          || stopping || runGeneration !== generation) break;
      }
    } catch (error) {
      cleanupPassHealthy = false;
      reportError('오디오 정리 오류', error);
    } finally {
      cleanupRunning = false;
      if (cleanupRequested && !stopping && cleanupPassHealthy) {
        cleanupRequested = false;
        void runCleanup();
      } else if (!cleanupPassHealthy) {
        cleanupRequested = false;
      }
    }
  };

  return {
    start() {
      if (claimTimer || cleanupTimer) return;
      stopping = false;
      generation += 1;
      claimTimer = setIntervalFn(runClaim, DIARIZATION_JOB_POLL_INTERVAL_MS);
      cleanupTimer = setIntervalFn(runCleanup, DIARIZATION_AUDIO_CLEANUP_INTERVAL_MS);
      void runClaim();
      void runCleanup();
    },
    stop() {
      stopping = true;
      generation += 1;
      cleanupRequested = false;
      if (claimTimer) clearIntervalFn(claimTimer);
      if (cleanupTimer) clearIntervalFn(cleanupTimer);
      claimTimer = undefined;
      cleanupTimer = undefined;
    },
  };
}
