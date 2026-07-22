const AUTH_RETURN_PATHS = new Set(['/settings', '/caption-ideas']);

export function safeAuthReturnPath(value) {
  return AUTH_RETURN_PATHS.has(value) ? value : '/';
}

export function authReturnPathFromSearch(search) {
  return safeAuthReturnPath(new URLSearchParams(search).get('next'));
}
