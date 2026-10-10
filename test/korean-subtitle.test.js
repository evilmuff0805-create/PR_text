import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  findKoreanSubtitleCutAt,
  isKoreanDependentPredicateTail,
  splitKoreanSubtitleText,
} from '../src/services/korean-subtitle.js';

const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim();

function assertWordPreservation(text, parts, maxChars = 28) {
  assert.equal(parts.join(' '), normalize(text));
  assert.ok(parts.every(part => part.length > 0 && part.length <= maxChars));
  assert.ok(parts.every(part => !/[\r\n\t]/.test(part)));
}

test('balances a long adverbial phrase while keeping its final conditional predicate together', () => {
  const text = '편안하게 생각이 흐르는 대로 경험을 통해 떠올리면 됩니다';
  const parts = splitKoreanSubtitleText(text);
  assert.deepEqual(parts, ['편안하게 생각이 흐르는 대로', '경험을 통해 떠올리면 됩니다']);
  assertWordPreservation(text, parts);
  assert.equal(findKoreanSubtitleCutAt(text), parts[0].length);
});

test('keeps negative and obligatory compound predicates in the following phrase', () => {
  const cases = [
    ['오늘 받은 내용을 다시 확인하고 실수하지 않아야 합니다',
      ['오늘 받은 내용을 다시 확인하고', '실수하지 않아야 합니다']],
    ['새로운 작업 방식은 무리하지 않아도 충분히 마무리할 수 있습니다',
      ['새로운 작업 방식은 무리하지 않아도', '충분히 마무리할 수 있습니다']],
    ['복잡한 확인 절차는 그리 어렵지 않으니 지금부터 차근차근 진행하면 됩니다',
      ['복잡한 확인 절차는 그리 어렵지 않으니', '지금부터 차근차근 진행하면 됩니다']],
  ];
  for (const [text, expected] of cases) {
    const parts = splitKoreanSubtitleText(text);
    assert.deepEqual(parts, expected);
    assertWordPreservation(text, parts);
  }
});

test('keeps quotations, question words, and reporting predicates together', () => {
  const cases = [
    ['새로운 진행 방향을 충분히 확인했는데 어떻게 하라고 하셨더라?',
      ['새로운 진행 방향을 충분히 확인했는데', '어떻게 하라고 하셨더라?']],
    ['담당자에게 내용을 전달했다고 다시 한번 이야기해 주시면 됩니다',
      ['담당자에게 내용을', '전달했다고 다시 한번 이야기해 주시면 됩니다']],
  ];
  for (const [text, expected] of cases) {
    const parts = splitKoreanSubtitleText(text);
    assert.deepEqual(parts, expected);
    assertWordPreservation(text, parts);
  }
});

test('keeps bound nouns and short auxiliary predicate sequences intact', () => {
  const text = '이번 과정은 필요한 자료를 차례대로 설명해 드릴 수 있습니다';
  const parts = splitKoreanSubtitleText(text);
  assert.deepEqual(parts, ['이번 과정은 필요한 자료를', '차례대로 설명해 드릴 수 있습니다']);
  assert.ok(parts.some(part => part.includes('설명해 드릴 수 있습니다')));
  assertWordPreservation(text, parts);
});

test('keeps modifiers and their following nouns with dependent adverbs', () => {
  const text = '아주 오래도록 오랫동안 준비했던 매우 아름다운 사진들을 보여드릴게요';
  const parts = splitKoreanSubtitleText(text);
  assert.ok(parts.some(part => part.includes('매우 아름다운 사진들을')));
  assert.equal(parts.some(part => /(?:매우|아름다운)$/.test(part)), false);
  assertWordPreservation(text, parts);
});

test('keeps a separated source particle with the noun before it', () => {
  const text = '확인한 다음에는 준비한 자료를 그 담당자 에게 전달하면 됩니다';
  const parts = splitKoreanSubtitleText(text);
  assert.ok(parts.some(part => part.includes('담당자 에게')));
  assert.equal(parts.some(part => /^에게(?: |$)/.test(part)), false);
  assertWordPreservation(text, parts);
});

test('preserves mixed English words, URLs, decimals, and punctuation', () => {
  const text = '파일은 3.5초 뒤에 demo.example.com에서 내려받으면 됩니다';
  const parts = splitKoreanSubtitleText(text);
  assert.deepEqual(parts, ['파일은 3.5초 뒤에', 'demo.example.com에서 내려받으면 됩니다']);
  assertWordPreservation(text, parts);
  assert.deepEqual(splitKoreanSubtitleText('값은 3.5입니다. 맞나요?'), ['값은 3.5입니다. 맞나요?']);
});

test('preserves repeated speech and normalizes edited whitespace into one line', () => {
  const text = '\t천천히\r\n천천히 같은 말을  다시 다시 떠올리면 됩니다  ';
  const parts = splitKoreanSubtitleText(text);
  assertWordPreservation(text, parts);
  assert.equal(parts.join(' ').split('천천히').length - 1, 2);
  assert.equal(parts.join(' ').split('다시').length - 1, 2);
});

test('leaves short text unchanged and handles empty values without inventing dialogue', () => {
  for (const text of ['짧은 표현입니다', '네!', '됩니다', '말해 줘요', '가'.repeat(28)]) {
    assert.deepEqual(splitKoreanSubtitleText(text), [text]);
    assert.equal(findKoreanSubtitleCutAt(text), text.length);
  }
  for (const text of ['', ' \t\r\n', null, undefined]) {
    assert.deepEqual(splitKoreanSubtitleText(text), []);
    assert.equal(findKoreanSubtitleCutAt(text), 0);
  }
});

test('respects custom caps and rejects invalid limits', () => {
  const text = '내용을 차례대로 설명해 드릴 수 있습니다';
  assertWordPreservation(text, splitKoreanSubtitleText(text, 16), 16);
  for (const maxChars of [0, -1, 1.5, NaN, Infinity, '28', null]) {
    assert.throws(() => splitKoreanSubtitleText(text, maxChars), RangeError);
    assert.throws(() => findKoreanSubtitleCutAt(text, maxChars), RangeError);
  }
});

test('splits only an overlong unspaced word when the hard cap requires it', () => {
  const text = '가'.repeat(70);
  const parts = splitKoreanSubtitleText(text);
  assert.deepEqual(parts.map(part => part.length), [28, 28, 14]);
  assert.equal(parts.join(''), text);
  const mixed = `앞말 ${'나'.repeat(65)} 뒷말`;
  const mixedParts = splitKoreanSubtitleText(mixed);
  assert.ok(mixedParts.every(part => part.length <= 28 && part.length > 0));
  assert.equal(mixedParts.join('').replace(/ /g, ''), mixed.replace(/ /g, ''));
});

test('recognizes only short Korean predicate tails with a dependent predecessor', () => {
  const cases = [
    ['경험을 통해 떠올리면', '됩니다'],
    ['실수하지', '않아야 합니다'],
    ['어렵지', '않습니다'],
    ['자료를 설명해', '드릴 수 있습니다'],
    ['자료를 확인할 수', '있습니다'],
    ['자료를 전달했다고', '합니다'],
    ['이야기하고', '있습니다'],
    ['중요한 것이', '아닙니다'],
  ];
  for (const [previous, tail] of cases) {
    assert.equal(isKoreanDependentPredicateTail(previous, tail), true, `${previous} / ${tail}`);
  }
});

test('rejects independent sentences, raw terminal punctuation, non-Korean, and long tails', () => {
  const cases = [
    ['이미 끝났습니다', '됩니다'],
    ['아직 검토하는데요', '됩니다'],
    ['오늘 일정', '됩니다'],
    ['자료를 설명해.', '드릴 수 있습니다'],
    ['자료를 확인하면?', '됩니다'],
    ['자료를 확인하면!"', '됩니다'],
    ['자료를 확인하면。', '됩니다'],
    ['It is ready', '됩니다'],
    ['자료를 확인하면', 'It is ready'],
    ['자료를 설명해', '드릴 수 있는 여러 자료를 준비하고 있습니다'],
    ['', '됩니다'],
  ];
  for (const [previous, tail] of cases) {
    assert.equal(isKoreanDependentPredicateTail(previous, tail), false, `${previous} / ${tail}`);
  }
});

test('plans 10,000-character spaced and unspaced inputs in one call', () => {
  for (const text of [
    '다양한 작업 내용을 확인하고 필요한 정보를 정리하면 됩니다 '.repeat(400).slice(0, 10_000).trim(),
    '가'.repeat(10_000),
  ]) {
    const startedAt = performance.now();
    const parts = splitKoreanSubtitleText(text);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(parts.every(part => part.length > 0 && part.length <= 28));
    assert.equal(parts.join('').replace(/ /g, ''), text.replace(/ /g, ''));
    assert.ok(elapsedMs < 5_000, `one 10,000-character plan took ${elapsedMs.toFixed(1)}ms`);
  }
});
