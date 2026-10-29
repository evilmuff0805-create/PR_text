import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchSrtArchive, batchSrtFilename } from '../src/services/batch-archive.js';
import { validateSubtitleSegments } from '../src/services/subtitle-payload.js';
import { generateSRT } from '../src/services/subtitle.js';

// Inspect the central directory, then follow each independent local offset.
// QA also opens the resulting archives with Python's standard zipfile reader.
function unzipStored(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 4), 0);
  assert.equal(buffer.readUInt16LE(end + 6), 0);
  const count = buffer.readUInt16LE(end + 10);
  assert.equal(buffer.readUInt16LE(end + 8), count);
  const centralSize = buffer.readUInt32LE(end + 12);
  let cursor = buffer.readUInt32LE(end + 16);
  assert.equal(cursor + centralSize, end);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    assert.equal(buffer.readUInt16LE(cursor + 8), 0x0800);
    assert.equal(buffer.readUInt16LE(cursor + 10), 0);
    const size = buffer.readUInt32LE(cursor + 24);
    assert.equal(buffer.readUInt32LE(cursor + 20), size);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(cursor + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt32LE(local + 14), buffer.readUInt32LE(cursor + 16));
    assert.equal(buffer.readUInt16LE(local + 26), nameLength);
    assert.equal(buffer.subarray(local + 30, local + 30 + nameLength).toString('utf8'), name);
    const dataStart = local + 30 + nameLength + buffer.readUInt16LE(local + 28);
    assert.ok(!entries.has(name));
    entries.set(name, buffer.subarray(dataStart, dataStart + size).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end);
  return entries;
}

const item = (label, segments = [{ start: 12.345, end: 12.567, text: '네' }]) => ({ label, status: 'completed', segments });

test('subtitle payload bounds optional sentence-polish restoration metadata and accepts legacy line backups', () => {
  const base = { start: 0, end: 1, text: '문장입니다', timingSource: 'speech_window' };
  assert.equal(validateSubtitleSegments([{ ...base, grammarPolish: {
    status: 'applied', originalText: '원래 문장입니다', originalTimingSource: 'word',
  } }]), null);
  assert.equal(validateSubtitleSegments([{ ...base, grammarPolish: {
    status: 'applied', originalText: 'x'.repeat(10_000),
  } }]), null);
  assert.match(validateSubtitleSegments([{ ...base, grammarPolish: {
    status: 'applied', originalText: 'x'.repeat(10_001),
  } }]), /복원 정보/u);
  assert.match(validateSubtitleSegments([{ ...base, grammarPolish: {
    status: 'applied', sourceRows: Array.from({ length: 100 }, () => 'x'.repeat(1_000)),
  } }]), /복원 정보/u);
});

test('batch ZIP keeps independent millisecond timelines, silence and simultaneous speech', () => {
  const first = item('첫 번째 인물', [
    { start: 0.25, end: 0.4, text: '네' },
    { start: 123.456, end: 123.678, text: '맞아요' },
    { start: 7201.013, end: 7201.191, text: '네네' },
  ]);
  const second = item('두 번째 인물', [{ start: 123.457, end: 124.012, text: '저도요' }]);
  const original = structuredClone([first, second]);
  const archive = createBatchSrtArchive({ items: [first, second] });
  const files = unzipStored(archive.buffer);
  assert.deepEqual(archive.entries, ['01_첫 번째 인물.srt', '02_두 번째 인물.srt', '사용안내.txt']);
  assert.equal(archive.completedCount, 2);
  assert.equal(archive.includedSrtCount, 2);
  assert.equal(files.get(archive.entries[0]), generateSRT(first.segments));
  assert.equal(files.get(archive.entries[1]), generateSRT(second.segments));
  assert.match(files.get(archive.entries[0]), /00:00:00,250 --> 00:00:00,400/);
  assert.match(files.get(archive.entries[0]), /00:02:03,456 --> 00:02:03,678/);
  assert.match(files.get(archive.entries[0]), /02:00:01,013 --> 02:00:01,191/);
  assert.match(files.get(archive.entries[1]), /00:02:03,457 --> 00:02:04,012/);
  for (const name of archive.entries.slice(0, -1)) assert.match(files.get(name), /^1\n/);
  assert.doesNotMatch(files.get('사용안내.txt'), /시작 안내 클립/);
  assert.match(files.get('사용안내.txt'), /대사가 있는 SRT 2개/);
  assert.match(files.get('사용안내.txt'), /동시 발화/);
  assert.deepEqual([first, second], original);
});

test('partial export requires explicit confirmation and names retain original order', () => {
  const items = [item('가'), { label: '실패 인물', status: 'failed' }, item('다')];
  assert.throws(() => createBatchSrtArchive({ items }), { code: 'PARTIAL_BATCH_CONFIRMATION_REQUIRED', status: 400 });
  const archive = createBatchSrtArchive({ items, allowPartial: true });
  const files = unzipStored(archive.buffer);
  assert.deepEqual(archive.entries, ['01_가.srt', '03_다.srt', '사용안내.txt']);
  assert.match(files.get('사용안내.txt'), /전사 완료 2건 중 대사가 있는 SRT 2개/);
  assert.match(files.get('사용안내.txt'), /02\. 실패 인물: 실패/);
  assert.equal(archive.completedCount, 2);
});

test('empty recognition is omitted from ZIP SRT files and clearly counted', () => {
  const archive = createBatchSrtArchive({ items: [item('조용한 인물', [])] });
  const files = unzipStored(archive.buffer);
  assert.deepEqual(archive.entries, ['사용안내.txt']);
  assert.equal(archive.completedCount, 1);
  assert.equal(archive.includedSrtCount, 0);
  assert.equal(generateSRT([]), '');
  assert.match(files.get('사용안내.txt'), /전사 완료 1건 중 대사가 있는 SRT 0개/);
  assert.match(files.get('사용안내.txt'), /인식된 대사 없음 · 검토 필요/);
  assert.match(files.get('사용안내.txt'), /실제 무음을 뜻하지 않습니다/);
  assert.match(validateSubtitleSegments([]), /segments/);
  assert.equal(validateSubtitleSegments([], { allowEmpty: true }), null);
});

test('mixed batch ZIP counts completed transcriptions separately from actual SRT files', () => {
  const archive = createBatchSrtArchive({ items: [item('말한 인물'), item('조용한 인물', [])] });
  const files = unzipStored(archive.buffer);
  assert.deepEqual(archive.entries, ['01_말한 인물.srt', '사용안내.txt']);
  assert.equal(archive.completedCount, 2);
  assert.equal(archive.includedSrtCount, 1);
  assert.match(files.get('사용안내.txt'), /전사 완료 2건 중 대사가 있는 SRT 1개/);
  assert.match(files.get('사용안내.txt'), /02\. 조용한 인물: 인식된 대사 없음 · 검토 필요 \(SRT 제외\)/);
});

test('unsafe labels cannot escape the ZIP or collide and UTF-8 names remain bounded', () => {
  const labels = ['../../CON\r\n:X', '인물', '인물', 'nul.txt', '😀'.repeat(100)];
  const archive = createBatchSrtArchive({ items: labels.map(label => item(label)) });
  const files = unzipStored(archive.buffer);
  assert.equal(files.size, 6);
  assert.equal(new Set(archive.entries.map(name => name.toLowerCase())).size, 6);
  for (const name of archive.entries) {
    assert.ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(name));
    assert.ok(!name.includes('..'));
    assert.ok(Buffer.byteLength(name, 'utf8') < 255);
    assert.ok(!name.includes('\ufffd'));
  }
  assert.equal(batchSrtFilename('CON', 0), '01__CON.srt');
  assert.equal(batchSrtFilename('한글', 1), '02_한글.srt');
  const boundary = createBatchSrtArchive({ items: [item('x'.repeat(99) + '😀'), item('가'.repeat(99) + '😀')] });
  const boundaryFiles = unzipStored(boundary.buffer);
  assert.deepEqual([...boundaryFiles.keys()], boundary.entries);
  assert.ok(!boundaryFiles.get('사용안내.txt').includes('\ufffd'));
});

test('batch ZIP does not apply stale compact word alignment after text edits', () => {
  const aligned = [{ start: 10, end: 12, text: '네 맞습니다', timingSource: 'word', wordAlignedCues: [[10, 10.2, '네'], [11, 11.3, '맞습니다']] }];
  const edited = [{ ...aligned[0], text: '네 정확합니다' }];
  const archive = createBatchSrtArchive({ items: [item('원본', aligned), item('편집', edited)] });
  const files = unzipStored(archive.buffer);
  assert.match(files.get('01_원본.srt'), /00:00:10,000 --> 00:00:10,200/);
  assert.match(files.get('02_편집.srt'), /00:00:10,000 --> 00:00:12,000/);
  assert.match(files.get('02_편집.srt'), /네 정확합니다/);
});

test('batch ZIP explicitly preserves subsecond gaps that a single ordinary export holds', () => {
  const segments = [{ start: 10, end: 10.2, text: '응답' }, { start: 11, end: 11.4, text: '다음 안내' }];
  const original = structuredClone(segments);
  const files = unzipStored(createBatchSrtArchive({ items: [item('인물', segments)] }).buffer);
  const bundled = files.get('01_인물.srt');
  assert.match(generateSRT(segments), /00:00:10,000 --> 00:00:11,000/);
  assert.match(bundled, /00:00:10,000 --> 00:00:10,200/);
  assert.equal(bundled, generateSRT(segments, null, { holdShortGaps: false }));
  assert.deepEqual(segments, original);
});

test('archive rejects invalid counts, unrecognized states and malformed saved subtitles', () => {
  for (const items of [[], Array.from({ length: 6 }, () => item('인물'))]) {
    assert.throws(() => createBatchSrtArchive({ items }), /1~5개/);
  }
  assert.throws(() => createBatchSrtArchive({ items: [{ label: '대기', status: 'queued' }], allowPartial: true }), { code: 'NO_COMPLETED_BATCH_ITEMS' });
  assert.throws(() => createBatchSrtArchive({ items: [item('인물')], allowPartial: 'true' }), /상태/);
  assert.throws(() => createBatchSrtArchive({ items: [{ ...item('인물'), status: 'toString' }] }), /상태/);
  for (const segments of [null, [{ start: NaN, end: 1, text: '네' }], [{ start: 5, end: 2, text: '네' }], [{ start: 0, end: 1, text: 1 }], [{ start: 0, end: 1, text: 'x'.repeat(10_001) }], Array.from({ length: 5001 }, () => ({ start: 0, end: 1, text: '네' }))]) {
    assert.throws(() => createBatchSrtArchive({ items: [item('인물', segments)] }), { code: 'INVALID_BATCH_SUBTITLES' });
  }
});

test('repeated archive downloads are deterministic and have no mutation dependencies', () => {
  const items = [item('인물')];
  const first = createBatchSrtArchive({ items });
  const second = createBatchSrtArchive({ items });
  assert.ok(first.buffer.equals(second.buffer));
});
