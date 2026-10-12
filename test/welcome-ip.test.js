import assert from 'node:assert/strict';
import test from 'node:test';

const {
  getWelcomeAbuseHashes,
  hashWelcomeAbuseKey,
  normalizeWelcomeIp,
} = await import('../src/services/welcome-ip.js');

test('normalizes IPv4-mapped IPv6 to the same identity as IPv4', () => {
  assert.equal(normalizeWelcomeIp('203.0.113.8'), 'v4:203.0.113.8');
  assert.equal(normalizeWelcomeIp('::ffff:203.0.113.8'), 'v4:203.0.113.8');
  assert.equal(normalizeWelcomeIp('0:0:0:0:0:ffff:cb00:7108'), 'v4:203.0.113.8');
});

test('groups IPv6 addresses by canonical /64 prefix', () => {
  assert.equal(normalizeWelcomeIp('2001:db8:1:2::1'), 'v6:2001:0db8:0001:0002/64');
  assert.equal(normalizeWelcomeIp('2001:0DB8:0001:0002:0000:0000:0000:ffff'), 'v6:2001:0db8:0001:0002/64');
  assert.notEqual(normalizeWelcomeIp('2001:db8:1:3::1'), normalizeWelcomeIp('2001:db8:1:2::1'));
});

test('rejects invalid or non-IP request values', () => {
  for (const value of ['', 'unknown', '203.0.113.999', '2001:db8:::1', ' 127.0.0.1, 10.0.0.1']) {
    assert.equal(normalizeWelcomeIp(value), null);
  }
});

test('HMAC keys are scoped, stable, and do not expose their source values', () => {
  const ip = '2001:db8:1:2::1';
  const userId = '715ed5db-f090-4b8c-a067-640ecee36aa0';
  const first = getWelcomeAbuseHashes(ip, userId, 'dedicated-test-key');
  const second = getWelcomeAbuseHashes('2001:0db8:0001:0002::ffff', userId, 'dedicated-test-key');

  assert.deepEqual(first, second);
  assert.match(first.ipHash, /^[0-9a-f]{64}$/);
  assert.match(first.accountHash, /^[0-9a-f]{64}$/);
  assert.notEqual(first.ipHash, first.accountHash);
  assert.equal(JSON.stringify(first).includes(ip), false);
  assert.notEqual(hashWelcomeAbuseKey('account', userId, 'other-key'), first.accountHash);
});

test('fails closed when security key or trusted IP is unavailable', () => {
  assert.throws(() => hashWelcomeAbuseKey('ip', 'v4:203.0.113.8', ''), /보안 키/);
  assert.throws(() => getWelcomeAbuseHashes(undefined, 'user', 'key'), /요청 IP/);
});
