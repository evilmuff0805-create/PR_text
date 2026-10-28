import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { createBatchSrtArchive } from '../src/services/batch-archive.js';

// Read the ZIP through its directory and verify every payload with Node's
// native CRC implementation, independent from the writer's JavaScript table.
function readArchive(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let directory = bytes.readUInt32LE(end + 16);
  assert.equal(directory + bytes.readUInt32LE(end + 12), end);
  const entries = new Map();
  let localEnd = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(directory), 0x02014b50);
    const flags = bytes.readUInt16LE(directory + 8);
    assert.equal(flags, 0x0800);
    assert.equal(bytes.readUInt16LE(directory + 10), 0);
    const size = bytes.readUInt32LE(directory + 24);
    assert.equal(bytes.readUInt32LE(directory + 20), size);
    const nameLength = bytes.readUInt16LE(directory + 28);
    const extraLength = bytes.readUInt16LE(directory + 30);
    const commentLength = bytes.readUInt16LE(directory + 32);
    const nameBytes = bytes.subarray(directory + 46, directory + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const offset = bytes.readUInt32LE(directory + 42);
    assert.equal(offset, localEnd);
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    assert.equal(bytes.readUInt16LE(offset + 6), flags);
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    assert.equal(bytes.readUInt32LE(offset + 22), size);
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    assert.deepEqual(bytes.subarray(offset + 30, offset + 30 + localNameLength), nameBytes);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    const payload = bytes.subarray(dataStart, dataStart + size);
    assert.equal(payload.length, size);
    assert.equal(crc32(payload), bytes.readUInt32LE(directory + 16));
    assert.equal(crc32(payload), bytes.readUInt32LE(offset + 14));
    assert.ok(!entries.has(name), 'entry names must be unique');
    entries.set(name, payload.toString('utf8'));
    localEnd = dataStart + size;
    directory += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(localEnd, bytes.readUInt32LE(end + 16));
  assert.equal(directory, end);
  return entries;
}

function millis(value) {
  const [hours, minutes, seconds, fraction] = value.split(/[:,]/).map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction;
}

function readSrt(text) {
  return text.trim().split(/\r?\n\r?\n/).map((block, index) => {
    const [number, timing, ...content] = block.split(/\r?\n/);
    assert.equal(Number(number), index + 1);
    const [start, end] = timing.split(' --> ');
    return { start: millis(start), end: millis(end), text: content.join('\n') };
  });
}

const completed = (label, segments) => ({ label, status: 'completed', segments });

test('QA ZIP native CRC and UTF-8 directory roundtrip includes a surrogate cutoff boundary', () => {
  const labels = ['../NUL:\u202e', 'same', 'same', `${'x'.repeat(99)}😀`, '사람'];
  const archive = createBatchSrtArchive({ items: labels.map(label => completed(label, [])) });
  const contents = readArchive(archive.buffer);
  assert.deepEqual([...contents.keys()], archive.entries);
  assert.deepEqual(archive.entries, ['사용안내.txt']);
  for (const name of contents.keys()) {
    assert.equal(name, name.normalize('NFC'));
    assert.ok(!/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name));
    assert.ok(!name.includes('..'));
    assert.ok(!name.includes('\ufffd'), 'valid Unicode input must not produce replacement characters');
    assert.ok(Buffer.byteLength(name, 'utf8') < 255);
  }
  assert.ok(!contents.get('사용안내.txt').includes('\ufffd'));
});

test('QA independent SRT clocks ceil starts and preserve cross-file overlap, pauses and raw 29.97 time', () => {
  const frame = 1_234_567;
  const lateStart = frame * 1001 / 30000;
  const first = [
    { start: 0.3334, end: 0.4634, text: '네' },
    { start: 61.0049, end: 61.1899, text: '확인했습니다' },
    { start: lateStart, end: lateStart + 0.193, text: '마지막 확인' },
  ];
  const second = [{ start: 61.0051, end: 61.2191, text: '저도 확인했습니다' }];
  const before = structuredClone([first, second]);
  const archive = createBatchSrtArchive({ items: [completed('track A', first), completed('track B', second)] });
  const contents = readArchive(archive.buffer);
  for (const [index, segments] of [first, second].entries()) {
    const cues = readSrt(contents.get(archive.entries[index]));
    assert.deepEqual(cues, segments.map(segment => ({
      start: Math.ceil(segment.start * 1000), end: Math.round(segment.end * 1000), text: segment.text,
    })));
    for (const [cueIndex, segment] of segments.entries()) {
      const cue = cues[cueIndex];
      const rawStartMs = segment.start * 1000;
      assert.ok(cue.start >= rawStartMs, 'serialized start must never precede its raw start');
      assert.ok(cue.start - rawStartMs < 1, 'start ceiling may delay less than one millisecond');
      assert.equal(cue.end, Math.round(segment.end * 1000), 'end keeps nearest-millisecond precision');
    }
  }
  const firstDialogue = readSrt(contents.get(archive.entries[0]))[1];
  const secondDialogue = readSrt(contents.get(archive.entries[1]))[0];
  assert.ok(Math.max(firstDialogue.start, secondDialogue.start) < Math.min(firstDialogue.end, secondDialogue.end),
    'simultaneous speech must remain overlapping across separate files');
  assert.deepEqual([first, second], before);
});

test('QA per-file 5000-row compact alignment expands without a shared bundle row limit', () => {
  const segments = Array.from({ length: 5000 }, (_, index) => {
    const start = 30 + index * 2;
    return { start, end: start + 1.3, text: '네 다음', timingSource: 'word', wordAlignedCues: [
      [start, start + 0.2, '네'], [start + 1.1, start + 1.3, '다음'],
    ] };
  });
  const archive = createBatchSrtArchive({ items: [completed('A', segments), completed('B', segments)] });
  const contents = readArchive(archive.buffer);
  for (const name of archive.entries.filter(name => name.endsWith('.srt'))) {
    const cues = readSrt(contents.get(name));
    assert.equal(cues.length, 10000);
    assert.deepEqual(cues[0], { start: 30000, end: 30200, text: '네' });
    assert.deepEqual(cues.at(-1), { start: 10029100, end: 10029300, text: '다음' });
  }
});

test('QA edited snapshots and partial states stay explicit without mutating saved data', () => {
  const original = [{ start: 5, end: 5.5, text: '이전 문안' }];
  const edited = [{ ...original[0], text: '수정 문안' }];
  const items = [completed('A', edited), { label: 'B', status: 'failed' }, completed('C', [])];
  assert.throws(() => createBatchSrtArchive({ items }), { code: 'PARTIAL_BATCH_CONFIRMATION_REQUIRED' });
  const archive = createBatchSrtArchive({ items, allowPartial: true });
  const contents = readArchive(archive.buffer);
  assert.deepEqual(archive.entries, ['01_A.srt', '사용안내.txt']);
  assert.equal(readSrt(contents.get('01_A.srt'))[0].text, '수정 문안');
  assert.match(contents.get('사용안내.txt'), /02\. B: 실패/);
  assert.match(contents.get('사용안내.txt'), /인식된 대사 없음 · 검토 필요 \(SRT 제외\)/);
  assert.match(contents.get('사용안내.txt'), /전사 완료 2건 중 대사가 있는 SRT 1개/);
  assert.ok(createBatchSrtArchive({ items, allowPartial: true }).buffer.equals(archive.buffer));
  assert.equal(original[0].text, '이전 문안');
});
