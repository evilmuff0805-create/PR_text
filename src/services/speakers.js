export const MAX_SPEAKERS = 20;

function providerLabelKey(value) {
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `number:${value}`;
  if (value === null) return 'null';
  return `${typeof value}:${String(value)}`;
}

export function normalizeProviderSpeakerLabels(segments) {
  if (!Array.isArray(segments)) return [];

  const speakerIds = new Map();
  return segments.map((segment) => {
    const key = providerLabelKey(segment?.speaker);
    if (!speakerIds.has(key)) {
      if (speakerIds.size >= MAX_SPEAKERS) {
        throw new Error(`화자 수가 최대 ${MAX_SPEAKERS}명을 초과했습니다.`);
      }
      speakerIds.set(key, speakerIds.size);
    }

    return {
      ...segment,
      speaker: speakerIds.get(key),
    };
  });
}

function parseSpeakerColorIds(speakerColors) {
  if (speakerColors === undefined || speakerColors === null) return { ids: [] };
  if (typeof speakerColors !== 'object' || Array.isArray(speakerColors)) {
    return { error: '화자 색상 형식이 올바르지 않습니다.' };
  }

  const ids = [];
  for (const key of Object.keys(speakerColors)) {
    if (!/^-?\d+$/.test(key)) return { error: '화자 색상 값이 올바르지 않습니다.' };
    const id = Number(key);
    if (!Number.isSafeInteger(id)) return { error: '화자 색상 값이 올바르지 않습니다.' };
    ids.push(id);
  }
  return { ids };
}

export function normalizeStoredSpeakerMetadata(segments, speakerColors) {
  if (!Array.isArray(segments)) return { segments, speakerColors, error: null };

  const rawIds = [];
  for (const segment of segments) {
    if (segment?.speaker === undefined) continue;
    if (!Number.isSafeInteger(segment.speaker)) {
      return { segments, speakerColors, error: '화자 정보가 올바르지 않습니다.' };
    }
    rawIds.push(segment.speaker);
  }

  const parsedColors = parseSpeakerColorIds(speakerColors);
  if (parsedColors.error) return { segments, speakerColors, error: parsedColors.error };
  rawIds.push(...parsedColors.ids);

  const uniqueIds = [...new Set(rawIds)];
  if (uniqueIds.length > MAX_SPEAKERS) {
    return { segments, speakerColors, error: '화자 수가 너무 많습니다.' };
  }

  const usedIds = new Set(uniqueIds.filter((id) => id >= 0 && id < MAX_SPEAKERS));
  const remappedIds = new Map();
  for (const id of uniqueIds) {
    if (id >= 0 && id < MAX_SPEAKERS) {
      remappedIds.set(id, id);
      continue;
    }

    let replacement = 0;
    while (replacement < MAX_SPEAKERS && usedIds.has(replacement)) replacement += 1;
    if (replacement >= MAX_SPEAKERS) {
      return { segments, speakerColors, error: '화자 수가 너무 많습니다.' };
    }
    usedIds.add(replacement);
    remappedIds.set(id, replacement);
  }

  const normalizedSegments = segments.map((segment) => (
    segment?.speaker === undefined
      ? segment
      : { ...segment, speaker: remappedIds.get(segment.speaker) }
  ));

  const normalizedColors = speakerColors === undefined || speakerColors === null
    ? speakerColors
    : Object.fromEntries(Object.entries(speakerColors).map(([id, color]) => [
      String(remappedIds.get(Number(id))),
      color,
    ]));

  return {
    segments: normalizedSegments,
    speakerColors: normalizedColors,
    error: null,
  };
}
