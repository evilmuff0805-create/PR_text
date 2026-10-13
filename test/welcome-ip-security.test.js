import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const { getWelcomeIpRequestValue, normalizeWelcomeIp } = await import('../src/services/welcome-ip.js');
const { createWelcomeIpCheckRouter } = await import('../src/routes/welcome-ip-check.js');

test('welcome IP extraction accepts only one valid X-Real-IP value', () => {
  assert.deepEqual(getWelcomeIpRequestValue({
    rawHeaders: ['X-Real-IP', '198.51.100.10', 'X-Forwarded-For', '203.0.113.20'],
    headers: { 'x-real-ip': '198.51.100.10', 'x-forwarded-for': '203.0.113.20' },
  }), { ip: 'v4:198.51.100.10', source: 'x-real-ip' });

  assert.deepEqual(getWelcomeIpRequestValue({
    rawHeaders: ['x-real-ip', '198.51.100.10', 'X-REAL-IP', '198.51.100.11'],
    headers: { 'x-real-ip': '198.51.100.10, 198.51.100.11' },
  }), { ip: null, source: 'invalid' });
  assert.deepEqual(getWelcomeIpRequestValue({
    rawHeaders: ['X-Forwarded-For', '198.51.100.10'],
    headers: { 'x-forwarded-for': '198.51.100.10' },
  }), { ip: null, source: 'invalid' });
  assert.deepEqual(getWelcomeIpRequestValue({
    rawHeaders: ['X-Real-IP', '198.51.100.10, 198.51.100.11'],
    headers: { 'x-real-ip': '198.51.100.10, 198.51.100.11' },
  }), { ip: null, source: 'invalid' });
  assert.equal(normalizeWelcomeIp('::ffff:198.51.100.10'), 'v4:198.51.100.10');
});

async function withProbe(t, env) {
  const app = express();
  app.use('/api/internal', createWelcomeIpCheckRouter({ envProvider: () => env }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  return (headers = {}, suffix = '') => fetch(`http://127.0.0.1:${server.address().port}/api/internal/welcome-ip-check${suffix}`, { headers });
}

test('probe is a no-store 404 when its token is missing, too short, or sent only in the URL', async (t) => {
  const missing = await withProbe(t, { WELCOME_CREDIT_MODE: 'ip' });
  const missingResponse = await missing();
  assert.equal(missingResponse.status, 404);
  assert.equal(missingResponse.headers.get('cache-control'), 'no-store');

  const short = await withProbe(t, { WELCOME_CREDIT_MODE: 'ip', WELCOME_CREDIT_IP_PROBE_TOKEN: 'short' });
  assert.equal((await short({ 'X-Probe-Token': 'short' })).status, 404);

  const configuredToken = 'a'.repeat(40);
  const queryOnly = await withProbe(t, { WELCOME_CREDIT_MODE: 'ip', WELCOME_CREDIT_IP_PROBE_TOKEN: configuredToken });
  assert.equal((await queryOnly({}, `?token=${configuredToken}`)).status, 404);
  assert.equal((await queryOnly({ 'X-Probe-Token': `${configuredToken}x` })).status, 404);
});

test('probe returns only HMAC metadata and works while trusted-proxy activation is still off', async (t) => {
  const token = 'probe-token-value-longer-than-32-bytes';
  const request = await withProbe(t, {
    WELCOME_CREDIT_MODE: 'identity',
    WELCOME_CREDIT_TRUSTED_PROXY_IP: 'false',
    WELCOME_CREDIT_SECURITY_HMAC_KEY: 'dedicated-hmac-key-at-least-32-bytes-long',
    WELCOME_CREDIT_IP_PROBE_TOKEN: token,
  });
  const response = await request({
    Authorization: `Bearer ${token}`,
    'X-Real-IP': '198.51.100.10',
    'X-Railway-Request-Id': 'railway-request-123',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ['ipHash', 'mode', 'ready', 'requestId', 'source'].sort());
  assert.equal(payload.mode, 'identity');
  assert.equal(payload.ready, false);
  assert.equal(payload.source, 'x-real-ip');
  assert.equal(payload.requestId, 'railway-request-123');
  assert.match(payload.ipHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(payload), /198\.51\.100\.10|account|secret/i);
});
