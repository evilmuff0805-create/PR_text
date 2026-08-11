import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isKoreanLanguage, normalizeLanguage, UNKNOWN_LANGUAGE } from '../src/services/language.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the same language never gets stored under two different labels', () => {
  for (const value of ['ko', 'KO', 'kor', 'korean', 'Korean', ' 한국어 ']) {
    assert.equal(normalizeLanguage(value), 'ko', `${value} → ko 여야 한다`);
  }
  assert.equal(normalizeLanguage('english'), 'en');
  assert.equal(normalizeLanguage('English'), 'en');
  assert.equal(normalizeLanguage('japanese'), 'ja');
  assert.equal(normalizeLanguage('chinese'), 'zh');
});

test('unknown languages keep their value instead of being discarded', () => {
  assert.equal(normalizeLanguage(''), UNKNOWN_LANGUAGE);
  assert.equal(normalizeLanguage(null), UNKNOWN_LANGUAGE);
  assert.equal(normalizeLanguage('Vietnamese'), 'vietnamese');
});

test('korean detection accepts every spelling Whisper returns', () => {
  assert.ok(isKoreanLanguage('korean'));
  assert.ok(isKoreanLanguage('ko'));
  assert.ok(isKoreanLanguage('KOR'));
  assert.equal(isKoreanLanguage('english'), false);
  assert.equal(isKoreanLanguage('unknown'), false);
});

test('language is normalized at every write site, not just on read', async () => {
  const [route, worker, postprocess] = await Promise.all([
    read('src/routes/transcribe.js'),
    read('src/services/diarization-jobs.js'),
    read('src/services/postprocess.js'),
  ]);

  assert.match(route, /const resultLanguage = normalizeLanguage\(result\.language\)/);
  assert.doesNotMatch(route, /language: result\.language/);
  assert.match(worker, /language: normalizeLanguage\(result\.language\)/);
  assert.match(worker, /p_result_language: normalizeLanguage\(result\.language\)/);
  // 교정 분기도 같은 판정을 쓰게 한다.
  assert.match(postprocess, /isKoreanLanguage\(language\)/);
});

test('edits are stored beside the original and guarded by ownership and shape', async () => {
  const sql = await read('supabase/migrations/20260811090000_transcription_edit_persistence.sql');

  assert.match(sql, /add column if not exists edited_segments jsonb/);
  assert.match(sql, /create or replace function public\.save_transcription_edits/i);
  // 남의 기록을 덮어쓸 수 없어야 한다.
  assert.match(sql, /v_owner <> p_user_id/);
  // 구간 수가 달라지면 타임코드와 어긋난다.
  assert.match(sql, /v_next_count <> v_original_count/);
  assert.doesNotMatch(sql, /grant .* (anon|authenticated)/i);
});

test('redownload serves the edited version once it exists', async () => {
  const route = await read('src/routes/auth.js');

  assert.match(route, /router\.put\('\/transcription\/:id\/segments'/);
  assert.match(route, /segments: editedSegments \|\| log\.segments/);
  assert.match(route, /save_transcription_edits/);
});

test('the editor saves edits without blocking on a mismatched draft', async () => {
  const page = await read('client/src/pages/ResultPage.jsx');

  assert.match(page, /\/api\/auth\/transcription\/\$\{transcriptionLogId\}\/segments/);
  assert.match(page, /method: 'PUT'/);
  // 줄 수가 어긋난 상태는 화면에서도 보류하므로 저장하지 않는다.
  assert.match(page, /if \(lineCountMismatch\) return;/);
  assert.match(page, /result-save-state/);
});

test('both transcription paths hand the editor a log id to save against', async () => {
  const [route, worker] = await Promise.all([
    read('src/routes/transcribe.js'),
    read('src/services/diarization-jobs.js'),
  ]);

  assert.match(route, /transcriptionLogId: logRow\?\.id \?\? null/);
  assert.match(worker, /transcriptionLogId: completed \? job\.transcription_log_id : undefined/);
});
