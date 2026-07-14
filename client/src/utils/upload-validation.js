export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

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

export function validateUploadFile(file) {
  if (!file) return '업로드할 파일을 선택해주세요.';

  const extensionIndex = file.name.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? file.name.slice(extensionIndex).toLowerCase() : '';
  const errors = [];

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    errors.push('지원하지 않는 파일 형식입니다. mp3, wav, m4a, webm, mp4, mpeg, mpga, ogg, flac 파일만 업로드할 수 있습니다.');
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    errors.push('파일 크기를 확인할 수 없습니다. 다른 파일을 선택해주세요.');
  } else if (file.size > MAX_UPLOAD_BYTES) {
    errors.push(`파일 크기는 최대 150MB입니다. 현재 ${formatMegabytes(file.size)}MB입니다.`);
  }

  return errors.length > 0 ? errors.join(' ') : null;
}
