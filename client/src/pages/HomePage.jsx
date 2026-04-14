import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import AuthModal from '../components/AuthModal.jsx';

export default function HomePage() {
  const { user, updateCredits, getToken } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [file, setFile] = useState(null);
  const [language, setLanguage] = useState('');
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef(null);
  const navigate = useNavigate();

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
    if (dropped) setFile(dropped);
  }

  function handleFileChange(e) {
    const selected = e.target.files[0];
    if (selected) setFile(selected);
  }

  function handleRemoveFile(e) {
    e.stopPropagation();
    setFile(null);
    fileInputRef.current.value = '';
  }

  async function handleSubmit() {
    if (!file) return;

    if (!user) {
      setError('로그인이 필요합니다. 좌측 사이드바에서 로그인해주세요.');
      return;
    }

    setError('');
    setStatus('uploading');
    setProgress('파일 업로드 중...');

    try {
      const formData = new FormData();
      formData.append('audio', file);
      if (language) formData.append('language', language);

      const token = getToken();
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData,
      });

      if (res.status === 401) {
        setStatus('error');
        setError('로그인이 필요합니다. 좌측 사이드바에서 로그인해주세요.');
        return;
      }

      if (res.status === 402) {
        const data = await res.json();
        setStatus('error');
        setError(`크레딧이 부족합니다. 필요: ${data.creditsNeeded}, 보유: ${data.creditsHave}. 결제 페이지에서 충전해주세요.`);
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '변환 요청 실패');
      }

      setStatus('transcribing');
      setProgress('음성 변환 완료');

      const data = await res.json();

      if (data.creditsRemaining !== undefined) {
        updateCredits(data.creditsRemaining);
      }

      navigate('/result', { state: { text: data.text, segments: data.segments, language: data.language } });
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
              mp3, wav, m4a, webm, mp4 · 최대 150MB (영상 파일은 오디오만 추출)
            </p>
            <p style={{ color: '#999', fontSize: '0.8rem', marginTop: '6px' }}>
              1크레딧으로 약 1분 분량의 음성을 변환할 수 있습니다
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

      {/* 에러 메시지 */}
      {status === 'error' && (
        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <p style={{ color: '#FF4444', fontSize: '0.9rem' }}>{error}</p>
          {error.includes('크레딧') && (
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
              💎 크레딧 충전하기
            </button>
          )}
        </div>
      )}
      <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} />
    </div>
  );
}
