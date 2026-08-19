import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { prepareDownloadPayload, validateDownloadPayload } = await import('../src/routes/download.js');
const {
  normalizeProviderSpeakerLabels,
  normalizeStoredSpeakerMetadata,
} = await import('../src/services/speakers.js');

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

test('maps arbitrary provider speaker labels to stable sequential ids', () => {
  const normalized = normalizeProviderSpeakerLabels([
    { speaker: 'A', text: '첫 번째' },
    { speaker: '@', text: '예외 라벨' },
    { speaker: 'A', text: '다시 첫 번째' },
    { speaker: 'speaker-guest', text: '세 번째' },
  ]);

  assert.deepEqual(normalized.map((segment) => segment.speaker), [0, 1, 0, 2]);
});

test('repairs a legacy negative speaker without changing valid ids or colors', () => {
  const legacySegments = [
    { start: 0, end: 1, text: '기존 화자', speaker: 0 },
    { start: 1, end: 2, text: '예외 화자', speaker: -1 },
    { start: 2, end: 3, text: '다른 화자', speaker: 5 },
  ];
  const normalized = normalizeStoredSpeakerMetadata(legacySegments, {
    0: '#FFFFFF',
    '-1': '#39FF14',
    5: '#FFE600',
  });

  assert.equal(normalized.error, null);
  assert.deepEqual(normalized.segments.map((segment) => segment.speaker), [0, 1, 5]);
  assert.deepEqual(normalized.speakerColors, {
    0: '#FFFFFF',
    1: '#39FF14',
    5: '#FFE600',
  });
});

test('prepares the reported diarization result shape for every download format', () => {
  const reportedSegments = Array.from({ length: 264 }, (_, index) => ({
    start: index,
    end: index + 1,
    text: `구간 ${index + 1}`,
    speaker: index === 263 ? -1 : index % 6,
  }));
  const reportedColors = {
    0: '#FFFFFF',
    1: '#39FF14',
    2: '#FFE600',
    3: '#00F5FF',
    4: '#FF6B35',
    5: '#FF4BCB',
    '-1': '#A855F7',
  };

  for (const format of ['srt', 'txt', 'ass']) {
    const prepared = prepareDownloadPayload({
      ...validPayload,
      format,
      segments: reportedSegments,
      speakerColors: reportedColors,
    });

    assert.equal(prepared.error, null);
    assert.deepEqual(
      [...new Set(prepared.segments.map((segment) => segment.speaker))].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6],
    );
    assert.equal(prepared.speakerColors[6], '#A855F7');
  }
});

test('still rejects non-integer speaker metadata from an untrusted payload', () => {
  const prepared = prepareDownloadPayload({
    ...validPayload,
    segments: [{ ...validPayload.segments[0], speaker: 'A' }],
  });

  assert.match(prepared.error, /화자 정보/);
});
