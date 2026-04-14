import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export default function ResultPage() {
  const { state } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!state) navigate('/');
  }, [state, navigate]);

  const { text = '', segments = [], language = '' } = state || {};

  const [editedText, setEditedText] = useState(text);
  const [downloading, setDownloading] = useState(false);

  // 영어 번역 상태
  const [showTranslation, setShowTranslation] = useState(false);
  const [translatedSegments, setTranslatedSegments] = useState(null);
  const [translating, setTranslating] = useState(false);

  // ASS 설정 패널 표시 여부
  const [showAssPanel, setShowAssPanel] = useState(false);

  // ASS 스타일 옵션
  const [assPosition, setAssPosition] = useState('bottom');
  const [assFontFamily, setAssFontFamily] = useState('Pretendard');
  const [assFontColor, setAssFontColor] = useState('#FFFFFF');
  const [assFontSize, setAssFontSize] = useState(20);

  const fontOptions = [
    { value: 'Pretendard', label: 'Pretendard (기본)' },
    { value: 'Noto Sans KR', label: 'Noto Sans KR' },
    { value: 'Nanum Gothic', label: '나눔고딕' },
    { value: 'Nanum Myeongjo', label: '나눔명조' },
    { value: 'Malgun Gothic', label: '맑은 고딕' },
    { value: 'Gulim', label: '굴림' },
    { value: 'Dotum', label: '돋움' },
    { value: 'Batang', label: '바탕' },
    { value: 'Arial', label: 'Arial' },
    { value: 'Roboto', label: 'Roboto' },
  ];

  const colorPresets = [
    { value: '#FFFFFF', label: '흰색' },
    { value: '#FFFF00', label: '노란색' },
    { value: '#00FF00', label: '초록색' },
    { value: '#00FFFF', label: '하늘색' },
    { value: '#FF6B6B', label: '빨간색' },
    { value: '#FF69B4', label: '분홍색' },
    { value: '#FFA500', label: '주황색' },
    { value: '#A855F7', label: '보라색' },
  ];

  // 미리보기용 샘플 텍스트 (첫 번째 세그먼트 사용)
  const previewText = segments.length > 0 ? segments[0].text : '자막 미리보기 텍스트';

  // 미리보기에서 자막 위치 계산
  function getPreviewAlign() {
    if (assPosition === 'top') return 'flex-start';
    if (assPosition === 'middle') return 'center';
    return 'flex-end';
  }

  async function handleDownload(format) {
    if (format === 'ass') {
      setShowAssPanel(true);
      return;
    }
    await doDownload(format);
  }

  async function doDownload(format, options) {
    setDownloading(true);
    try {
      const body = { segments, format };
      if (format === 'ass' && options) {
        body.assOptions = options;
      }
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('다운로드 실패');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `subtitle.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    } finally {
      setDownloading(false);
    }
  }

  async function handleToggleTranslation() {
    if (showTranslation) {
      setShowTranslation(false);
      return;
    }
    setShowTranslation(true);
    if (translatedSegments) return; // 캐시 히트
    setTranslating(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ segments }),
      });
      if (!res.ok) throw new Error('번역 요청 실패');
      const data = await res.json();
      setTranslatedSegments(data.translatedSegments);
    } catch (err) {
      alert(err.message);
      setShowTranslation(false);
    } finally {
      setTranslating(false);
    }
  }

  function handleTranslationTxtDownload() {
    if (!translatedSegments) return;
    const lines = translatedSegments
      .flatMap(s => [s.text, s.translatedText])
      .join('\n');
    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'translation.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleAssDownload() {
    doDownload('ass', {
      position: assPosition,
      fontFamily: assFontFamily,
      fontColor: assFontColor,
      fontSize: assFontSize,
    });
  }

  if (!state) return null;

  const selectStyle = {
    padding: '8px 12px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    fontFamily: 'var(--font-family)',
    cursor: 'pointer',
  };

  const labelStyle = {
    display: 'block',
    color: 'var(--text-muted)',
    fontSize: '0.8rem',
    marginBottom: '6px',
  };

  const outlineBtn = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    padding: '10px 24px',
    borderRadius: 'var(--border-radius)',
    fontFamily: 'var(--font-family)',
    fontWeight: 600,
    fontSize: '0.95rem',
    cursor: downloading ? 'not-allowed' : 'pointer',
    opacity: downloading ? 0.5 : 1,
    transition: 'border-color 0.2s',
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '40px 20px' }}>
      <h1 className="gradient-text" style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '8px' }}>
        변환 완료
      </h1>

      <div style={{ display: 'flex', gap: '24px', marginBottom: '24px' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          감지된 언어: <span style={{ color: 'var(--text-primary)' }}>{language || '알 수 없음'}</span>
        </p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          세그먼트 수: <span style={{ color: 'var(--text-primary)' }}>{segments.length}개</span>
        </p>
      </div>

      <div style={{ marginBottom: '24px' }}>
        <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '8px' }}>
          변환 결과 (직접 편집 가능)
        </label>
        <textarea
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          style={{
            width: '100%',
            minHeight: '300px',
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--border-radius)',
            padding: '16px',
            fontFamily: 'var(--font-family)',
            fontSize: '0.95rem',
            lineHeight: '1.6',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* 영어 번역 토글 */}
      <div style={{ marginBottom: '24px' }}>
        <button
          onClick={handleToggleTranslation}
          disabled={translating}
          style={{
            background: showTranslation ? 'linear-gradient(135deg, #39FF14, #00F5FF)' : 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            color: showTranslation ? '#000' : 'var(--text-primary)',
            padding: '10px 24px',
            borderRadius: 'var(--border-radius)',
            fontFamily: 'var(--font-family)',
            fontWeight: 600,
            fontSize: '0.95rem',
            cursor: translating ? 'not-allowed' : 'pointer',
            opacity: translating ? 0.6 : 1,
            transition: 'all 0.2s',
          }}
        >
          {translating ? '번역 중...' : '🌐 영어 번역'}
        </button>

        {showTranslation && translatedSegments && (
          <div style={{
            marginTop: '16px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--border-radius)',
            padding: '16px',
            maxHeight: '360px',
            overflowY: 'auto',
          }}>
            {translatedSegments.map((seg, idx) => (
              <div key={idx} style={{ marginBottom: '10px', lineHeight: '1.5' }}>
                <div style={{ color: '#FFFFFF', fontSize: '0.95rem' }}>{seg.text}</div>
                <div style={{ color: '#4ADE80', fontSize: '0.9rem', paddingLeft: '12px' }}>{seg.translatedText}</div>
              </div>
            ))}
          </div>
        )}

        {showTranslation && translatedSegments && (
          <button
            onClick={handleTranslationTxtDownload}
            style={{
              marginTop: '12px',
              background: 'var(--bg-tertiary)',
              border: '1px solid #4ADE80',
              color: '#4ADE80',
              padding: '8px 20px',
              borderRadius: 'var(--border-radius)',
              fontFamily: 'var(--font-family)',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            번역 TXT 다운로드
          </button>
        )}
      </div>

      {/* 다운로드 버튼 */}
      <div style={{ marginBottom: '16px' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '12px' }}>
          자막 다운로드
        </p>
        <div style={{ display: 'flex', gap: '12px' }}>
          {['srt', 'txt', 'ass'].map((format) => (
            <button
              key={format}
              onClick={() => handleDownload(format)}
              disabled={downloading}
              style={{
                ...outlineBtn,
                ...(format === 'ass' && showAssPanel ? {
                  borderColor: 'var(--gradient-start)',
                  color: 'var(--gradient-start)',
                } : {}),
              }}
            >
              {format.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* ASS 스타일 설정 패널 (ASS 버튼 클릭 시 표시) */}
      {showAssPanel && (
        <div className="card" style={{ padding: '24px', marginBottom: '24px', border: '1px solid var(--gradient-start)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 600 }}>
              🎨 ASS 자막 스타일 설정
            </h3>
            <button
              onClick={() => setShowAssPanel(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>

          {/* 미리보기 창 */}
          <div style={{
            width: '100%',
            aspectRatio: '16 / 9',
            background: '#000',
            borderRadius: '8px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: getPreviewAlign(),
            justifyContent: 'center',
            padding: '16px',
            boxSizing: 'border-box',
            position: 'relative',
            overflow: 'hidden',
          }}>
            {/* 배경 가이드 텍스트 */}
            <p style={{
              position: 'absolute',
              top: '8px',
              left: '12px',
              color: 'rgba(255,255,255,0.15)',
              fontSize: '0.7rem',
              margin: 0,
            }}>
              미리보기 (16:9)
            </p>

            {/* 자막 미리보기 */}
            <p style={{
              color: assFontColor,
              fontFamily: assFontFamily,
              fontSize: `${Math.max(assFontSize * 0.8, 12)}px`,
              fontWeight: 400,
              textAlign: 'center',
              textShadow: '1px 1px 3px rgba(0,0,0,0.9), -1px -1px 3px rgba(0,0,0,0.9)',
              margin: 0,
              padding: '4px 12px',
              lineHeight: 1.4,
              maxWidth: '90%',
              wordBreak: 'keep-all',
            }}>
              {previewText}
            </p>
          </div>

          {/* 설정 옵션 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>

            {/* 위치 */}
            <div>
              <label style={labelStyle}>자막 위치</label>
              <select value={assPosition} onChange={(e) => setAssPosition(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                <option value="top">상단</option>
                <option value="middle">중앙</option>
                <option value="bottom">하단 (기본)</option>
              </select>
            </div>

            {/* 폰트 */}
            <div>
              <label style={labelStyle}>폰트</label>
              <select value={assFontFamily} onChange={(e) => setAssFontFamily(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                {fontOptions.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>

            {/* 색상 */}
            <div>
              <label style={labelStyle}>글자 색상</label>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                {colorPresets.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setAssFontColor(c.value)}
                    title={c.label}
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: c.value,
                      border: assFontColor === c.value ? '3px solid var(--gradient-start)' : '2px solid var(--border-color)',
                      cursor: 'pointer',
                      transition: 'border 0.2s',
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={assFontColor}
                  onChange={(e) => setAssFontColor(e.target.value)}
                  title="직접 선택"
                  style={{ width: '28px', height: '28px', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                />
              </div>
            </div>

            {/* 글자 크기 */}
            <div>
              <label style={labelStyle}>글자 크기: {assFontSize}px</label>
              <input
                type="range"
                min="12"
                max="48"
                value={assFontSize}
                onChange={(e) => setAssFontSize(Number(e.target.value))}
                style={{ width: '100%', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                <span>12</span><span>20</span><span>30</span><span>48</span>
              </div>
            </div>
          </div>

          {/* ASS 다운로드 버튼 */}
          <button
            className="gradient-btn"
            onClick={handleAssDownload}
            disabled={downloading}
            style={{
              width: '100%',
              marginTop: '20px',
              opacity: downloading ? 0.5 : 1,
            }}
          >
            {downloading ? '다운로드 중...' : 'ASS 자막 다운로드'}
          </button>
        </div>
      )}

      <button
        className="gradient-btn"
        onClick={() => navigate('/')}
        style={{ width: '100%', marginTop: '16px' }}
      >
        새 파일 변환
      </button>
    </div>
  );
}
