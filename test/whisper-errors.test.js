import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';

process.env.OPENAI_API_KEY ||= 'test-key';

const { buildTranscriptionRequestOptions, normalizeTranscriptionError } = await import('../src/services/whisper.js');

test('request correlation preserves the configured timeout, retry budget, and abort signal', () => {
  const signal = new AbortController().signal;
  const options = buildTranscriptionRequestOptions({
    timeout: 123_000,
    maxRetries: 1,
    signal,
    headers: { 'X-Diagnostic-Test': 'preserved' },
  }, '7a2d41de-8f08-49c7-8f88-cf704494fc86');

  assert.equal(options.timeout, 123_000);
  assert.equal(options.maxRetries, 1);
  assert.equal(options.signal, signal);
  assert.equal(options.headers['X-Diagnostic-Test'], 'preserved');
  assert.equal(options.headers['X-Client-Request-Id'], '7a2d41de-8f08-49c7-8f88-cf704494fc86');
});

test('ordinary transcription classifies timeout before its connection-error parent', () => {
  const source = new OpenAI.APIConnectionTimeoutError();
  source.timings = {
    openaiMs: 600_000,
    openaiAttempts: [{
      phase: 'initial',
      outcome: 'error',
      durationMs: 600_000,
      clientRequestId: '7a2d41de-8f08-49c7-8f88-cf704494fc86',
      maxRetries: 4,
    }],
  };

  const error = normalizeTranscriptionError(source);

  assert.equal(source instanceof OpenAI.APIConnectionError, true);
  assert.equal(error.code, 'TIMEOUT');
  assert.equal(error.providerErrorType, 'APIConnectionTimeoutError');
  assert.deepEqual(error.timings, source.timings);
});

test('ordinary transcription keeps connection failures distinct and carries diagnostics', () => {
  const source = new OpenAI.APIConnectionError({ message: 'socket closed' });
  source.timings = { openaiMs: 2_500 };

  const error = normalizeTranscriptionError(source);

  assert.equal(error.code, 'CONNECTION');
  assert.equal(error.providerErrorType, 'APIConnectionError');
  assert.deepEqual(error.timings, source.timings);
});
