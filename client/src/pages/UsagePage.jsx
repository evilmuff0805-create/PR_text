import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const LIMIT = 20;

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

  // 초기 로드
  useEffect(() => {
    if (!token) { setLoading(false); return; }
    fetch(`/api/auth/usage-logs?page=1&limit=${LIMIT}&type=all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => { if (!r.ok) throw new Error(`서버 오류 (${r.status})`); return r.json(); })
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
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
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
        headers: { 'Content-Type': 'application/json' },
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

  const thStyle = {
    padding: '14px 16px',
    textAlign: 'left',
    fontSize: '0.8rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  };

  const loadMoreBtnStyle = {
    display: 'block',
    width: '100%',
    padding: '12px',
    marginTop: '12px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'var(--text-secondary)',
    fontSize: '0.9rem',
    fontWeight: 600,
    cursor: 'pointer',
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 24px' }}>
      {/* 상단 크레딧 표시 */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '32px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '48px', height: '48px', borderRadius: '50%',
          background: 'var(--gradient)', color: '#000', fontSize: '1.2rem', fontWeight: 700,
        }}>C</span>
        <div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '4px' }}>현재 보유 크레딧</p>
          <p style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {user ? user.credits : '-'}
          </p>
        </div>
      </div>

      {loading && (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>불러오는 중...</p>
      )}

      {!loading && error && (
        <p style={{ color: '#FF4444', textAlign: 'center', padding: '40px 0' }}>{error}</p>
      )}

      {!loading && !error && !token && (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>
          로그인 후 사용 내역을 확인할 수 있습니다.
        </p>
      )}

      {/* 크레딧 사용 내역 */}
      {!loading && !error && token && (
        <>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
            사용 내역
          </h2>

          {usageLogs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>
              사용 내역이 없습니다.
            </p>
          ) : (
            <>
              <div style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                overflow: 'hidden',
                marginBottom: '12px',
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      {['날짜', '구분', '크레딧 변동', '설명'].map((h) => (
                        <th key={h} style={thStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {usageLogs.map((log, i) => {
                      const isCharge = log.action === 'charge';
                      return (
                        <tr
                          key={log.id || i}
                          style={{
                            borderBottom: i < usageLogs.length - 1 ? '1px solid var(--border-color)' : 'none',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            {formatDate(log.created_at)}
                          </td>
                          <td style={{ padding: '14px 16px' }}>
                            <span style={{
                              display: 'inline-block', padding: '3px 10px', borderRadius: '20px',
                              fontSize: '0.78rem', fontWeight: 600,
                              background: isCharge ? 'rgba(57,255,20,0.12)' : 'rgba(255,68,68,0.12)',
                              color: isCharge ? '#39FF14' : '#FF4444',
                            }}>
                              {isCharge ? '충전' : '변환'}
                            </span>
                          </td>
                          <td style={{ padding: '14px 16px', fontSize: '0.95rem', fontWeight: 700, color: isCharge ? '#39FF14' : '#FF4444' }}>
                            {isCharge ? '+' : '-'}{Math.abs(log.amount ?? log.credits_used ?? 0)}
                          </td>
                          <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            {log.description || log.note || '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {usageLogs.length < usageTotal && (
                <button onClick={loadMoreUsage} disabled={loadingMoreUsage} style={loadMoreBtnStyle}>
                  {loadingMoreUsage ? '불러오는 중...' : `더 보기 (${usageLogs.length} / ${usageTotal})`}
                </button>
              )}
            </>
          )}

          {/* 변환 이력 섹션 */}
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px', marginTop: '48px' }}>
            변환 이력
          </h2>

          {transcriptionLogs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>
              변환 이력이 없습니다.
            </p>
          ) : (
            <>
              <div style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                overflow: 'hidden',
                marginBottom: '12px',
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      {['날짜', '파일명', '길이', '언어', '세그먼트 수', '다운로드'].map((h) => (
                        <th key={h} style={thStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {transcriptionLogs.map((log, i) => (
                      <tr
                        key={log.id || i}
                        style={{
                          borderBottom: i < transcriptionLogs.length - 1 ? '1px solid var(--border-color)' : 'none',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {formatDate(log.created_at)}
                        </td>
                        <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-primary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {log.filename || '-'}
                        </td>
                        <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {formatDuration(log.duration_seconds)}
                        </td>
                        <td style={{ padding: '14px 16px' }}>
                          <span style={{
                            display: 'inline-block', padding: '3px 10px', borderRadius: '20px',
                            fontSize: '0.78rem', fontWeight: 600,
                            background: 'rgba(0,245,255,0.12)', color: '#00F5FF',
                          }}>
                            {log.language || '-'}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px', fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'right' }}>
                          {log.segments_count ?? '-'}
                        </td>
                        <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                          {['srt', 'txt', 'ass'].map((fmt) => {
                            const key = `${log.id}_${fmt}`;
                            const busy = downloadingId === key;
                            return (
                              <button
                                key={fmt}
                                onClick={() => handleDownload(log.id, fmt)}
                                disabled={downloadingId !== null}
                                style={{
                                  marginRight: '4px',
                                  padding: '4px 10px',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  background: busy ? 'var(--gradient)' : 'var(--bg-tertiary)',
                                  border: '1px solid var(--border-color)',
                                  borderRadius: '6px',
                                  color: busy ? '#000' : 'var(--text-secondary)',
                                  cursor: downloadingId !== null ? 'not-allowed' : 'pointer',
                                  opacity: downloadingId !== null && !busy ? 0.4 : 1,
                                  transition: 'all 0.15s',
                                  fontFamily: 'var(--font-family)',
                                }}
                              >
                                {busy ? '...' : fmt.toUpperCase()}
                              </button>
                            );
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {transcriptionLogs.length < transcriptionTotal && (
                <button onClick={loadMoreTranscription} disabled={loadingMoreTranscription} style={loadMoreBtnStyle}>
                  {loadingMoreTranscription ? '불러오는 중...' : `더 보기 (${transcriptionLogs.length} / ${transcriptionTotal})`}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
