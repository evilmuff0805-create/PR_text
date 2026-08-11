import 'dotenv/config';
import { performance } from 'perf_hooks';
import { basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, statSync } from 'fs';
import OpenAI from 'openai';

/**
 * 다화자 전사의 실제 길이 상한과 소요 시간을 잰다.
 *
 * 앱의 20분 제한(src/routes/transcribe.js)과 1400초 재확인(src/services/whisper.js)이
 * 어디서 온 값인지 근거가 남아 있지 않아, 실제 API로 확인하기 위한 측정 도구다.
 * 앱을 거치지 않고 OpenAI를 직접 호출하므로 크레딧도 DB도 건드리지 않는다.
 *
 * 사용법:
 *   node scripts/measure-diarization-limit.js <오디오파일> [오디오파일...]
 *
 * 확인하려는 것:
 *   1. 몇 분짜리까지 API가 받아주는가 (길이 상한이 실재하는가)
 *   2. 길이 대비 소요 시간이 어떻게 늘어나는가
 *   3. SDK 기본 타임아웃 10분에 걸리는 길이는 몇 분인가
 */

// 앱과 동일한 조건으로 호출한다. 다만 재시도는 끈다.
// 기본값(maxRetries 4)이면 실패해도 최대 5회 × 10분을 기다리게 되어 측정이 불가능하다.
// 키가 없을 때 SDK 예외 대신 안내를 보여주려고 실제 호출 직전에 만든다.
let client = null;
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  }
  return client;
}

const MODEL = 'gpt-4o-transcribe-diarize';
const SDK_DEFAULT_TIMEOUT_MS = 600_000;

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}분 ${String(whole % 60).padStart(2, '0')}초`;
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export async function measureFile(filePath, { openai = null, timeoutMs = SDK_DEFAULT_TIMEOUT_MS } = {}) {
  const api = openai || getClient();
  const absolute = resolve(filePath);
  const size = statSync(absolute).size;
  const startedAt = performance.now();

  try {
    const response = await api.audio.transcriptions.create({
      model: MODEL,
      response_format: 'diarized_json',
      chunking_strategy: 'auto',
      file: createReadStream(absolute),
    }, { timeout: timeoutMs });

    const elapsedMs = performance.now() - startedAt;
    const segments = response.segments ?? [];
    const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
    const speakers = new Set(segments.map((segment) => segment.speaker).filter(Boolean));

    return {
      file: basename(absolute),
      size,
      ok: true,
      elapsedMs,
      audioSeconds: lastEnd,
      segmentCount: segments.length,
      speakerCount: speakers.size,
    };
  } catch (error) {
    return {
      file: basename(absolute),
      size,
      ok: false,
      elapsedMs: performance.now() - startedAt,
      errorName: error?.name || 'Error',
      errorMessage: error?.message || String(error),
      status: error?.status,
    };
  }
}

function report(result) {
  console.log(`\n── ${result.file} (${formatSize(result.size)})`);

  if (!result.ok) {
    console.log(`   실패: ${result.errorName}${result.status ? ` ${result.status}` : ''}`);
    console.log(`   메시지: ${result.errorMessage}`);
    console.log(`   실패까지 걸린 시간: ${formatDuration(result.elapsedMs / 1000)}`);
    return;
  }

  const audioMinutes = result.audioSeconds / 60;
  const elapsedSeconds = result.elapsedMs / 1000;
  // 오디오 1분을 처리하는 데 실제로 몇 초가 드는가. 더 긴 파일의 소요 시간을 가늠하는 값.
  const ratio = audioMinutes > 0 ? elapsedSeconds / audioMinutes : 0;

  console.log(`   성공 · 오디오 ${formatDuration(result.audioSeconds)} · 세그먼트 ${result.segmentCount}개 · 화자 ${result.speakerCount}명`);
  console.log(`   소요 ${formatDuration(elapsedSeconds)} (오디오 1분당 ${ratio.toFixed(1)}초)`);

  if (result.audioSeconds > 1400) {
    console.log(`   → 앱의 1400초 재확인을 넘겼다. 이 체크는 모델 상한이 아니다.`);
  }

  const timeoutMinutes = (SDK_DEFAULT_TIMEOUT_MS / 1000) / ratio;
  if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
    console.log(`   → 이 속도면 SDK 기본 타임아웃(10분)에 약 ${timeoutMinutes.toFixed(0)}분짜리 오디오에서 닿는다.`);
  }
}

async function main() {
  const files = process.argv.slice(2);

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY가 필요합니다. .env에 넣거나 환경변수로 주세요.');
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('사용법: node scripts/measure-diarization-limit.js <오디오파일> [오디오파일...]');
    console.error('짧은 것부터 긴 순서로 주세요. 예: 25분.mp3 35분.mp3 50분.mp3');
    process.exit(1);
  }

  console.log(`모델 ${MODEL} · 재시도 없음 · 타임아웃 ${SDK_DEFAULT_TIMEOUT_MS / 60000}분`);
  console.log('앱을 거치지 않고 OpenAI를 직접 호출합니다. 크레딧과 DB는 건드리지 않습니다.');

  for (const file of files) {
    // 한 번에 하나씩 돈다. 동시에 돌리면 소요 시간 측정이 서로 오염된다.
    report(await measureFile(file));
  }

  console.log('\n측정 끝. 실패한 길이가 있으면 그 아래가 실제 상한입니다.');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
