import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Turnstile widget errors wait for explicit user retry instead of remounting in a loop', async () => {
  const source = await readFile(new URL('../client/src/components/WelcomeCreditCard.jsx', import.meta.url), 'utf8');
  const errorHandler = source.match(/const onTurnstileError = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/)?.[0] || '';
  const retryHandler = source.match(/const retryChallenge = async \(\) => \{[\s\S]*?\n  \};/)?.[0] || '';

  assert.match(errorHandler, /setTurnstileToken\(''\)/);
  assert.match(errorHandler, /setError\(/);
  assert.doesNotMatch(errorHandler, /setChallengeReset/);
  assert.match(retryHandler, /setChallengeReset/);
  assert.match(retryHandler, /await loadStatus\(\)/);
});

test('a resolved duplicate identity hides the no-longer-eligible welcome card', async () => {
  const source = await readFile(new URL('../client/src/components/WelcomeCreditCard.jsx', import.meta.url), 'utf8');
  assert.match(source, /response\.status === 409 && data\.status === 'not_eligible'[\s\S]*?setStatus\('hidden'\)/);
});
