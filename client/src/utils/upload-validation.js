export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
export const MAX_WAV_SOURCE_BYTES = 500 * 1024 * 1024;

// Mirrors DIARIZATION_MAX_AUDIO_SECONDS in src/services/whisper.js. The server
// owns the check; this only drives the on-screen notice. A regression test keeps
// the two in sync.
export const DIARIZATION_MAX_MINUTES = 20;

export const SUPPORTED_UPLOAD_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.webm', '.mp4', '.mpeg', '.mpga', '.ogg', '.flac',
];

const SUPPORTED_EXTENSIONS = new Set(SUPPORTED_UPLOAD_EXTENSIONS);

// Android content providers commonly identify recordings by MIME type instead of extension.
export const UPLOAD_ACCEPT = [
  'audio/*',
  'video/mp4',
  'video/webm',
  ...SUPPORTED_UPLOAD_EXTENSIONS,
].join(',');

function formatMegabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function getUploadExtension(file) {
  if (!file?.name) return '';
  const extensionIndex = file.name.lastIndexOf('.');
  return extensionIndex >= 0 ? file.name.slice(extensionIndex).toLowerCase() : '';
}

export function isWavUpload(file) {
  return getUploadExtension(file) === '.wav';
}

export function shouldOptimizeWavUpload(file) {
  return isWavUpload(file)
    && Number.isFinite(file?.size)
    && file.size > MAX_UPLOAD_BYTES
    && file.size <= MAX_WAV_SOURCE_BYTES;
}

function validateFile(file, { allowLargeWav }) {
  if (!file) return '업로드할 파일을 선택해주세요.';

  const extension = getUploadExtension(file);
  const errors = [];

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    errors.push('지원하지 않는 파일 형식입니다. mp3, wav, m4a, webm, mp4, mpeg, mpga, ogg, flac 파일만 업로드할 수 있습니다.');
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    errors.push('파일 크기를 확인할 수 없습니다. 다른 파일을 선택해주세요.');
  } else {
    const maximumBytes = allowLargeWav && extension === '.wav'
      ? MAX_WAV_SOURCE_BYTES
      : MAX_UPLOAD_BYTES;

    if (file.size > maximumBytes) {
      const maximumMegabytes = maximumBytes / 1024 / 1024;
      errors.push(`파일 크기는 최대 ${maximumMegabytes}MB입니다. 현재 ${formatMegabytes(file.size)}MB입니다.`);
    }
  }

  return errors.length > 0 ? errors.join(' ') : null;
}

export function validateUploadFile(file) {
  return validateFile(file, { allowLargeWav: true });
}

export function validatePreparedUploadFile(file) {
  return validateFile(file, { allowLargeWav: false });
}
