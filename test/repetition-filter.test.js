import assert from 'node:assert/strict';
import test from 'node:test';
import { filterWhisperRepetitionLoops } from '../src/services/transcription-processing.js';

const loopMetadata = {
  seek: 0,
  avg_logprob: -0.8258804082870483,
  compression_ratio: 1.7222222089767456,
  no_speech_prob: 0.11404582858085632,
};

function repeatedSegments({
  count,
  text = '아 진짜요?',
  start = 376.793,
  duration = 1.1,
  metadata = loopMetadata,
  speaker,
}) {
  return Array.from({ length: count }, (_, index) => ({
    start: start + index * duration,
    end: start + (index + 1) * duration,
    text,
    ...metadata,
    ...(speaker === undefined ? {} : { speaker }),
  }));
}

test('removes the reported low-confidence repetition loop and its next-window echo', () => {
  const before = {
    start: 374.613,
    end: 376.793,
    text: '진짜 아무 일도 없었어요.',
    ...loopMetadata,
  };
  const loop = repeatedSegments({ count: 7 });
  const echo = {
    start: loop.at(-1).end,
    end: loop.at(-1).end + 1.68,
    text: '진짜 아무 일도 없었어요.',
    seek: 2880,
    avg_logprob: -0.6930586099624634,
    compression_ratio: 1.009523868560791,
    no_speech_prob: 0.00003647841731435619,
  };
  const after = {
    start: echo.end + 1.44,
    end: echo.end + 8.52,
    text: '아. 결국엔.',
    seek: 2880,
    avg_logprob: -0.6930586099624634,
    compression_ratio: 1.009523868560791,
  };

  assert.deepEqual(
    filterWhisperRepetitionLoops([before, ...loop, echo, after]),
    [before, after],
  );
});

test('keeps ordinary repetitions below the minimum run length', () => {
  const input = repeatedSegments({ count: 3 });

  assert.deepEqual(filterWhisperRepetitionLoops(input), input);
});

test('keeps high-confidence repeated speech', () => {
  const input = repeatedSegments({
    count: 5,
    metadata: {
      seek: 0,
      avg_logprob: -0.2,
      compression_ratio: 1.8,
    },
  });

  assert.deepEqual(filterWhisperRepetitionLoops(input), input);
});

test('keeps repeated speech when provider evidence is missing', () => {
  const input = repeatedSegments({ count: 5, metadata: {} });

  assert.deepEqual(filterWhisperRepetitionLoops(input), input);
});

test('never changes speaker-labeled diarization segments', () => {
  const input = repeatedSegments({ count: 7, speaker: 0 });

  assert.deepEqual(filterWhisperRepetitionLoops(input), input);
});

test('keeps irregular-duration repetitions that can represent real speech', () => {
  const durations = [0.5, 0.9, 1.4, 0.7, 1.2];
  let cursor = 20;
  const input = durations.map((duration) => {
    const segment = {
      start: cursor,
      end: cursor + duration,
      text: '안 돼',
      ...loopMetadata,
    };
    cursor += duration;
    return segment;
  });

  assert.deepEqual(filterWhisperRepetitionLoops(input), input);
});

test('removes only the evidence-gated loop and preserves surrounding timestamps', () => {
  const before = { start: 8, end: 10, text: '앞 문장입니다' };
  const loop = repeatedSegments({ count: 4, start: 10 });
  const after = { start: loop.at(-1).end + 0.5, end: 17, text: '다음 문장입니다' };

  assert.deepEqual(filterWhisperRepetitionLoops([before, ...loop, after]), [before, after]);
});

test('keeps a matching phrase after the loop when it stays in the same decode window', () => {
  const before = { start: 8, end: 10, text: '앞 문장입니다', ...loopMetadata };
  const loop = repeatedSegments({ count: 4, start: 10 });
  const repeatedAfter = {
    start: loop.at(-1).end,
    end: loop.at(-1).end + 2,
    text: before.text,
    ...loopMetadata,
  };

  assert.deepEqual(
    filterWhisperRepetitionLoops([before, ...loop, repeatedAfter]),
    [before, repeatedAfter],
  );
});

test('keeps a high-confidence matching phrase at the next decode window', () => {
  const before = { start: 8, end: 10, text: '앞 문장입니다', ...loopMetadata };
  const loop = repeatedSegments({ count: 4, start: 10 });
  const repeatedAfter = {
    start: loop.at(-1).end,
    end: loop.at(-1).end + 2,
    text: before.text,
    seek: 2880,
    avg_logprob: -0.2,
    compression_ratio: 1.1,
  };

  assert.deepEqual(
    filterWhisperRepetitionLoops([before, ...loop, repeatedAfter]),
    [before, repeatedAfter],
  );
});
