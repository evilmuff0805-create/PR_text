import OpenAI from 'openai';
import { toFile } from 'openai';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const execFileAsync = promisify(execFile);

const WHISPER_LIMIT = 25 * 1024 * 1024; // 25MB

async function compressAudio(buffer, originalname) {
  const ext = originalname.slice(originalname.lastIndexOf('.'));
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

/**
 * @param {Buffer} buffer - 오디오 파일 버퍼
 * @param {string} originalname - 원본 파일명 (확장자 추출용)
 * @param {string} [language] - ISO-639-1 언어 코드 (없으면 자동 감지)
 * @returns {{ text: string, segments: object[], language: string }}
 */
export async function transcribe(buffer, originalname, language) {
  try {
    let audioBuffer = buffer;
    let audioName = originalname;

    if (buffer.length >= WHISPER_LIMIT) {
      console.log(`[whisper] 압축 전: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
      audioBuffer = await compressAudio(buffer, originalname);
      audioName = 'compressed.mp3';
      console.log(`[whisper] 압축 후: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    }

    const file = await toFile(audioBuffer, audioName);

    const params = {
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    };

    if (language) {
      params.language = language;
    }

    const response = await openai.audio.transcriptions.create(params);

    return {
      text: response.text,
      segments: response.segments ?? [],
      language: response.language ?? language ?? 'unknown',
    };
  } catch (err) {
    throw new Error(`Whisper API 오류: ${err.message}`);
  }
}
