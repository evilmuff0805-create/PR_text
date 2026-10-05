export const DEFAULT_AUTH_RETURN_PATH = '/transcribe';

const AUTH_RETURN_PATHS = new Set([DEFAULT_AUTH_RETURN_PATH, '/settings', '/caption-ideas']);

export function safeAuthReturnPath(value) {
  return AUTH_RETURN_PATHS.has(value) ? value : DEFAULT_AUTH_RETURN_PATH;
}

export function authReturnPathFromSearch(search) {
  return safeAuthReturnPath(new URLSearchParams(search).get('next'));
}
