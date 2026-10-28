import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useBatchTranscription } from '../contexts/BatchTranscriptionContext.jsx';
import { batchCounts, isBatchId } from '../utils/batch-transcription.js';
import { segmentText } from '../utils/result-drafts.js';
import { BatchImportNotice } from '../components/BatchTranscriptionPanel.jsx';
import { ResultEditor } from './ResultPage.jsx';

export default function BatchResultPage() {
  const { user } = useAuth();
  const state = useBatchTranscription();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const batchId = params.get('batch'), trackId = params.get('track');
  const batch = state.batch?.id === batchId ? state.batch : null;
  const completed = batch?.items.filter((item) => item.status === 'completed') || [];
  const selected = completed.find((item) => item.id === trackId) || (!trackId ? completed[0] : null);
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const lastFlushRef = useRef(null);
  const ownerRef = useRef(user?.id); ownerRef.current = user?.id;

  useEffect(() => {
    if (!user?.id || !isBatchId(batchId)) return;
    let disposed = false;
    if (!batch) state.loadBatch(batchId).catch((requestError) => { if (!disposed) setError(requestError.message); });
    return () => { disposed = true; };
  }, [batchId, Boolean(batch), state.loadBatch, user?.id]);

  useEffect(() => {
    if (!user?.id || !selected?.transcriptionLogId) return;
    const owner = user.id;
    let disposed = false;
    setLoading(true); setError('');
    const load = async () => {
      try {
        await lastFlushRef.current?.();
        if (disposed) return;
        const log = await state.api(`/api/auth/transcription/${selected.transcriptionLogId}`);
        if (disposed || ownerRef.current !== owner) return;
        setRecord({ ...log, text: segmentText(log.segments || []), diarize: false, holdShortGaps: false, transcriptionLogId: selected.transcriptionLogId, itemId: selected.id, ownerId: owner });
      } catch (requestError) { if (!disposed) setError(requestError.message); }
      finally { if (!disposed) setLoading(false); }
    };
    load(); return () => { disposed = true; };
  }, [selected?.transcriptionLogId, state.api, user?.id]);

  const registerFlush = useCallback((flush) => {
    if (flush) lastFlushRef.current = flush;
    state.registerEditor(selected?.transcriptionLogId, flush);
  }, [selected?.transcriptionLogId, state.registerEditor]);

  const leaveEditor = async (callback) => {
    if (switchingRef.current || state.busy) return;
    switchingRef.current = true; setSwitching(true); setError('');
    try { await lastFlushRef.current?.(); state.clearError(); callback(); }
    catch (requestError) { setError(requestError.message); }
    finally { switchingRef.current = false; setSwitching(false); }
  };

  if (!user) return <p className="usage-state">로그인 후 결과를 확인해 주세요.</p>;
  if (!isBatchId(batchId)) return <p role="alert">묶음 작업 번호를 확인해 주세요. <Link to="/transcribe?mode=batch">묶음 화면으로</Link></p>;
  const counts = batchCounts(batch);
  const visibleRecord = record?.ownerId === user.id && record.transcriptionLogId === selected?.transcriptionLogId ? record : null;
  return <div className="batch-result">
    <section className="card batch-card" aria-labelledby="batch-result-title"><h2 id="batch-result-title">사람별 자막 결과</h2><p role="status">완료 {counts.completed}/{counts.total} · 실패 {counts.failed}</p>
      <div className="batch-actions" aria-label="편집할 사람 선택">{completed.map((item, index) => <button key={item.id} type="button" className={`button button--${item.id === selected?.id ? 'primary' : 'secondary'}`} aria-pressed={item.id === selected?.id} disabled={Boolean(state.busy) || switching} onClick={() => leaveEditor(() => setParams({ batch: batchId, track: item.id }))}>{Number.isInteger(item.order) ? item.order + 1 : index + 1}. {item.label}</button>)}</div>
      <div className="batch-actions"><button type="button" className="button button--secondary" disabled={Boolean(state.busy) || switching} onClick={() => leaveEditor(() => navigate(`/transcribe?mode=batch&batch=${batchId}`))}>묶음 상태로 돌아가기</button><button type="button" className="button button--primary" disabled={Boolean(state.busy) || switching || !counts.completed} onClick={() => state.downloadZip(batchId)}>{state.busy === 'archive' ? '편집 저장 · ZIP 생성 중…' : `전사 완료 ${counts.completed}개 ZIP 다운로드`}</button></div>
      <p className="batch-note">파일을 바꾸거나 ZIP을 받기 전에 편집 내용을 저장합니다. 다른 파일의 시간이나 문장은 변경하지 않습니다.</p><BatchImportNotice />
    </section>
    {(error || state.error) && <p className="batch-alert batch-alert--error" role="alert">{error || state.error}</p>}
    {state.notice && <p className="batch-alert" role="status">{state.notice}</p>}
    {loading && <p role="status">저장 상태와 선택한 파일의 결과를 확인하고 있습니다…</p>}
    {!loading && !selected && <p className="batch-alert" role="status">이 파일은 아직 완료되지 않았습니다. 묶음 상태에서 진행 상황을 확인해 주세요.</p>}
    {visibleRecord && visibleRecord.segments?.length > 0 && <fieldset className="batch-editor-lock" disabled={Boolean(state.busy) || switching}><legend className="sr-only">선택한 파일의 자막 편집</legend><ResultEditor key={`${user.id}:${visibleRecord.transcriptionLogId}`} resultOverride={visibleRecord} onRegisterFlush={registerFlush} onReturn={() => leaveEditor(() => navigate(`/transcribe?mode=batch&batch=${batchId}`))} /></fieldset>}
    {visibleRecord && !visibleRecord.segments?.length && <section className="card batch-card"><h2>인식된 대사 없음 · 검토 필요</h2><p>인식 결과에 대사가 없습니다. 작은 목소리가 없었다는 뜻은 아닙니다. 원본을 확인해 주세요. 이 파일은 빈 SRT를 만들지 않으며 묶음 ZIP에서도 제외됩니다.</p></section>}
  </div>;
}
