import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const LIMIT = 20;

function formatDate(iso) {
  const date = new Date(iso);
  return date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getCaptionModeLabel(mode) {
  if (mode === 'entertainment') return '예능';
  if (mode === 'situation') return '상황';
  if (mode === 'emotion') return '감성';
  return '자막';
}

export default function CaptionIdeaHistory({ refreshKey = 0 }) {
  const { user, getToken } = useAuth();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [copiedIdeaKey, setCopiedIdeaKey] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const copyTimerRef = useRef(null);
  const activeUserRef = useRef(user?.id);
  activeUserRef.current = user?.id;

  useEffect(() => {
    setItems([]);
    setTotal(0);
    setPage(1);
    setLoadingMore(false);
    setError('');
    setCopiedIdeaKey(null);
    setAnnouncement('');

    if (!user?.id) {
      setLoading(false);
      return undefined;
    }

    const currentUserId = user.id;
    const controller = new AbortController();
    setLoading(true);

    fetch(`/api/caption-ideas/history?page=1&limit=${LIMIT}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `서버 오류 (${response.status})`);
        return data;
      })
      .then((data) => {
        if (activeUserRef.current !== currentUserId) return;
        setItems(data.items || []);
        setTotal(Number(data.total || 0));
      })
      .catch((historyError) => {
        if (historyError.name !== 'AbortError' && activeUserRef.current === currentUserId) {
          setError(historyError.message || '자막 아이디어 내역을 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && activeUserRef.current === currentUserId) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [getToken, refreshKey, retryKey, user?.id]);

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  async function loadMore() {
    if (!user?.id || loadingMore) return;

    const currentUserId = user.id;
    const nextPage = page + 1;
    setLoadingMore(true);
    setError('');

    try {
      const response = await fetch(`/api/caption-ideas/history?page=${nextPage}&limit=${LIMIT}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `서버 오류 (${response.status})`);
      if (activeUserRef.current !== currentUserId) return;

      setItems((previous) => [...previous, ...(data.items || [])]);
      setTotal(Number(data.total || 0));
      setPage(nextPage);
    } catch (loadError) {
      if (activeUserRef.current === currentUserId) {
        setError(loadError.message || '추가 내역을 불러오지 못했습니다.');
      }
    } finally {
      if (activeUserRef.current === currentUserId) setLoadingMore(false);
    }
  }

  async function copyIdea(idea, itemId, index) {
    const key = `${itemId}-${index}`;
    try {
      await navigator.clipboard.writeText(idea);
      setCopiedIdeaKey(key);
      setAnnouncement(`${index + 1}번 자막을 복사했습니다.`);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedIdeaKey(null), 1600);
    } catch {
      setError('클립보드에 복사하지 못했습니다.');
    }
  }

  return (
    <div className="caption-history-panel__content">
      <div className="caption-history-panel__summary">
        <p>최근 90일 동안 생성한 추천을 다시 확인하고 복사할 수 있습니다.</p>
        {!loading && <span>{total}건</span>}
      </div>

      {loading && (
        <p className="usage-state usage-state--panel" role="status">자막 아이디어 내역을 불러오는 중...</p>
      )}

      {!loading && error && (
        <div className="caption-history-error">
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setRetryKey((current) => current + 1)}>
            다시 시도
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="usage-state usage-state--panel">생성한 자막 아이디어가 없습니다.</p>
      )}

      {!loading && items.length > 0 && (
        <>
          <div className="caption-history-list">
            {items.map((item) => (
              <article className="caption-history-item" key={item.id}>
                <header className="caption-history-item__header">
                  <time dateTime={item.completed_at}>{formatDate(item.completed_at)}</time>
                  <span className="caption-history-mode">{getCaptionModeLabel(item.mode)}</span>
                </header>
                <ol>
                  {(item.ideas || []).map((idea, index) => {
                    const copyKey = `${item.id}-${index}`;
                    return (
                      <li key={copyKey}>
                        <span className="caption-history-number">{String(index + 1).padStart(2, '0')}</span>
                        <strong>{idea}</strong>
                        <button
                          className="caption-ideas-copy caption-history-copy"
                          type="button"
                          aria-label={`${index + 1}번 자막 복사`}
                          title={`${index + 1}번 자막 복사`}
                          onClick={() => copyIdea(idea, item.id, index)}
                        >
                          {copiedIdeaKey === copyKey ? '완료' : '복사'}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </article>
            ))}
          </div>

          {items.length < total && (
            <button
              className="usage-load-more"
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? '불러오는 중...' : `더 보기 (${items.length} / ${total})`}
            </button>
          )}
        </>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  );
}
