import { generateSRT } from './subtitle.js';
import { validateSubtitleSegments } from './subtitle-payload.js';

const MAX_BATCH_FILES = 5;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const STATUS_LABELS = {
  awaiting_upload: '원본 선택 필요',
  ready: '변환 시작 대기',
  queued: '대기 중',
  running: '변환 중',
  finalizing: '결과 저장 중',
  completed: '완료',
  failed: '실패',
  cancelled: '취소',
};
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function archiveError(message, code = 'INVALID_BATCH_ARCHIVE') {
  return Object.assign(new Error(message), { status: 400, code });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function displayLabel(value, index) {
  if (typeof value !== 'string') return `인물 ${index + 1}`;
  const label = value.toWellFormed().normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return [...label].slice(0, 100).join('') || `인물 ${index + 1}`;
}

export function batchSrtFilename(label, index) {
  let base = displayLabel(label, index).replace(/[<>:"/\\|?*]/g, '_').replace(/\.{2,}/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  if (!base) base = `인물 ${index + 1}`;
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base)) base = `_${base}`;
  let bounded = '';
  for (const character of base) {
    if (Buffer.byteLength(bounded + character, 'utf8') > 180) break;
    bounded += character;
  }
  return `${String(index + 1).padStart(2, '0')}_${bounded.trimEnd()}.srt`;
}

// STORE is sufficient for at most five small text exports. The archive contains
// UTF-8 names and standard CRC-32 records, without external runtime dependencies.
function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames, no data descriptor.
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01; deterministic, no source metadata.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, data);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
    centralSize += central.length + name.length;
    if (offset + centralSize + 22 > MAX_ARCHIVE_BYTES) throw archiveError('자막 묶음이 너무 큽니다. 파일별로 내려받아 주세요.', 'BATCH_ARCHIVE_TOO_LARGE');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function createBatchSrtArchive({ items, allowPartial = false } = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH_FILES) {
    throw archiveError('사람별 오디오는 1~5개까지 묶을 수 있습니다.');
  }
  if (typeof allowPartial !== 'boolean' || items.some(item => !item || !Object.hasOwn(STATUS_LABELS, item.status))) {
    throw archiveError('묶음 다운로드 상태가 올바르지 않습니다.');
  }
  const completedCount = items.filter(item => item.status === 'completed').length;
  if (!completedCount) throw archiveError('완료된 자막이 아직 없습니다.', 'NO_COMPLETED_BATCH_ITEMS');
  if (!allowPartial && completedCount !== items.length) {
    throw archiveError(`완료된 ${completedCount}개만 다운로드하려면 부분 다운로드를 선택해 주세요.`, 'PARTIAL_BATCH_CONFIRMATION_REQUIRED');
  }

  const entries = [];
  const statuses = [];
  for (const [index, item] of items.entries()) {
    const label = displayLabel(item.label, index);
    let status = STATUS_LABELS[item.status];
    if (item.status === 'completed') {
      const error = validateSubtitleSegments(item.segments, { allowEmpty: true });
      if (error) throw archiveError(`${index + 1}번 자막: ${error}`, 'INVALID_BATCH_SUBTITLES');
      const recognized = item.segments.some(segment => segment.text.trim() && segment.end > segment.start);
      if (!recognized) status = '인식된 대사 없음 · 검토 필요 (시작 안내만 포함)';
      entries.push({ name: batchSrtFilename(label, index), content: generateSRT(item.segments) });
    }
    statuses.push(`${String(index + 1).padStart(2, '0')}. ${label}: ${status}`);
  }
  entries.push({
    name: '사용안내.txt',
    content: [
      'PR-text 사람별 자막 묶음',
      `전체 ${items.length}개 중 완료된 ${completedCount}개 SRT를 포함합니다.`,
      '',
      ...statuses,
      '',
      '프리미어 프로 가져오기',
      '1. 같은 영상의 0초부터 내보낸 사람별 오디오를 사용하세요. 앞부분 무음을 제거한 파일은 원래 위치를 자동으로 복원할 수 없습니다.',
      '2. SRT를 각각 가져와 인물별 자막 트랙에 같은 시작점으로 놓고 트랙마다 스타일을 지정하세요. 트랙 배치는 직접 진행합니다.',
      '3. 각 SRT의 0~2초 시작 안내 클립만 삭제하세요. 같은 시간에 있는 실제 대사는 삭제하지 마세요.',
      '4. SRT는 밀리초 시간을 저장합니다. 시퀀스 fps는 편집 프로그램에서 설정하며, 이 묶음에서 29.97fps에 맞춰 시간을 재배율하거나 첫 대사를 0초로 이동하지 않습니다.',
      '5. 인물 간 동시 발화는 각각의 파일에 남습니다. 다른 마이크에 들어간 목소리는 편집 화면에서 확인해 주세요.',
      '6. 인식된 대사가 없는 파일은 실제 무음을 뜻하지 않습니다. 원음을 확인하고 필요한 경우 해당 파일만 다시 변환하세요.',
      '',
      '시간은 음성 인식 결과를 사용합니다. 편집 후 텍스트의 단어별 싱크가 자동 재분석되는 기능은 아닙니다.',
      '묶음 다운로드 및 재다운로드는 새 변환을 요청하지 않으며 변환 시간을 추가로 차감하지 않습니다.',
      '',
    ].join('\r\n'),
  });
  return { buffer: createZip(entries), completedCount, entries: entries.map(entry => entry.name), filename: 'person-subtitles.zip' };
}
