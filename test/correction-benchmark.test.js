import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateOutput,
  marginScenario,
  summarizeReplayQuality,
  validateReplaySegments,
} from '../scripts/compare-correction-models.js';

test('evaluates exact expected Korean correction output by line', () => {
  assert.deepEqual(
    evaluateOutput('오늘 날씨가 좋아요\n그래서 나갔어', '오늘 날씨가 좋아요\n그래서 나갔어'),
    {
      lineCountPassed: true,
      expectedLineMatches: 2,
      expectedLineTotal: 2,
      exactMatch: true,
    }
  );
});

test('tracks replay line preservation and changes without exposing text', () => {
  const quality = summarizeReplayQuality(
    [{ text: '첫째 줄' }, { text: '둘째 줄' }],
    [{ text: '첫째 줄' }, { text: '둘째 줄 수정' }]
  );

  assert.deepEqual(quality, {
    lineCountPassed: true,
    originalLineCount: 2,
    processedLineCount: 2,
    changedLineCount: 1,
    changedLineRate: 0.5,
  });
});

test('normalizes and validates replay segments', () => {
  assert.deepEqual(validateReplaySegments([
    { start: '0', end: '1.2', text: ' 첫 번째 줄 ' },
    { start: 1.2, end: 2, text: '   ' },
  ]), [{ start: 0, end: 1.2, text: '첫 번째 줄' }]);
  assert.throws(() => validateReplaySegments([]), /전사 세그먼트가 없습니다/);
});

test('calculates correction-only margin for a real audio duration', () => {
  const scenario = marginScenario(0.05, 600, 1400);

  assert.equal(scenario.basic.audioMinutes, 10);
  assert.equal(scenario.basic.correctionCostKrw, 70);
  assert.equal(scenario.basic.revenueKrw, 590);
  assert.equal(scenario.basic.marginBeforeOtherCostsKrw, 520);
});

