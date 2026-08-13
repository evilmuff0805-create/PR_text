import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useTranscription } from '../contexts/TranscriptionContext.jsx';
import AuthModal from '../components/AuthModal.jsx';
import { DIARIZATION_MAX_MINUTES, UPLOAD_ACCEPT, validateUploadFile } from '../utils/upload-validation.js';

function getAudioDuration(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      audio.removeAttribute('src');
      audio.load();
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 10_000);

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      window.clearTimeout(timeoutId);
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      window.clearTimeout(timeoutId);
      cleanup();
      resolve(null);
    };
    audio.src = objectUrl;
  });
}

export default function HomePage() {
  const { user } = useAuth();
  const {
    status,
    progress,
    error: transcriptionError,
    activeJobId,
    result,
    isBusy,
    isCancelling,
    startTranscription,
    cancelDiarization,
    clearError,
    openResult,
  } = useTranscription();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [file, setFile] = useState(null);
  const [language, setLanguage] = useState('');
  const [formError, setFormError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [diarize, setDiarize] = useState(false);
  const [estimatedCredits, setEstimatedCredits] = useState(null);
  const [durationSeconds, setDurationSeconds] = useState(null);
  const [isReadingDuration, setIsReadingDuration] = useState(false);

  const fileInputRef = useRef(null);
  const fileSelectionRef = useRef(0);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!user && location.state?.openAuth) {
      setShowAuthModal(true);
      navigate('/transcribe', { replace: true, state: null });
    }
  }, [location.state, navigate, user]);

  async function selectFile(selected) {
    const validationError = validateUploadFile(selected);
    if (validationError) {
      fileSelectionRef.current += 1;
      setFile(null);
      setEstimatedCredits(null);
      setDurationSeconds(null);
      setIsReadingDuration(false);
      setFormError(validationError);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const selectionId = ++fileSelectionRef.current;
    setFile(selected);
    setEstimatedCredits(null);
    setDurationSeconds(null);
    setIsReadingDuration(true);
    setFormError('');
    clearError();

    const duration = await getAudioDuration(selected);
    if (selectionId !== fileSelectionRef.current) return;

    setIsReadingDuration(false);
    if (duration !== null) {
      setDurationSeconds(duration);
      setEstimatedCredits(Math.max(Math.ceil(duration / 60), 1));
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) selectFile(dropped);
  }

  function handleFileChange(e) {
    const selected = e.target.files[0];
    if (selected) selectFile(selected);
  }

  function handleRemoveFile(e) {
    e.stopPropagation();
    fileSelectionRef.current += 1;
    setFile(null);
    setEstimatedCredits(null);
    setDurationSeconds(null);
    setIsReadingDuration(false);
    fileInputRef.current.value = '';
    setFormError('');
    clearError();
  }

  async function handleSubmit() {
    if (!file) return;

    const validationError = validateUploadFile(file);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (!user) {
      setFormError('로그인이 필요합니다. 좌측 사이드바에서 로그인해주세요.');
      return;
    }

    if (estimatedCredits !== null && user.credits < estimatedCredits) {
      setFormError(`변환 가능 시간이 부족합니다. 필요: ${estimatedCredits}분, 보유: ${user.credits}분. 결제 페이지에서 충전해주세요.`);
      return;
    }

    setFormError('');
    clearError();
    await startTranscription({ file, language, diarize });
  }

  async function handleCancelDiarizationJob() {
    if (!activeJobId || isCancelling) return;
    if (!window.confirm('진행 중인 다화자 작업을 취소하고 예약한 변환 시간을 환불할까요?')) return;
    await cancelDiarization();
  }

  const isProcessing = status === 'queued' || status === 'processing';
  const displayError = formError || transcriptionError;

  return (
    <div className="upload-workspace">
      <header className="workspace-heading">
        <p className="workspace-kicker">NEW TRANSCRIPTION</p>
        <h1 className="workspace-title">새 자막 만들기</h1>
        <p className="workspace-description">
          음성이나 영상 파일을 올리면 편집 가능한 텍스트와 자막으로 변환합니다.
        </p>
      </header>

      {/* 드래그앤드롭 영역 */}
      <div
        className="card upload-dropzone"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          borderColor: isDragOver ? 'var(--gradient-start)' : 'var(--border-color)',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {file ? (
          <div className="selected-file">
            <p className="selected-file__name">
              {file.name}
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '16px' }}>
              {(file.size / 1024 / 1024).toFixed(2)} MB
            </p>
            {isReadingDuration ? (
              <p role="status" style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '12px' }}>
                예상 사용 시간을 확인 중입니다...
              </p>
            ) : estimatedCredits !== null ? (
              <p style={{ color: user && user.credits < estimatedCredits ? '#FF6B6B' : 'var(--gradient-start)', fontSize: '0.8rem', marginBottom: '12px' }}>
                예상 사용 시간: {estimatedCredits}분 · 보유: {user ? user.credits : 0}분
              </p>
            ) : null}
            <button
              onClick={handleRemoveFile}
              style={{
                background: 'none',
                border: '1px solid var(--border-color)',
                color: 'var(--text-secondary)',
                padding: '6px 16px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '0.875rem',
              }}
            >
              파일 제거
            </button>
          </div>
        ) : (
          <button
            className="upload-dropzone__button"
            type="button"
            onClick={() => {
              if (!user) {
                setFormError('로그인이 필요합니다.');
                setShowAuthModal(true);
                return;
              }
              fileInputRef.current.click();
            }}
          >
            <span className="upload-mark" aria-hidden="true">↑</span>
            <span className="upload-title">파일을 끌어놓거나 눌러서 선택</span>
            <span className="upload-support">
              mp3, wav, m4a, webm, mp4 · 최대 150MB · 영상은 오디오만 추출합니다
            </span>
            <span className="upload-credit-rule">음성 1분당 변환 시간 1분을 사용합니다</span>
          </button>
        )}
      </div>

      <section className="conversion-options" aria-label="변환 옵션">
      <div className="conversion-options__field">
        <label htmlFor="transcription-language">
          언어 선택
        </label>
        <select
          id="transcription-language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          style={{
            width: '100%',
            padding: '10px 14px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--border-radius)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-family)',
            fontSize: '0.95rem',
            cursor: 'pointer',
          }}
        >
          <option value="">자동 감지</option>
          <option value="ko">한국어</option>
          <option value="en">영어</option>
          <option value="ja">일본어</option>
          <option value="zh">중국어</option>
        </select>
      </div>

      <label className={diarize ? 'speaker-toggle is-active' : 'speaker-toggle'}>
        <input
          type="checkbox"
          checked={diarize}
          onChange={(event) => setDiarize(event.target.checked)}
        />
        <div>
          <p style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.95rem', margin: 0, marginBottom: '4px' }}>
            인물 여러 명
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0, lineHeight: '1.5' }}>
            인물이 여러 명일 때 체크하면 텍스트에서 색깔로 자동 구분합니다
          </p>
          {diarize && (
            <p style={{ color: 'var(--gradient-start)', fontSize: '0.78rem', margin: 0, marginTop: '4px' }}>
              최대 {DIARIZATION_MAX_MINUTES}분 지원 · 일반 변환보다 시간이 더 소요됩니다
            </p>
          )}
        </div>
      </label>
      </section>

      {/* 변환 버튼 */}
      <button
        className="gradient-btn conversion-submit"
        onClick={handleSubmit}
        disabled={!file || isBusy}
        style={{
          opacity: !file || isBusy ? 0.5 : 1,
          cursor: !file || isBusy ? 'not-allowed' : 'pointer',
        }}
      >
        {status === 'uploading' ? progress : isProcessing ? 'PROCESSING' : '변환 시작'}
      </button>

      {status === 'uploading' && (
        <p className="transcription-upload-status" role="status" aria-live="polite">
          {progress}
        </p>
      )}

      {isProcessing && (
        <section className="transcription-processing" role="status" aria-live="polite" aria-atomic="true">
          <div className="transcription-processing__heading">
            <span className="transcription-processing__spinner" aria-hidden="true" />
            <div>
              <p className="transcription-processing__label">PROCESSING</p>
              <h2>{progress}</h2>
            </div>
          </div>
          <p className="transcription-processing__notice">
            변환이 완료되면 알림을 보내드립니다.
          </p>
          <p className="transcription-processing__detail">
            다른 메뉴로 이동해도 변환은 계속됩니다.
          </p>
          {activeJobId && (
            <button
              type="button"
              className="transcription-processing__cancel"
              onClick={handleCancelDiarizationJob}
              disabled={isCancelling}
            >
              {isCancelling ? '취소 처리 중...' : '작업 취소'}
            </button>
          )}
        </section>
      )}

      {status === 'completed' && result && (
        <section className="transcription-complete-inline" role="status">
          <div>
            <strong>변환이 완료되었습니다.</strong>
            <p>결과 화면에서 자막을 확인하고 내려받을 수 있습니다.</p>
          </div>
          <button type="button" className="button button--primary" onClick={openResult}>
            결과 보기
          </button>
        </section>
      )}

      {/* 에러 메시지 */}
      {displayError && (
        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <p role="alert" style={{ color: '#FF6B72', fontSize: '0.9rem' }}>{displayError}</p>
          {(displayError.includes('시간이 부족') || displayError.includes('충전')) && (
            <button
              onClick={() => navigate('/payment')}
              style={{
                marginTop: '12px',
                background: 'var(--accent)',
                color: '#071009',
                border: 'none',
                borderRadius: 'var(--border-radius)',
                padding: '10px 24px',
                fontFamily: 'var(--font-family)',
                fontWeight: 600,
                fontSize: '0.95rem',
                cursor: 'pointer',
              }}
            >
              변환 시간 충전하기
            </button>
          )}
          {displayError.includes('연결') && (
            <button
              onClick={handleSubmit}
              style={{
                marginTop: '12px',
                background: 'var(--gradient)',
                color: '#0A0A0F',
                border: 'none',
                borderRadius: 'var(--border-radius)',
                padding: '10px 24px',
                fontFamily: 'var(--font-family)',
                fontWeight: 600,
                fontSize: '0.95rem',
                cursor: 'pointer',
              }}
            >
              다시 시도
            </button>
          )}
        </div>
      )}
      <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} />
    </div>
  );
}

