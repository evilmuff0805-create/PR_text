import assert from 'node:assert/strict';
import test from 'node:test';

const { MAX_UPLOAD_BYTES, validateUploadFile } = await import('../client/src/utils/upload-validation.js');

test('accepts supported files within the upload limit', () => {
  assert.equal(validateUploadFile({ name: 'interview.MP4', size: MAX_UPLOAD_BYTES }), null);
});

test('reports unsupported formats and oversized files before upload', () => {
  const error = validateUploadFile({ name: 'interview.mov', size: 25_132.32 * 1024 * 1024 });

  assert.match(error, /지원하지 않는 파일 형식/);
  assert.match(error, /최대 150MB/);
});
