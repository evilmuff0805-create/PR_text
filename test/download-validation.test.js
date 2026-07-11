import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { validateDownloadPayload } = await import('../src/routes/download.js');

const validPayload = {
  segments: [{ start: 0, end: 1, text: '안녕하세요', speaker: 0 }],
  format: 'ass',
  assOptions: {
    position: 'bottom',
    fontFamily: 'Pretendard',
    fontColor: '#FFFFFF',
    fontSize: 20,
  },
  speakerColors: { 0: '#FFFFFF' },
};

test('accepts a valid authenticated download payload shape', () => {
  assert.equal(validateDownloadPayload(validPayload), null);
});

test('rejects unsafe subtitle download payload fields', () => {
  assert.match(validateDownloadPayload({ ...validPayload, segments: [{ ...validPayload.segments[0], start: 2, end: 1 }] }), /시간 정보/);
  assert.match(validateDownloadPayload({ ...validPayload, assOptions: { ...validPayload.assOptions, fontFamily: 'bad\nfont' } }), /폰트명/);
  assert.match(validateDownloadPayload({ ...validPayload, speakerColors: { 0: 'red' } }), /색상 값/);
});
