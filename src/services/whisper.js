import OpenAI from 'openai';
import { toFile } from 'openai';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 4 });
const execFileAsync = promisify(execFile);

const WHISPER_LIMIT = 25 * 1024 * 1024; // 25MB
const OPENAI_SUPPORTED_EXTENSIONS = new Set(['.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.oga', '.ogg', '.wav', '.webm']);

function getExtension(filename) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return '';
  return filename.slice(dotIndex).toLowerCase();
}

function getSafeAudioName(originalname, fallbackExt = '.mp3') {
  const ext = getExtension(originalname);
  const safeExt = OPENAI_SUPPORTED_EXTENSIONS.has(ext) ? ext : fallbackExt;
  return `audio-${Date.now()}${safeExt}`;
}

function isInvalidFileFormatError(err) {
  return err.status === 400 && /invalid file format/i.test(err.message || '');
}

async function compressAudio(buffer, originalname) {
  const ext = getExtension(originalname) || '.audio';
  const inputPath = join(tmpdir(), `stt-input-${Date.now()}${ext}`);
  const outputPath = join(tmpdir(), `stt-output-${Date.now()}.mp3`);

  try {
    await writeFile(inputPath, buffer);

    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '32k',
      '-y',
      outputPath,
    ], { timeout: 120_000 });

    const compressed = await readFile(outputPath);
    return compressed;
  } catch (err) {
    throw new Error(`FFmpeg 압축 오류: ${err.message}`);
  } finally {
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
  }
}

async function createTranscriptionWithFallback({
  buffer,
  originalname,
  params,
  logPrefix,
}) {
  let audioBuffer = buffer;
  let audioName = getSafeAudioName(originalname);

  if (buffer.length >= WHISPER_LIMIT) {
    console.log(`[${logPrefix}] 압축 전: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
    audioBuffer = await compressAudio(buffer, originalname);
    audioName = 'compressed.mp3';
    console.log(`[${logPrefix}] 압축 후: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);
  }

  try {
    const file = await toFile(audioBuffer, audioName);
    return await openai.audio.transcriptions.create({ ...params, file });
  } catch (err) {
    if (!isInvalidFileFormatError(err) || audioName === 'compressed.mp3') {
      throw err;
    }

    console.warn(`[${logPrefix}] OpenAI 파일 형식 오류. 휴대폰 녹음 파일 호환성을 위해 mp3로 변환 후 재시도합니다. original=${originalname}, upload=${audioName}`);
    const converted = await compressAudio(buffer, originalname);
    const file = await toFile(converted, 'converted.mp3');
    return openai.audio.transcriptions.create({ ...params, file });
  }
}

export async function transcribeWithDiarization(buffer, originalname, language) {
  try {
    const params = {
      model: 'gpt-4o-transcribe-diarize',
      response_format: 'diarized_json',
      // The diarization API requires chunking for audio longer than 30 seconds.
      chunking_strategy: 'auto',
    };

    if (language) {
      params.language = language;
    }

    const response = await createTranscriptionWithFallback({
      buffer,
      originalname,
      params,
      logPrefix: 'diarize',
    });

    const rawSegments = response.segments ?? [];

    // 오디오 길이 제한 확인 (1400초 초과 시 에러)
    const lastEnd = rawSegments.length > 0 ? rawSegments[rawSegments.length - 1].end : 0;
    if (lastEnd > 1400) {
      throw new Error('다화자 분리 모드는 최대 20분 음성만 지원합니다. 파일을 분할 후 다시 시도해주세요.');
    }

    // speaker "A"→0, "B"→1, ... 매핑
    const segments = rawSegments.map(s => ({
      start: s.start,
      end: s.end,
      text: s.text,
      speaker: typeof s.speaker === 'string' ? s.speaker.charCodeAt(0) - 65 : 0,
    }));

    return {
      text: response.text,
      segments,
      language: response.language ?? language ?? 'unknown',
    };
  } catch (err) {
    if (err.message.includes('최대 20분')) throw err;
    if (err instanceof OpenAI.APIConnectionError) {
      const e = new Error('OpenAI 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해주세요.');
      e.code = 'CONNECTION';
      throw e;
    }
    if (err.status === 429) {
      const quota = err.code === 'insufficient_quota';
      const e = new Error(quota
        ? '변환 서버(OpenAI) 사용량이 소진되었습니다. 관리자에게 문의해주세요.'
        : '요청이 일시적으로 많습니다. 잠시 후 다시 시도해주세요.');
      e.code = quota ? 'QUOTA' : 'RATELIMIT';
      throw e;
    }
    throw new Error(`Whisper Diarize API 오류: ${err.message}`);
  }
}

/**
 * @param {Buffer} buffer - 오디오 파일 버퍼
 * @param {string} originalname - 원본 파일명 (확장자 추출용)
 * @param {string} [language] - ISO-639-1 언어 코드 (없으면 자동 감지)
 * @returns {{ text: string, segments: object[], language: string }}
 */
export async function transcribe(buffer, originalname, language) {
  try {
    const params = {
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    };

    if (language) {
      params.language = language;
    }

    const response = await createTranscriptionWithFallback({
      buffer,
      originalname,
      params,
      logPrefix: 'whisper',
    });

    return {
      text: response.text,
      segments: response.segments ?? [],
      language: response.language ?? language ?? 'unknown',
    };
  } catch (err) {
    if (err instanceof OpenAI.APIConnectionError) {
      const e = new Error('OpenAI 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해주세요.');
      e.code = 'CONNECTION';
      throw e;
    }
    if (err.status === 429) {
      const quota = err.code === 'insufficient_quota';
      const e = new Error(quota
        ? '변환 서버(OpenAI) 사용량이 소진되었습니다. 관리자에게 문의해주세요.'
        : '요청이 일시적으로 많습니다. 잠시 후 다시 시도해주세요.');
      e.code = quota ? 'QUOTA' : 'RATELIMIT';
      throw e;
    }
    throw new Error(`Whisper API 오류: ${err.message}`);
  }
}
