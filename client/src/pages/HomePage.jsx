import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import AuthModal from '../components/AuthModal.jsx';
import { validateUploadFile } from '../utils/upload-validation.js';

const pendingJobStorageKey = (userId) => `pendingDiarizationJob:${userId}`;

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

function formatElapsedTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}분 ${remainingSeconds}초` : `${remainingSeconds}초`;
}

function estimateDiarizationSeconds(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.max(60, Math.round(durationSeconds * 0.35));
}

function uploadTranscription({ formData, token, onProgress, onUploadComplete }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transcribe');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.upload.onload = onUploadComplete;
    xhr.onerror = () => reject(new Error('서버 연결 중 오류가 발생했습니다.'));
    xhr.onload = () => {
      const data = xhr.response && typeof xhr.response === 'object'
        ? xhr.response
        : (() => {
          try { return JSON.parse(xhr.responseText); } catch { return {}; }
        })();
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        data,
        requestId: xhr.getResponseHeader('X-Request-Id'),
      });
    };
    xhr.send(formData);
  });
}

export default function HomePage() {
  const { user, token, updateCredits, getToken } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [file, setFile] = useState(null);
  const [language, setLanguage] = useState('');
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [diarize, setDiarize] = useState(false);
  const [estimatedCredits, setEstimatedCredits] = useState(null);
  const [durationSeconds, setDurationSeconds] = useState(null);
  const [isReadingDuration, setIsReadingDuration] = useState(false);
  const [activeDiarize, setActiveDiarize] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [transcriptionStartedAt, setTranscriptionStartedAt] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isCancellingJob, setIsCancellingJob] = useState(false);

  const fileInputRef = useRef(null);
  const fileSelectionRef = useRef(0);
  const navigate = useNavigate();

  async function selectFile(selected) {
    const validationError = validateUploadFile(selected);
    if (validationError) {
      fileSelectionRef.current += 1;
      setFile(null);
      setEstimatedCredits(null);
      setDurationSeconds(null);
      setIsReadingDuration(false);
      setStatus('error');
      setError(validationError);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const selectionId = ++fileSelectionRef.current;
    setFile(selected);
    setEstimatedCredits(null);
    setDurationSeconds(null);
    setIsReadingDuration(true);
    setStatus('idle');
    setError('');

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
    setStatus('idle');
    setError('');
  }

  async function handleSubmit() {
    if (!file) return;

    const validationError = validateUploadFile(file);
    if (validationError) {
      setStatus('error');
      setError(validationError);
      return;
    }

    if (!user) {
      setError('로그인이 필요합니다. 좌측 사이드바에서 로그인해주세요.');
      return;
    }

    if (estimatedCredits !== null && user.credits < estimatedCredits) {
      setError(`변환 가능 시간이 부족합니다. 필요: ${estimatedCredits}분, 보유: ${user.credits}분. 결제 페이지에서 충전해주세요.`);
      return;
    }

    setError('');
    setActiveDiarize(diarize);
    setTranscriptionStartedAt(null);
    setElapsedSeconds(0);
    setStatus('uploading');
    setProgress('파일 업로드 중...');

    try {
      const formData = new FormData();
      formData.append('audio', file);
      if (language) formData.append('language', language);
      if (diarize) formData.append('diarize', 'true');

      const token = getToken();
      const { status: responseStatus, ok, data, requestId } = await uploadTranscription({
        formData,
        token,
        onProgress: (ratio) => setProgress(`파일 업로드 중... ${Math.min(Math.round(ratio * 100), 100)}%`),
        onUploadComplete: () => {
          setStatus('transcribing');
          setTranscriptionStartedAt(Date.now());
          setProgress(diarize
            ? '파일 전송 완료. 화자 분석과 자막 생성을 진행 중입니다...'
            : '파일 전송 완료. 음성 전사와 맞춤법 교정을 진행 중입니다...');
        },
      });

      if (responseStatus === 401) {
        setStatus('error');
        setError('로그인이 필요합니다. 좌측 사이드바에서 로그인해주세요.');
        return;
      }

      if (responseStatus === 402) {
        setStatus('error');
        setError(`변환 가능 시간이 부족합니다. 필요: ${data.creditsNeeded}분, 보유: ${data.creditsHave}분. 결제 페이지에서 충전해주세요.`);
        return;
      }

      if (!ok) {
        const message = data.error || '변환 요청 실패';
        throw new Error(requestId ? `${message} (오류 코드: ${requestId})` : message);
      }

      if (data.creditsRemaining !== undefined) {
        updateCredits(data.creditsRemaining);
      }

      if (responseStatus === 202 && data.jobId) {
        localStorage.setItem(pendingJobStorageKey(user.id), data.jobId);
        setActiveJobId(data.jobId);
        setStatus('queued');
        setProgress('파일 전송 완료. 다화자 분석 작업을 대기열에 등록했습니다...');
        return;
      }

      navigate('/result', { state: { text: data.text, segments: data.segments, language: data.language, diarize: data.diarize } });
    } catch (err) {
      setStatus('error');
      setError(err.message || '오류가 발생했습니다.');
    }
  }

  async function handleCancelDiarizationJob() {
    if (!activeJobId || !token || !user?.id || isCancellingJob) return;
    if (!window.confirm('진행 중인 다화자 작업을 취소하고 예약한 변환 시간을 환불할까요?')) return;

    setIsCancellingJob(true);
    try {
      const response = await fetch(`/api/transcribe/jobs/${activeJobId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '작업을 취소하지 못했습니다.');

      if (data.creditsRemaining !== undefined) updateCredits(data.creditsRemaining);
      localStorage.removeItem(pendingJobStorageKey(user.id));
      setActiveJobId(null);
      setStatus('error');
      setError('작업을 취소하고 예약한 변환 시간을 환불했습니다.');
    } catch (err) {
      setProgress(err.message || '작업 취소 중 오류가 발생했습니다.');
    } finally {
      setIsCancellingJob(false);
    }
  }

  const isLoading = status !== 'idle' && status !== 'error';
  const shouldWarnBeforeUnload = status === 'uploading' || (status === 'transcribing' && !activeJobId);

  // 원본을 전송하는 중에만 이탈을 경고합니다. 대기열 작업은 서버에서 계속됩니다.
  useEffect(() => {
    if (!shouldWarnBeforeUnload) return;
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [shouldWarnBeforeUnload]);

  useEffect(() => {
    if ((status !== 'transcribing' && status !== 'queued') || !transcriptionStartedAt) return;

    const updateElapsedTime = () => {
      setElapsedSeconds((Date.now() - transcriptionStartedAt) / 1000);
    };

    updateElapsedTime();
    const intervalId = window.setInterval(updateElapsedTime, 1_000);
    return () => window.clearInterval(intervalId);
  }, [status, transcriptionStartedAt]);

  useEffect(() => {
    if (!user?.id || !token || activeJobId) return;

    const savedJobId = localStorage.getItem(pendingJobStorageKey(user.id));
    if (!savedJobId) return;

    setActiveJobId(savedJobId);
    setActiveDiarize(true);
    setStatus('queued');
    setProgress('이전 다화자 분석 작업 상태를 확인 중입니다...');
    setTranscriptionStartedAt(Date.now());
  }, [user?.id, token, activeJobId]);

  useEffect(() => {
    if (!activeJobId || !token || !user?.id) return;

    let cancelled = false;

    async function pollJob() {
      try {
        const response = await fetch(`/api/transcribe/jobs/${activeJobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '다화자 작업 상태를 확인하지 못했습니다.');
        if (cancelled) return;

        if (data.creditsRemaining !== undefined) updateCredits(data.creditsRemaining);

        if (data.status === 'completed') {
          localStorage.removeItem(pendingJobStorageKey(user.id));
          setActiveJobId(null);
          navigate('/result', {
            state: {
              text: data.text,
              segments: data.segments,
              language: data.language,
              diarize: true,
            },
          });
          return;
        }

        if (data.status === 'failed') {
          localStorage.removeItem(pendingJobStorageKey(user.id));
          setActiveJobId(null);
          setStatus('error');
          setError(data.error || '변환에 실패했지만 예약한 변환 시간은 자동 환불되었습니다.');
          return;
        }

        setStatus(data.status === 'running' ? 'transcribing' : 'queued');
        setProgress(data.status === 'running'
          ? '화자 분석과 자막 생성을 진행 중입니다...'
          : '다화자 분석 작업을 대기열에서 기다리고 있습니다...');
      } catch (err) {
        if (!cancelled) {
          setStatus('queued');
          setProgress('작업 상태를 다시 확인 중입니다...');
        }
      }
    }

    pollJob();
    const intervalId = window.setInterval(pollJob, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeJobId, navigate, token, updateCredits, user?.id]);

  const isDiarizationProcessing = activeDiarize && (status === 'queued' || status === 'transcribing');
  const estimatedDiarizationSeconds = estimateDiarizationSeconds(durationSeconds);
  const estimatedDiarizationLabel = estimatedDiarizationSeconds === null
    ? '파일 길이에 따라 달라집니다'
    : `약 ${Math.ceil(estimatedDiarizationSeconds / 60)}분`;
  const estimatedProgress = estimatedDiarizationSeconds === null
    ? 0.12
    : Math.min(0.92, Math.max(0.12, elapsedSeconds / estimatedDiarizationSeconds));

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
          accept=".mp3,.wav,.m4a,.webm,.mp4,.mpeg,.mpga,.ogg,.flac"
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
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '12px' }}>
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
                setError('로그인이 필요합니다.');
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
              최대 20분 지원 · 일반 변환보다 시간이 더 소요됩니다
            </p>
          )}
        </div>
      </label>
      </section>

      {/* 변환 버튼 */}
      <button
        className="gradient-btn conversion-submit"
        onClick={handleSubmit}
        disabled={!file || isLoading}
        style={{
          opacity: !file || isLoading ? 0.5 : 1,
          cursor: !file || isLoading ? 'not-allowed' : 'pointer',
        }}
      >
        {isLoading ? progress : '변환 시작'}
      </button>

      {/* 진행 상태 */}
      {status !== 'idle' && status !== 'error' && (
        <p style={{ marginTop: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          {progress}
        </p>
      )}

      {isDiarizationProcessing && (
        <section
          aria-live="polite"
          style={{
            marginTop: '16px',
            padding: '16px 0',
            borderTop: '1px solid var(--border-color)',
            borderBottom: '1px solid var(--border-color)',
          }}
        >
          <p style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.95rem', margin: 0 }}>
            {status === 'queued' ? '화자 분석 작업을 대기열에서 기다리고 있습니다' : '화자 분석과 자막 생성을 진행 중입니다'}
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '6px 0 12px' }}>
            경과 {formatElapsedTime(elapsedSeconds)} · 예상 {estimatedDiarizationLabel}
          </p>
          <div
            aria-label="다화자 전사 예상 진행 상태"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(estimatedProgress * 100)}
            role="progressbar"
            style={{
              height: '6px',
              overflow: 'hidden',
              background: 'var(--bg-tertiary)',
              borderRadius: '3px',
            }}
          >
            <div
              style={{
                width: `${Math.round(estimatedProgress * 100)}%`,
                height: '100%',
                background: 'var(--gradient)',
                transition: 'width 1s linear',
              }}
            />
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: '1.5', margin: '10px 0 0' }}>
            실제 완료 시점은 파일 길이와 화자 수에 따라 달라집니다.
          </p>
          <button
            type="button"
            onClick={handleCancelDiarizationJob}
            disabled={isCancellingJob}
            style={{
              marginTop: '14px',
              padding: '8px 12px',
              border: '1px solid #FF6666',
              borderRadius: 'var(--border-radius)',
              background: 'transparent',
              color: '#FF8888',
              fontFamily: 'var(--font-family)',
              fontSize: '0.82rem',
              cursor: isCancellingJob ? 'wait' : 'pointer',
              opacity: isCancellingJob ? 0.6 : 1,
            }}
          >
            {isCancellingJob ? '취소 처리 중...' : '작업 취소'}
          </button>
        </section>
      )}

      {/* 에러 메시지 */}
      {status === 'error' && (
        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <p style={{ color: '#FF4444', fontSize: '0.9rem' }}>{error}</p>
          {(error.includes('시간이 부족') || error.includes('충전')) && (
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
          {error.includes('연결') && (
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

