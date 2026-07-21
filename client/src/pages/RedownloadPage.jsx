import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const LIMIT = 20;
const DOWNLOAD_FORMATS = ['srt', 'txt', 'ass'];

export default function RedownloadPage() {
  const { token } = useAuth();
  const [transcriptionLogs, setTranscriptionLogs] = useState([]);
  const [transcriptionTotal, setTranscriptionTotal] = useState(0);
  const [transcriptionPage, setTranscriptionPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    fetch(`/api/auth/usage-logs?page=1&limit=${LIMIT}&type=transcription`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`서버 오류 (${response.status})`);
        return response.json();
      })
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setTranscriptionLogs(data.transcriptionLogs || []);
        setTranscriptionTotal(data.transcriptionTotal || 0);
      })
      .catch((fetchError) => setError(fetchError.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function loadMoreTranscriptions() {
    setLoadingMore(true);
    const nextPage = transcriptionPage + 1;
    try {
      const response = await fetch(
        `/api/auth/usage-logs?page=${nextPage}&limit=${LIMIT}&type=transcription`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error(`서버 오류 (${response.status})`);
      const data = await response.json();
      setTranscriptionLogs((previous) => [...previous, ...(data.transcriptionLogs || [])]);
      setTranscriptionTotal(data.transcriptionTotal || 0);
      setTranscriptionPage(nextPage);
    } catch (loadError) {
      alert(loadError.message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDownload(logId, format) {
    const key = `${logId}_${format}`;
    setDownloadingId(key);
    try {
      const response = await fetch(`/api/auth/transcription/${logId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('변환 기록을 불러오지 못했습니다.');
      const data = await response.json();
      const segments = data.segments;
      if (!segments || segments.length === 0) {
        throw new Error('저장된 세그먼트 데이터가 없습니다.');
      }

      const downloadResponse = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ segments, format }),
      });
      if (!downloadResponse.ok) throw new Error('다운로드 실패');
      const blob = await downloadResponse.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${data.filename || 'subtitle'}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      alert(downloadError.message);
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="usage-page">
      <header className="usage-heading">
        <p className="workspace-kicker">TRANSCRIPTION ARCHIVE</p>
        <h1 className="workspace-title">변환_재다운로드</h1>
        <p className="workspace-description">
          완료된 변환 기록을 확인하고 자막 파일을 다시 다운로드합니다.
        </p>
      </header>

      {loading && <p className="usage-state" role="status">불러오는 중...</p>}

      {!loading && error && <p className="usage-state usage-state--error" role="alert">{error}</p>}

      {!loading && !error && !token && (
        <p className="usage-state">로그인 후 변환 기록을 확인할 수 있습니다.</p>
      )}

      {!loading && !error && token && (
        <div className="usage-sections">
          <section className="usage-section" aria-labelledby="transcription-history-title">
            <div className="usage-section__heading">
              <div>
                <p className="usage-section__kicker">TRANSCRIPTION HISTORY</p>
                <h2 id="transcription-history-title">변환 내역</h2>
              </div>
              <span>{transcriptionTotal}건</span>
            </div>

            {transcriptionLogs.length === 0 ? (
              <p className="usage-state usage-state--panel">변환 내역이 없습니다.</p>
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
                      {transcriptionLogs.map((log, index) => (
                        <tr key={log.id || index}>
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
                    onClick={loadMoreTranscriptions}
                    disabled={loadingMore}
                  >
                    {loadingMore
                      ? '불러오는 중...'
                      : `더 보기 (${transcriptionLogs.length} / ${transcriptionTotal})`}
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

function formatDuration(seconds) {
  const roundedSeconds = Math.round(seconds || 0);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}
