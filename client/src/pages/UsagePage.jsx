import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const LIMIT = 20;

export default function UsagePage() {
  const { user, token } = useAuth();
  const [usageLogs, setUsageLogs] = useState([]);
  const [usageTotal, setUsageTotal] = useState(0);
  const [usagePage, setUsagePage] = useState(1);
  const [loadingMoreUsage, setLoadingMoreUsage] = useState(false);

  const [captionIdeas, setCaptionIdeas] = useState([]);
  const [captionIdeasTotal, setCaptionIdeasTotal] = useState(0);
  const [captionIdeasPage, setCaptionIdeasPage] = useState(1);
  const [captionIdeasLoading, setCaptionIdeasLoading] = useState(true);
  const [loadingMoreCaptionIdeas, setLoadingMoreCaptionIdeas] = useState(false);
  const [captionIdeasError, setCaptionIdeasError] = useState(null);
  const [copiedIdeaKey, setCopiedIdeaKey] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const copyTimerRef = useRef(null);
  const activeTokenRef = useRef(token);
  activeTokenRef.current = token;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setUsageLogs([]);
    setUsageTotal(0);
    setUsagePage(1);
    setCaptionIdeas([]);
    setCaptionIdeasTotal(0);
    setCaptionIdeasPage(1);
    setError(null);
    setCaptionIdeasError(null);
    setCopiedIdeaKey(null);
    setAnnouncement('');

    if (!token) {
      setLoading(false);
      setCaptionIdeasLoading(false);
      return;
    }

    setLoading(true);
    setCaptionIdeasLoading(true);
    const controller = new AbortController();

    fetch(`/api/auth/usage-logs?page=1&limit=${LIMIT}&type=usage`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`서버 오류 (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setUsageLogs(data.usageLogs || []);
        setUsageTotal(data.usageTotal || 0);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    fetch(`/api/caption-ideas/history?page=1&limit=${LIMIT}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`서버 오류 (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setCaptionIdeas(data.items || []);
        setCaptionIdeasTotal(data.total || 0);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setCaptionIdeasError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCaptionIdeasLoading(false);
      });

    return () => {
      controller.abort();
      window.clearTimeout(copyTimerRef.current);
    };
  }, [token]);

  async function loadMoreUsage() {
    setLoadingMoreUsage(true);
    const nextPage = usagePage + 1;
    try {
      const r = await fetch(`/api/auth/usage-logs?page=${nextPage}&limit=${LIMIT}&type=usage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`서버 오류 (${r.status})`);
      const data = await r.json();
      if (activeTokenRef.current !== token) return;
      setUsageLogs((prev) => [...prev, ...(data.usageLogs || [])]);
      setUsageTotal(data.usageTotal || 0);
      setUsagePage(nextPage);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoadingMoreUsage(false);
    }
  }

  async function loadMoreCaptionIdeas() {
    setLoadingMoreCaptionIdeas(true);
    setCaptionIdeasError(null);
    const nextPage = captionIdeasPage + 1;
    try {
      const response = await fetch(`/api/caption-ideas/history?page=${nextPage}&limit=${LIMIT}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`서버 오류 (${response.status})`);
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      if (activeTokenRef.current !== token) return;
      setCaptionIdeas((previous) => [...previous, ...(data.items || [])]);
      setCaptionIdeasTotal(data.total || 0);
      setCaptionIdeasPage(nextPage);
    } catch (err) {
      setCaptionIdeasError(err.message);
    } finally {
      setLoadingMoreCaptionIdeas(false);
    }
  }

  async function copyCaptionIdea(idea, itemId, index) {
    const key = `${itemId}-${index}`;
    try {
      await navigator.clipboard.writeText(idea);
      setCopiedIdeaKey(key);
      setAnnouncement(`${index + 1}번 자막을 복사했습니다.`);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedIdeaKey(null), 1600);
    } catch {
      setCaptionIdeasError('클립보드에 복사하지 못했습니다.');
    }
  }

  const formatDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="usage-page">
      <header className="usage-heading">
        <p className="workspace-kicker">ACCOUNT ACTIVITY</p>
        <h1 className="workspace-title">사용 내역</h1>
        <p className="workspace-description">충전, 변환, 환불에 따른 시간 변동을 확인합니다.</p>
      </header>

      <section className="usage-credit-summary" aria-label="현재 보유 변환 시간">
        <span className="usage-credit-summary__icon" aria-hidden="true">⏱</span>
        <div>
          <p>현재 보유 변환 시간</p>
          <strong>{user ? `${user.credits}분` : '-'}</strong>
        </div>
      </section>

      {loading && <p className="usage-state" role="status">불러오는 중...</p>}

      {!loading && error && <p className="usage-state usage-state--error" role="alert">{error}</p>}

      {!loading && !error && !token && (
        <p className="usage-state">로그인 후 사용 내역을 확인할 수 있습니다.</p>
      )}

      {!loading && !error && token && (
        <div className="usage-sections">
          <section className="usage-section" aria-labelledby="usage-ledger-title">
            <div className="usage-section__heading">
              <div>
                <p className="usage-section__kicker">CREDIT LEDGER</p>
                <h2 id="usage-ledger-title">시간 변동 내역</h2>
              </div>
              <span>{usageTotal}건</span>
            </div>

            {usageLogs.length === 0 ? (
              <p className="usage-state usage-state--panel">사용 내역이 없습니다.</p>
            ) : (
              <>
                <div className="usage-table-shell usage-table-shell--ledger">
                  <table className="usage-table usage-table--ledger">
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>구분</th>
                        <th>시간 변동</th>
                        <th>설명</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageLogs.map((log, i) => {
                        const amount = Number(log.amount ?? log.credits_used ?? 0);
                        const isCreditIncrease = amount < 0;
                        const actionLabel = getUsageActionLabel(log.action);
                        return (
                          <tr key={log.id || i}>
                            <td className="usage-table__date">
                              <span className="usage-mobile-label">날짜</span>
                              <time dateTime={log.created_at}>{formatDate(log.created_at)}</time>
                            </td>
                            <td className="usage-table__action">
                              <span className="usage-mobile-label">구분</span>
                              <span className={`usage-badge ${isCreditIncrease ? 'is-positive' : 'is-negative'}`}>
                                {actionLabel}
                              </span>
                            </td>
                            <td className={`usage-table__amount ${isCreditIncrease ? 'is-positive' : 'is-negative'}`}>
                              <span className="usage-mobile-label">시간 변동</span>
                              <strong>{isCreditIncrease ? '+' : '-'}{Math.abs(amount)}분</strong>
                            </td>
                            <td className="usage-table__description">
                              <span className="usage-mobile-label">설명</span>
                              <span>{log.description || log.note || '-'}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {usageLogs.length < usageTotal && (
                  <button
                    className="usage-load-more"
                    onClick={loadMoreUsage}
                    disabled={loadingMoreUsage}
                  >
                    {loadingMoreUsage ? '불러오는 중...' : `더 보기 (${usageLogs.length} / ${usageTotal})`}
                  </button>
                )}
              </>
            )}
          </section>

          <section className="usage-section" aria-labelledby="caption-idea-history-title">
            <div className="usage-section__heading">
              <div>
                <p className="usage-section__kicker">CAPTION IDEAS</p>
                <h2 id="caption-idea-history-title">자막 아이디어 내역</h2>
              </div>
              <span>{captionIdeasTotal}건</span>
            </div>
            <p className="caption-history-description">
              최근 90일 동안 생성한 예능·상황·감성 자막 추천을 다시 확인할 수 있습니다.
            </p>

            {captionIdeasLoading && (
              <p className="usage-state usage-state--panel" role="status">자막 아이디어 내역을 불러오는 중...</p>
            )}

            {!captionIdeasLoading && captionIdeasError && (
              <p className="usage-state usage-state--error usage-state--panel" role="alert">{captionIdeasError}</p>
            )}

            {!captionIdeasLoading && !captionIdeasError && captionIdeas.length === 0 && (
              <p className="usage-state usage-state--panel">생성한 자막 아이디어가 없습니다.</p>
            )}

            {!captionIdeasLoading && captionIdeas.length > 0 && (
              <>
                <div className="caption-history-list">
                  {captionIdeas.map((item) => (
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
                                onClick={() => copyCaptionIdea(idea, item.id, index)}
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

                {captionIdeas.length < captionIdeasTotal && (
                  <button
                    className="usage-load-more"
                    type="button"
                    onClick={loadMoreCaptionIdeas}
                    disabled={loadingMoreCaptionIdeas}
                  >
                    {loadingMoreCaptionIdeas
                      ? '불러오는 중...'
                      : `더 보기 (${captionIdeas.length} / ${captionIdeasTotal})`}
                  </button>
                )}
              </>
            )}

            <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
          </section>

        </div>
      )}
    </div>
  );
}

function getCaptionModeLabel(mode) {
  if (mode === 'entertainment') return '예능';
  if (mode === 'situation') return '상황';
  if (mode === 'emotion') return '감성';
  return '자막';
}

function getUsageActionLabel(action) {
  if (action === 'charge') return '충전';
  if (action === 'refund') return '환불';
  if (action === 'payment_refund' || action === 'payment_refund_reconcile') return '결제 환불';
  if (action === 'payment_refund_restore') return '환불 취소';
  if (action === 'caption_ideas') return '자막 아이디어';
  return '변환';
}
