import { useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useBatchTranscription } from '../contexts/BatchTranscriptionContext.jsx';
import { BATCH_AUDIO_ACCEPT, BATCH_TERMINAL_STATUSES, batchCounts, isBatchId } from '../utils/batch-transcription.js';
import { formatSegmentTime } from '../utils/format-segment-time.js';

const STATUS_LABELS = { awaiting_upload: '파일 접수 필요', ready: '접수 완료', queued: '변환 대기', running: '변환 중', finalizing: '결과 저장 중', completed: '완료', failed: '실패', cancelled: '취소됨' };

export function BatchImportNotice() {
  return <p className="batch-note">ZIP에는 인식된 대사가 있는 변환의 SRT만 포함됩니다. 대사가 없는 완료 건은 전사 완료 건수에는 포함되지만 SRT 파일은 제외되며, ZIP 사용안내에서 건수를 확인할 수 있습니다.</p>;
}

export default function BatchTranscriptionPanel({ onLogin }) {
  const { user } = useAuth();
  const state = useBatchTranscription();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestedRef = useRef('');
  const requestedId = params.get('batch');
  useEffect(() => {
    if (!user?.id || !isBatchId(requestedId) || state.batch?.id === requestedId || requestedRef.current === requestedId || state.loading || state.busy) return;
    requestedRef.current = requestedId; state.refresh(requestedId);
  }, [requestedId, state.batch?.id, state.loading, state.busy, user?.id]);
  const counts = batchCounts(state.batch);
  const locked = Boolean(state.batch || state.busy || state.loading || state.creationPending || state.admissionsEnabled !== true);
  const unfinishedUploads = state.batch?.items.some((item) => item.status === 'awaiting_upload');
  const insufficient = Number.isFinite(user?.credits) && state.batch?.totalCredits > user.credits;

  return <section className="batch-workspace" aria-labelledby="batch-title">
    <header className="workspace-heading"><h1 id="batch-title" className="workspace-title">사람별 오디오 묶음 변환</h1><p className="workspace-description">한 사람씩 분리한 오디오 1~5개를 일반 변환하고, 사람별 SRT를 ZIP으로 받으세요.</p></header>
    <p className="batch-note">같은 영상의 0초부터 내보낸 파일을 사용해 주세요. 앞부분 무음을 유지하며, 파일 간 자동 동기화·시작 위치 변경·속도 보정은 하지 않습니다. 한 파일에 여러 사람이 말하면 사람별로 다시 분리하지 않습니다.</p>
    {!user ? <div className="card batch-card"><p>로그인 후 파일을 선택하고 묶음 작업을 시작할 수 있습니다.</p><button type="button" className="button button--primary" onClick={onLogin}>로그인</button></div> : <>
      {state.error && <p className="batch-alert batch-alert--error" role="alert">{state.error}</p>}
      {state.notice && <p className="batch-alert" role="status">{state.notice}</p>}
      {state.loading && <p role="status">이전 묶음 작업을 확인하고 있습니다…</p>}
      {state.admissionsEnabled === false && <p className="batch-alert" role="status">사람별 묶음 변환을 준비 중입니다. 이미 접수된 작업의 상태 확인과 다운로드는 계속 사용할 수 있습니다.</p>}
      {!state.batch && <div className="card batch-card batch-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!locked) state.addFiles(event.dataTransfer.files); }}>
        <label className="batch-field"><span>사람별 오디오 파일 선택 · 최대 5개</span><input type="file" accept={BATCH_AUDIO_ACCEPT} multiple disabled={locked} onChange={(event) => { state.addFiles(event.target.files); event.target.value = ''; }} /></label>
        <p className="batch-note">여기에 파일 여러 개를 놓거나 선택하세요. 파일당 업로드 최대 150MiB, WAV 원본 최대 500MiB입니다. 큰 WAV 준비와 업로드는 파일별로 순서대로 진행합니다.</p>
        <label className="batch-field"><span>공통 원본 언어</span><select value={state.language} disabled={locked} onChange={(event) => state.setLanguage(event.target.value)}><option value="">자동 감지</option><option value="ko">한국어</option><option value="en">영어</option><option value="ja">일본어</option><option value="zh">중국어</option></select></label>
        <label className="batch-field"><span>한국어 자막</span><select value={state.polishMode} disabled={locked} onChange={(event) => state.setPolishMode(event.target.value)}><option value="preserve">변환 전 원문 보존 (기존 맞춤법 교정)</option><option value="grammar">문장 다듬기</option></select></label>
        <p className="batch-note">원문의 의미를 살리며 문장을 자연스럽게 다듬고, 자막 구간은 유지합니다.</p>
      </div>}
      <ol className="batch-file-list" aria-label="사람별 파일 목록">{state.rows.map((row, index) => {
        const local = state.localStates[row.clientId];
        const label = local?.status === 'preparing' ? `WAV 준비 중${Number.isFinite(local.progress) ? ` · ${local.progress}%` : ''}` : local?.status === 'uploading' ? '파일 업로드 중' : STATUS_LABELS[row.status] || '선택됨';
        return <li key={row.clientId} className="card batch-file-row">
          <div className="batch-file-row__main"><span className="batch-order">트랙 {index + 1}</span><label className="batch-field"><span>인물 이름</span><input aria-label={`트랙 ${index + 1} 인물 이름`} value={row.label} maxLength={80} disabled={locked} onChange={(event) => state.changeLabel(row.clientId, event.target.value)} /></label><p className="batch-filename">{row.filename}</p><p className="batch-note">{Number.isFinite(row.durationSeconds) ? `길이 ${formatSegmentTime(row.durationSeconds)} · ${row.creditsNeeded}분` : '길이·사용 시간은 서버 접수 후 확인'} · 시작 위치 0초 유지</p></div>
          <div className="batch-file-row__actions"><strong role="status">{label}</strong>
            {!state.batch && <><button type="button" className="button button--secondary" aria-label={`트랙 ${index + 1} 위로 이동`} disabled={locked || index === 0} onClick={() => state.moveRow(row.clientId, -1)}>위로</button><button type="button" className="button button--secondary" aria-label={`트랙 ${index + 1} 아래로 이동`} disabled={locked || index === state.rows.length - 1} onClick={() => state.moveRow(row.clientId, 1)}>아래로</button><button type="button" className="button button--secondary" disabled={locked} onClick={() => state.removeRow(row.clientId)}>제거</button></>}
            {row.status === 'awaiting_upload' && !state.hasFile(row.clientId) && <label className="batch-field"><span>원래 파일 다시 선택</span><input type="file" accept={BATCH_AUDIO_ACCEPT} disabled={Boolean(state.busy)} onChange={(event) => { state.selectReplacement(row.clientId, event.target.files[0]); event.target.value = ''; }} /></label>}
            {row.status === 'failed' && <button type="button" className="button button--secondary" disabled={Boolean(state.busy) || counts.active > 0} onClick={() => state.retryItem(row.id)}>이 파일만 재시도</button>}
            {row.status === 'completed' && row.transcriptionLogId && <button type="button" className="button button--secondary" disabled={Boolean(state.busy)} onClick={() => navigate(`/result?batch=${state.batch.id}&track=${row.id}`)}>결과 편집</button>}
          </div>
          {(row.error || (local?.message && row.status === 'awaiting_upload')) && <p className="batch-alert batch-alert--error" role="alert">{row.error || local.message}</p>}
          {(row.recognitionStatus === 'no_speech' || row.needsReview) && <p className="batch-alert" role="status">인식된 대사 없음 · 검토 필요. 작은 목소리가 없었다는 뜻은 아닙니다. 이 완료 건의 SRT는 ZIP에서 제외됩니다.</p>}
        </li>;
      })}</ol>
      <div className="card batch-card">
        {state.batch && <><p role="status" aria-live="polite">완료 {counts.completed}/{counts.total} · 실패 {counts.failed} · 취소 {counts.cancelled}</p><p className="batch-note">접수 후 인물 이름과 트랙 순서는 고정됩니다. 완료된 결과는 다른 파일의 실패나 취소와 관계없이 유지됩니다.</p>
          <p className="batch-note">공통 원본 언어: {({ ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' })[state.batch.language] || '자동 감지'}</p>
          <p className="batch-note">한국어 자막: {state.batch.polishMode === 'grammar' ? '문법 다듬기' : '변환 전 원문 보존 (기존 맞춤법 교정)'}</p>
          <p>다음 시작에 확인할 사용 시간: <strong>{state.batch.totalCredits ?? 0}분</strong></p>
          <p className="batch-note">사용 완료 {state.batch.creditsUsed ?? 0}분 · 예약 중 {state.batch.creditsReserved ?? 0}분 · 반환 {state.batch.creditsRestored ?? 0}분. 재시도 시에는 다시 준비한 파일의 사용 시간만 확인합니다.</p>
        </>}
        <div className="batch-actions">
          {(!state.batch || unfinishedUploads) && <button type="button" className="button button--primary" disabled={Boolean(state.busy) || state.loading || !state.rows.length || (!state.batch && !state.creationPending && state.admissionsEnabled !== true)} onClick={state.stageFiles}>{state.busy === 'upload' ? '파일을 순서대로 접수 중…' : state.batch ? '미접수 파일 다시 접수' : state.creationPending ? '접수 상태 다시 확인 · 파일 접수' : '파일 접수 · 사용 시간 확인'}</button>}
          {state.batch?.canStart && <button type="button" className="button button--primary" disabled={Boolean(state.busy) || insufficient} onClick={state.start}>총 {state.batch.totalCredits}분 확인 · 변환 시작</button>}
          {state.batch && <button type="button" className="button button--secondary" disabled={Boolean(state.busy)} onClick={() => state.refresh()}>작업 상태 다시 확인</button>}
          {state.batch && !BATCH_TERMINAL_STATUSES.has(state.batch.status) && <button type="button" className="button button--secondary" disabled={Boolean(state.busy)} onClick={() => { if (window.confirm('미완료 파일의 작업을 취소할까요? 완료된 결과는 유지됩니다.')) state.cancel(); }}>미완료 작업 취소</button>}
          {counts.completed > 0 && <button type="button" className="button button--primary" disabled={Boolean(state.busy)} onClick={() => state.downloadZip()}>{state.busy === 'archive' ? '편집 저장 · ZIP 생성 중…' : `전사 완료 ${counts.completed}개 ZIP 다운로드`}</button>}
          {(!state.batch || BATCH_TERMINAL_STATUSES.has(state.batch.status)) && state.rows.length > 0 && <button type="button" className="button button--secondary" disabled={Boolean(state.busy)} onClick={() => { state.beginNew(); navigate('/transcribe?mode=batch', { replace: true }); }}>새 묶음 만들기</button>}
        </div>
        {insufficient && <p role="alert">변환 가능 시간이 부족합니다. 접수된 파일은 유지됩니다. <Link to="/payment">변환 시간 충전</Link></p>}
        <p className="batch-note">사용 시간을 확인하고 변환 시작을 누르기 전에는 변환 시간을 예약하지 않습니다. 업로드를 마치지 못한 파일은 새로고침 후 다시 선택해야 합니다.</p>
        {counts.completed > 0 && <><p className="batch-note">ZIP에는 완료된 파일만 포함됩니다. ZIP 생성 실패 후 다시 다운로드해도 음성 인식이나 과금을 다시 실행하지 않습니다.</p><BatchImportNotice /></>}
      </div>
    </>}
  </section>;
}

export function BatchArchiveList() {
  const state = useBatchTranscription();
  if (!state?.batches.length) return null;
  return <section className="card batch-card" aria-labelledby="batch-archive-title"><h2 id="batch-archive-title">사람별 오디오 묶음</h2><ul className="batch-history">{state.batches.map((batch) => {
    const counts = batchCounts(batch);
    return <li key={batch.id}><div><strong>{batch.items?.map((item) => item.label).join(' · ') || '사람별 자막'}</strong><p className="batch-note">완료 {counts.completed}/{counts.total} · 실패 {counts.failed}</p></div><Link className="button button--secondary" aria-disabled={Boolean(state.busy)} onClick={(event) => { if (state.busy) event.preventDefault(); }} to={`/transcribe?mode=batch&batch=${batch.id}`}>묶음 열기</Link><button type="button" className="button button--secondary" disabled={Boolean(state.busy) || !counts.completed} onClick={() => state.downloadZip(batch.id)}>완료된 {counts.completed}개 ZIP 다운로드</button></li>;
  })}</ul><BatchImportNotice /></section>;
}
