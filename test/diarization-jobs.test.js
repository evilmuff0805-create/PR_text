import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const {
  createDiarizationJobTimingLog,
  isDiarizationJobId,
  storageFilenameForJob,
  toClientDiarizationJob,
} = await import('../src/services/diarization-jobs.js');
const { shouldCompressDiarizationAudioForStorage } = await import('../src/services/whisper.js');

const jobId = 'a8b1dc79-6f44-4a9d-9e7e-0c0f0f6a9de1';

test('accepts only UUID-shaped diarization job ids', () => {
  assert.equal(isDiarizationJobId(jobId), true);
  assert.equal(isDiarizationJobId('not-a-job-id'), false);
  assert.equal(isDiarizationJobId(`${jobId}/../other`), false);
});

test('hides in-progress diarization result data from the client', () => {
  const result = toClientDiarizationJob({
    id: jobId,
    status: 'running',
    created_at: '2026-07-11T00:00:00.000Z',
    started_at: '2026-07-11T00:01:00.000Z',
    completed_at: null,
    updated_at: '2026-07-11T00:01:30.000Z',
    filename: 'interview.m4a',
    credits_reserved: 12,
    credits_refunded: false,
    result_text: 'not ready',
    result_segments: [{ text: 'not ready' }],
    result_language: 'korean',
  }, 18);

  assert.equal(result.status, 'running');
  assert.equal(result.creditsRemaining, 18);
  assert.equal(result.updatedAt, '2026-07-11T00:01:30.000Z');
  assert.equal(result.text, undefined);
  assert.equal(result.segments, undefined);
});

test('returns completed diarization results and a safe failure message', () => {
  const completed = toClientDiarizationJob({
    id: jobId,
    status: 'completed',
    created_at: '2026-07-11T00:00:00.000Z',
    started_at: '2026-07-11T00:01:00.000Z',
    completed_at: '2026-07-11T00:02:00.000Z',
    filename: 'interview.m4a',
    credits_reserved: 12,
    credits_refunded: false,
    result_text: '결과',
    result_segments: [{ text: '결과' }],
    result_language: 'korean',
  }, 18);
  const failed = toClientDiarizationJob({ ...completed, status: 'failed', result_text: null, result_segments: null }, 30);

  assert.equal(completed.text, '결과');
  assert.equal(completed.segments.length, 1);
  assert.equal(failed.creditsRemaining, 30);
  assert.equal(failed.error, '변환에 실패해 예약한 변환 시간이 자동 환불되었습니다.');
});

test('converts only large diarization files before temporary storage', () => {
  assert.equal(shouldCompressDiarizationAudioForStorage(45 * 1024 * 1024), false);
  assert.equal(shouldCompressDiarizationAudioForStorage(45 * 1024 * 1024 + 1), true);
});

test('uses the stored mp3 extension for converted diarization jobs', () => {
  assert.equal(storageFilenameForJob({ storage_path: 'user/job.mp3', filename: 'interview.mp4' }), 'queued-audio.mp3');
  assert.equal(storageFilenameForJob({ storage_path: 'user/job', filename: 'interview.m4a' }), 'interview.m4a');
});

test('summarizes diarization timings without treating nested persistence stages as mismatches', () => {
  const timing = createDiarizationJobTimingLog({
    job: { id: jobId, attempt_count: 2 },
    outcome: 'success',
    startedAt: 100,
    completedAt: 1_100,
    wallStartedAt: 1_000,
    wallCompletedAt: 2_000,
    timings: {
      claimMs: 30,
      storageDownloadMs: 80,
      transcriptionMs: 600,
      processingMs: 120,
      persistenceMs: 100,
      historyMs: 70,
      completionMs: 30,
      cleanupMs: 40,
    },
    rawTimings: {
      compressionMs: 50,
      openaiMs: 500,
      preconvertedM4a: true,
      openaiAttempts: [{ phase: 'initial', outcome: 'success', durationMs: 500 }],
    },
    correctionTimings: {
      eligible: true,
      estimatedCostUsd: 0.012345678,
      wallMs: 100,
      chunks: [],
    },
    segmentCount: 12,
    language: 'ko',
    creditsRefunded: false,
  });

  assert.equal(timing.jobId, jobId);
  assert.equal(timing.attempt, 2);
  assert.equal(timing.storageDownloadMs, 80);
  assert.equal(timing.openaiMs, 500);
  assert.equal(timing.correction.estimatedCostUsd, 0.01234568);
  assert.equal(timing.timingMismatch.detected, false);
});
