import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const {
  DIARIZATION_DURATION_LIMIT_CODE,
  DIARIZATION_MAX_AUDIO_SECONDS,
  createDiarizationDurationLimitError,
  diarizationDurationLimitMessage,
} = await import('../src/services/whisper.js');
const { DIARIZATION_MAX_MINUTES } = await import('../client/src/utils/upload-validation.js');

test('diarization accepts thirty minutes of audio', () => {
  assert.equal(DIARIZATION_MAX_AUDIO_SECONDS, 30 * 60);
});

test('the on-screen notice matches the limit the server enforces', () => {
  // The client only renders the notice; the server owns the check. They are
  // separate constants, so drift would advertise a limit that does not exist.
  assert.equal(DIARIZATION_MAX_MINUTES * 60, DIARIZATION_MAX_AUDIO_SECONDS);
  assert.match(diarizationDurationLimitMessage(), new RegExp(`최대 ${DIARIZATION_MAX_MINUTES}분`));
});

test('the duration limit is recognised by code rather than message text', () => {
  // Both the route and the whisper wrapper used to re-detect this error with
  // `message.includes('최대 20분')`, which silently stops matching the moment the
  // limit changes.
  const error = createDiarizationDurationLimitError();

  assert.equal(error.code, DIARIZATION_DURATION_LIMIT_CODE);
  assert.equal(error.message, diarizationDurationLimitMessage());
});

test('neither the gate nor the backstop carries its own literal', async () => {
  const routeSource = await readFile(new URL('../src/routes/transcribe.js', import.meta.url), 'utf8');
  const whisperSource = await readFile(new URL('../src/services/whisper.js', import.meta.url), 'utf8');

  // A gate and a backstop with independent numbers leaves a band where a file
  // passes upload, pays for a full transcription, and only then fails.
  assert.match(routeSource, /durationSeconds > DIARIZATION_MAX_AUDIO_SECONDS/);
  assert.match(whisperSource, /lastEnd > DIARIZATION_BACKSTOP_SECONDS/);
  assert.match(whisperSource, /DIARIZATION_MAX_AUDIO_SECONDS \+ 200/);

  assert.doesNotMatch(routeSource, /20 \* 60/);
  assert.doesNotMatch(routeSource, /최대 20분/);
  assert.doesNotMatch(whisperSource, /lastEnd > 1400/);
  assert.doesNotMatch(whisperSource, /최대 20분/);
});

test('the stale lease window covers a full-length job', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/20260812130000_diarization_stale_lease_window.sql', import.meta.url),
    'utf8',
  );

  // A 30 minute file runs about 14.5 minutes. The old 3 minute window left too
  // little slack for heartbeat delays, and a duplicate claim pays OpenAI twice.
  assert.match(sql, /interval '10 minutes'/);
  assert.doesNotMatch(sql, /interval '3 minutes'/);
  assert.match(sql, /create or replace function public\.claim_diarization_job/i);
  assert.match(
    sql,
    /revoke all on function public\.claim_diarization_job\(uuid\) from public, anon, authenticated/i,
  );
  assert.match(sql, /grant execute on function public\.claim_diarization_job\(uuid\) to service_role/i);
});
