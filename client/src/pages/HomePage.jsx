import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import AuthModal from '../components/AuthModal.jsx';

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
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, data });
    };
    xhr.send(formData);
  });
}

export default function HomePage() {
  const { user, updateCredits, getToken } = useAuth();
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
  const [transcriptionStartedAt, setTranscriptionStartedAt] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const fileInputRef = useRef(null);
  const fileSelectionRef = useRef(0);
  const navigate = useNavigate();

  async function selectFile(selected) {
    const selectionId = ++fileSelectionRef.current;
    setFile(selected);
    setEstimatedCredits(null);
    setDurationSeconds(null);
    setIsReadingDuration(true);

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
  }

  async function handleSubmit() {
    if (!file) return;

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
      const { status: responseStatus, ok, data } = await uploadTranscription({
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
        throw new Error(data.error || '변환 요청 실패');
      }

      if (data.creditsRemaining !== undefined) {
        updateCredits(data.creditsRemaining);
      }

      navigate('/result', { state: { text: data.text, segments: data.segments, language: data.language, diarize: data.diarize } });
    } catch (err) {
      setStatus('error');
      setError(err.message || '오류가 발생했습니다.');
    }
  }

  const isLoading = status !== 'idle' && status !== 'error';

  // 변환 진행 중 페이지 이탈 경고
  useEffect(() => {
    if (!isLoading) return;
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isLoading]);

  useEffect(() => {
    if (status !== 'transcribing' || !transcriptionStartedAt) return;

    const updateElapsedTime = () => {
      setElapsedSeconds((Date.now() - transcriptionStartedAt) / 1000);
    };

    updateElapsedTime();
    const intervalId = window.setInterval(updateElapsedTime, 1_000);
    return () => window.clearInterval(intervalId);
  }, [status, transcriptionStartedAt]);

  const isDiarizationProcessing = status === 'transcribing' && activeDiarize;
  const estimatedDiarizationSeconds = estimateDiarizationSeconds(durationSeconds);
  const estimatedDiarizationLabel = estimatedDiarizationSeconds === null
    ? '파일 길이에 따라 달라집니다'
    : `약 ${Math.ceil(estimatedDiarizationSeconds / 60)}분`;
  const estimatedProgress = estimatedDiarizationSeconds === null
    ? 0.12
    : Math.min(0.92, Math.max(0.12, elapsedSeconds / estimatedDiarizationSeconds));

  return (
    <div style={{ maxWidth: '640px', margin: '0 auto', padding: '40px 20px' }}>
      <h1 className="gradient-text" style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '8px' }}>
        프리뷰 자막 머신
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '32px' }}>
        음성 파일을 업로드하면 텍스트와 자막 파일로 변환해 드립니다.
      </p>

      {/* 드래그앤드롭 영역 */}
      <div
        className="card"
        onClick={() => {
          if (!user) {
            setError('로그인이 필요합니다.');
            setShowAuthModal(true);
            return;
          }
          fileInputRef.current.click();
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: `2px dashed ${isDragOver ? 'var(--gradient-start)' : 'var(--border-color)'}`,
          textAlign: 'center',
          padding: '60px 24px',
          cursor: 'pointer',
          transition: 'border-color 0.2s',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {file ? (
          <div>
            <p style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '8px' }}>
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
          <div>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '8px' }}>
              오디오 파일을 드래그하거나 클릭하여 업로드
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              mp3, wav, m4a, webm, mp4 · 최대 150MB · 대용량 파일은 자동 압축 후 변환 (영상 파일은 오디오만 추출)
            </p>
            <p style={{ color: '#999', fontSize: '0.8rem', marginTop: '6px' }}>
              변환 시간은 음성 1분당 1분씩 차감됩니다
            </p>
          </div>
        )}
      </div>

      {/* 언어 선택 */}
      <div style={{ marginTop: '16px' }}>
        <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '8px' }}>
          언어 선택
        </label>
        <select
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

      {/* 다화자 분리 옵션 */}
      <div
        onClick={() => setDiarize(v => !v)}
        style={{
          marginTop: '16px',
          padding: '14px 16px',
          background: diarize ? 'rgba(57, 255, 20, 0.08)' : 'var(--bg-tertiary)',
          border: `1px solid ${diarize ? 'var(--gradient-start)' : 'var(--border-color)'}`,
          borderRadius: 'var(--border-radius)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '12px',
          transition: 'all 0.2s',
        }}
      >
        <input
          type="checkbox"
          checked={diarize}
          onChange={() => {}}
          style={{ marginTop: '2px', accentColor: 'var(--gradient-start)', cursor: 'pointer', flexShrink: 0 }}
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
      </div>

      {/* 변환 버튼 */}
      <button
        className="gradient-btn"
        onClick={handleSubmit}
        disabled={!file || isLoading}
        style={{
          width: '100%',
          marginTop: '20px',
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
            화자 분석과 자막 생성을 진행 중입니다
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
                background: 'linear-gradient(135deg, #A855F7, #6366F1)',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: 'var(--border-radius)',
                padding: '10px 24px',
                fontFamily: 'var(--font-family)',
                fontWeight: 600,
                fontSize: '0.95rem',
                cursor: 'pointer',
              }}
            >
              💎 변환 시간 충전하기
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
              🔄 다시 시도
            </button>
          )}
        </div>
      )}
      <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} />
    </div>
  );
}
