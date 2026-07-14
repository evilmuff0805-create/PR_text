import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const LIMIT = 20;
const DOWNLOAD_FORMATS = ['srt', 'txt', 'ass'];

export default function UsagePage() {
  const { user, token } = useAuth();
  const [usageLogs, setUsageLogs] = useState([]);
  const [usageTotal, setUsageTotal] = useState(0);
  const [usagePage, setUsagePage] = useState(1);
  const [loadingMoreUsage, setLoadingMoreUsage] = useState(false);

  const [transcriptionLogs, setTranscriptionLogs] = useState([]);
  const [transcriptionTotal, setTranscriptionTotal] = useState(0);
  const [transcriptionPage, setTranscriptionPage] = useState(1);
  const [loadingMoreTranscription, setLoadingMoreTranscription] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    fetch(`/api/auth/usage-logs?page=1&limit=${LIMIT}&type=all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`서버 오류 (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setUsageLogs(data.usageLogs || []);
        setUsageTotal(data.usageTotal || 0);
        setTranscriptionLogs(data.transcriptionLogs || []);
        setTranscriptionTotal(data.transcriptionTotal || 0);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
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
      setUsageLogs((prev) => [...prev, ...(data.usageLogs || [])]);
      setUsageTotal(data.usageTotal || 0);
      setUsagePage(nextPage);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoadingMoreUsage(false);
    }
  }

  async function loadMoreTranscription() {
    setLoadingMoreTranscription(true);
    const nextPage = transcriptionPage + 1;
    try {
      const r = await fetch(`/api/auth/usage-logs?page=${nextPage}&limit=${LIMIT}&type=transcription`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`서버 오류 (${r.status})`);
      const data = await r.json();
      setTranscriptionLogs((prev) => [...prev, ...(data.transcriptionLogs || [])]);
      setTranscriptionTotal(data.transcriptionTotal || 0);
      setTranscriptionPage(nextPage);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoadingMoreTranscription(false);
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

  async function handleDownload(logId, format) {
    const key = `${logId}_${format}`;
    setDownloadingId(key);
    try {
      const r = await fetch(`/api/auth/transcription/${logId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error('변환 기록을 불러오지 못했습니다.');
      const data = await r.json();
      const segments = data.segments;
      if (!segments || segments.length === 0) throw new Error('저장된 세그먼트 데이터가 없습니다.');

      const dlRes = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ segments, format }),
      });
      if (!dlRes.ok) throw new Error('다운로드 실패');
      const blob = await dlRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.filename || 'subtitle'}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    } finally {
      setDownloadingId(null);
    }
  }

  const formatDuration = (seconds) => {
    const s = Math.round(seconds || 0);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div className="usage-page">
      <header className="usage-heading">
        <p className="workspace-kicker">ACCOUNT ACTIVITY</p>
        <h1 className="workspace-title">사용 내역</h1>
        <p className="workspace-description">변환 시간의 사용 기록과 완료된 자막 파일을 확인합니다.</p>
      </header>

      <section className="usage-credit-summary" aria-label="현재 보유 변환 시간">
        <span className="usage-credit-summary__icon" aria-hidden="true">⏱</span>
        <div>
          <p>현재 보유 변환 시간</p>
          <strong>{user ? `${user.credits}분` : '-'}</strong>
        </div>
      </section>

      {loading && <p className="usage-state">불러오는 중...</p>}

      {!loading && error && <p className="usage-state usage-state--error">{error}</p>}

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

          <section className="usage-section" aria-labelledby="transcription-history-title">
            <div className="usage-section__heading">
              <div>
                <p className="usage-section__kicker">TRANSCRIPTION HISTORY</p>
                <h2 id="transcription-history-title">변환 이력</h2>
              </div>
              <span>{transcriptionTotal}건</span>
            </div>

            {transcriptionLogs.length === 0 ? (
              <p className="usage-state usage-state--panel">변환 이력이 없습니다.</p>
            ) : (
              <>
                <div className="usage-table-shell usage-table-shell--history">
                  <table className="usage-table usage-table--history">
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>파일명</th>
                        <th>길이</th>
                        <th>언어</th>
                        <th>세그먼트</th>
                        <th>다운로드</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transcriptionLogs.map((log, i) => (
                        <tr key={log.id || i}>
                          <td className="usage-table__date">
                            <span className="usage-mobile-label">날짜</span>
                            <time dateTime={log.created_at}>{formatDate(log.created_at)}</time>
                          </td>
                          <td className="usage-table__filename">
                            <span className="usage-mobile-label">파일명</span>
                            <span title={log.filename || undefined}>{log.filename || '-'}</span>
                          </td>
                          <td className="usage-table__duration">
                            <span className="usage-mobile-label">길이</span>
                            <span>{formatDuration(log.duration_seconds)}</span>
                          </td>
                          <td className="usage-table__language">
                            <span className="usage-mobile-label">언어</span>
                            <span className="usage-language-badge">{log.language || '-'}</span>
                          </td>
                          <td className="usage-table__segments">
                            <span className="usage-mobile-label">세그먼트</span>
                            <span>{log.segments_count ?? '-'}</span>
                          </td>
                          <td className="usage-table__downloads">
                            <span className="usage-mobile-label">다운로드</span>
                            <div className="usage-downloads">
                              {DOWNLOAD_FORMATS.map((format) => {
                                const key = `${log.id}_${format}`;
                                const busy = downloadingId === key;
                                return (
                                  <button
                                    key={format}
                                    type="button"
                                    onClick={() => handleDownload(log.id, format)}
                                    disabled={downloadingId !== null}
                                    className={busy ? 'is-busy' : ''}
                                    aria-label={`${log.filename || '자막'} ${format.toUpperCase()} 다운로드`}
                                  >
                                    {busy ? '...' : format.toUpperCase()}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {transcriptionLogs.length < transcriptionTotal && (
                  <button
                    className="usage-load-more"
                    onClick={loadMoreTranscription}
                    disabled={loadingMoreTranscription}
                  >
                    {loadingMoreTranscription ? '불러오는 중...' : `더 보기 (${transcriptionLogs.length} / ${transcriptionTotal})`}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function getUsageActionLabel(action) {
  if (action === 'charge') return '충전';
  if (action === 'refund') return '환불';
  if (action === 'payment_refund' || action === 'payment_refund_reconcile') return '결제 환불';
  if (action === 'payment_refund_restore') return '환불 취소';
  return '변환';
}
