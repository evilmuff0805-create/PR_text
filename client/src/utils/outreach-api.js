export function createOutreachApi(getToken, { fetchImpl = globalThis.fetch } = {}) {
  return async function outreachRequest(path, { method = 'GET', body, signal } = {}) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new Error('올바르지 않은 관리자 요청입니다.');
    }
    const token = getToken();
    if (!token) {
      throw Object.assign(new Error('관리자 계정으로 로그인해 주세요.'), { status: 401 });
    }
    let response;
    try {
      response = await fetchImpl(`/api/outreach${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('서버 응답을 확인하지 못했습니다. 상태를 새로고침한 뒤 다시 시도해 주세요.');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw Object.assign(new Error('서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'), { status: response.status });
    }
    if (!response.ok) {
      throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다.'), {
        status: response.status,
        code: data.code,
        rowErrors: data.rowErrors,
      });
    }
    return data;
  };
}
