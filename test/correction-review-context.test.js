import assert from 'node:assert/strict';
import test from 'node:test';
import { processSegmentsWithTiming, evaluateSpokenTextCorrection } from '../src/services/postprocess.js';
process.env.OPENAI_API_KEY ||= 'test-key-not-real';
const { buildCorrectionRequest } = await import('../src/services/gpt.js');

test('chunk reference context is bounded and disjoint from target lines without changing model settings', () => {
  const request = buildCorrectionRequest('대상 첫 줄\n대상 둘째 줄', 'gpt-6-luna', {
    contextBefore: ['앞 대화', '가'.repeat(400), '또 앞 대화', '제외할 네 번째 줄'], contextAfter: ['뒤 대화'],
  });
  const data = JSON.parse(request.messages[1].content);
  assert.deepEqual(data.targetLines, ['대상 첫 줄', '대상 둘째 줄']);
  assert.equal(data.readOnlyBefore.length, 3);
  assert.equal(data.readOnlyBefore[1].length, 280);
  assert.deepEqual(data.readOnlyAfter, ['뒤 대화']);
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.reasoning_effort, 'medium');
  assert.match(request.messages[0].content, /수정·출력·복사하지 마세요/);
});

test('target correction reads neighbouring chunks but does not request extra output rows', async () => {
  const source = Array.from({ length: 64 }, (_, index) => ({ start: index, end: index + .8, text: `대화 ${index}` }));
  const contexts = [];
  const result = await processSegmentsWithTiming(source, 'ko', async (text, language, context) => {
    contexts.push({ text, language, context }); return text;
  });
  assert.equal(contexts.length, 3);
  assert.deepEqual(contexts[1].context.contextBefore, ['대화 27', '대화 28', '대화 29']);
  assert.deepEqual(contexts[1].context.contextAfter, ['대화 60', '대화 61', '대화 62']);
  assert.equal(contexts[1].text.split('\n').length, 30);
  assert.deepEqual(result.segments, source);
});

test('guarded candidates are separate from active text and never become user-confirmed automatically', async () => {
  const source = [{ start: 1, end: 3, text: '네 네 네 이거 몇일 걸려요' }];
  const result = await processSegmentsWithTiming(source, 'ko', async () => '네 네 이거 며칠 걸려요', { includeReviews: true });
  assert.equal(result.segments[0].text, source[0].text);
  assert.equal(result.segments[0].subtitleReview.candidateText, '네 네 이거 며칠 걸려요');
  assert.equal(result.segments[0].subtitleReview.textStatus, 'candidate');
  assert.equal(result.segments[0].subtitleReview.timingStatus, 'unverified');
  assert.equal(result.segments[0].subtitleReview.issues[0].reason, 'repetition_change');
  assert.equal(evaluateSpokenTextCorrection('3.5 킬로면 되요', '35 킬로면 돼요').reason, 'numeric_change');
  assert.deepEqual(source, [{ start: 1, end: 3, text: '네 네 네 이거 몇일 걸려요' }]);
});
