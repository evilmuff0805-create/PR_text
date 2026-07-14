import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MAX_UPLOAD_BYTES,
  SUPPORTED_UPLOAD_EXTENSIONS,
  UPLOAD_ACCEPT,
  validateUploadFile,
} = await import('../client/src/utils/upload-validation.js');

test('offers Android audio providers while preserving supported extensions', () => {
  const acceptTokens = new Set(UPLOAD_ACCEPT.split(','));

  assert.equal(acceptTokens.has('audio/*'), true);
  assert.equal(acceptTokens.has('video/mp4'), true);
  assert.equal(acceptTokens.has('video/webm'), true);
  for (const extension of SUPPORTED_UPLOAD_EXTENSIONS) {
    assert.equal(acceptTokens.has(extension), true, `${extension} is missing from the file picker`);
  }
});

test('accepts supported files within the upload limit', () => {
  assert.equal(validateUploadFile({ name: 'interview.MP4', size: MAX_UPLOAD_BYTES }), null);
});

test('reports unsupported formats and oversized files before upload', () => {
  const error = validateUploadFile({ name: 'interview.mov', size: 25_132.32 * 1024 * 1024 });

  assert.match(error, /지원하지 않는 파일 형식/);
  assert.match(error, /최대 150MB/);
});
