import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

const HASH_CONTEXT = 'pr-text:welcome-abuse:v1';

function parseIpv6Groups(value) {
  const source = value.toLowerCase();
  const halves = source.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (half) => {
    if (!half) return [];
    const parts = half.split(':');
    const groups = [];
    for (const part of parts) {
      if (part.includes('.')) {
        if (isIP(part) !== 4 || part !== parts.at(-1)) return null;
        const octets = part.split('.').map(Number);
        groups.push(((octets[0] << 8) | octets[1]).toString(16));
        groups.push(((octets[2] << 8) | octets[3]).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        groups.push(part);
      } else {
        return null;
      }
    }
    return groups;
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left.map((part) => parseInt(part, 16)) : null;

  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [
    ...left.map((part) => parseInt(part, 16)),
    ...Array(missing).fill(0),
    ...right.map((part) => parseInt(part, 16)),
  ];
}

export function normalizeWelcomeIp(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  const family = isIP(input);
  if (family === 4) {
    return `v4:${input.split('.').map((part) => String(Number(part))).join('.')}`;
  }
  if (family !== 6) return null;

  const groups = parseIpv6Groups(input);
  if (!groups || groups.length !== 8) return null;

  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const first = groups[6];
    const second = groups[7];
    return `v4:${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
  }

  return `v6:${groups.slice(0, 4).map((group) => group.toString(16).padStart(4, '0')).join(':')}/64`;
}

export function hashWelcomeAbuseKey(kind, value, secret = process.env.WELCOME_CREDIT_SECURITY_HMAC_KEY) {
  if (!secret) throw new Error('무료 체험 확인을 위한 서버 보안 키가 설정되지 않았습니다.');
  if (!['ip', 'account'].includes(kind) || typeof value !== 'string' || !value) {
    throw new Error('무료 체험 확인 정보가 올바르지 않습니다.');
  }

  return createHmac('sha256', secret)
    .update(`${HASH_CONTEXT}\0${kind}\0${value}`)
    .digest('hex');
}

export function getWelcomeAbuseHashes(requestIp, userId, secret = process.env.WELCOME_CREDIT_SECURITY_HMAC_KEY) {
  const normalizedIp = normalizeWelcomeIp(requestIp);
  if (!normalizedIp) throw new Error('요청 IP를 확인하지 못했습니다.');
  if (typeof userId !== 'string' || !userId) throw new Error('계정 정보를 확인하지 못했습니다.');

  return {
    ipHash: hashWelcomeAbuseKey('ip', normalizedIp, secret),
    accountHash: hashWelcomeAbuseKey('account', userId, secret),
  };
}
