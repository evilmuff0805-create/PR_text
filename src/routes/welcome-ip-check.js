import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { getWelcomeCreditMode } from '../services/welcome-credits.js';
import {
  getWelcomeIpModeConfig,
  getWelcomeIpRequestValue,
  hashWelcomeAbuseKey,
} from '../services/welcome-ip.js';

function probeTokenMatches(req, configuredToken) {
  if (typeof configuredToken !== 'string' || Buffer.byteLength(configuredToken, 'utf8') < 32) return false;
  const authorization = req.headers?.authorization;
  const probeHeader = req.headers?.['x-probe-token'];
  if ((authorization && probeHeader) || (Array.isArray(authorization)) || (Array.isArray(probeHeader))) return false;

  let provided;
  if (typeof authorization === 'string') {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) return false;
    provided = match[1];
  } else if (typeof probeHeader === 'string') {
    provided = probeHeader;
  } else {
    return false;
  }

  const actual = Buffer.from(provided, 'utf8');
  const expected = Buffer.from(configuredToken, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createWelcomeIpCheckRouter({
  envProvider = () => process.env,
  modeProvider = getWelcomeCreditMode,
} = {}) {
  const router = Router();

  router.get('/welcome-ip-check', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const env = envProvider();
    const token = env.WELCOME_CREDIT_IP_PROBE_TOKEN;
    if (!probeTokenMatches(req, token)) return res.status(404).end();

    const mode = modeProvider(env);
    const config = getWelcomeIpModeConfig(env);
    const extracted = getWelcomeIpRequestValue(req);
    let ipHash = null;
    if (extracted.ip && config.hmacReady) {
      ipHash = hashWelcomeAbuseKey('ip', extracted.ip, env.WELCOME_CREDIT_SECURITY_HMAC_KEY);
    }
    const ready = mode === 'ip' && config.trusted && config.hmacReady && Boolean(ipHash);
    const railwayRequestId = req.headers?.['x-railway-request-id'];
    const requestId = typeof railwayRequestId === 'string' && railwayRequestId.length <= 128
      ? railwayRequestId
      : req.requestId || null;

    return res.json({
      ipHash,
      mode,
      ready,
      source: extracted.source,
      requestId,
    });
  });

  return router;
}

export default createWelcomeIpCheckRouter();
