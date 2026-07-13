import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

function buildEditedSegments(segments, editedText) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const normalizedText = String(editedText ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/g, '');
  const lines = normalizedText.split('\n');

  const nextSegments = segments.map((segment, index) => ({
    ...segment,
    text: lines[index] ?? '',
  }));

  if (lines.length > segments.length) {
    const lastIndex = nextSegments.length - 1;
    const overflowText = lines.slice(segments.length).join('\n').trim();
    if (overflowText) {
      nextSegments[lastIndex] = {
        ...nextSegments[lastIndex],
        text: [nextSegments[lastIndex].text, overflowText].filter(Boolean).join('\n'),
      };
    }
  }

  return nextSegments;
}

function formatSegmentTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${tenths}`;
}

const ASS_PRESETS = [
  {
    id: 'youtube',
    label: 'YouTube 기본',
    position: 'bottom',
    fontFamily: 'Pretendard',
    fontColor: '#FFFFFF',
    fontSize: 20,
  },
  {
    id: 'highlight',
    label: '강조형',
    position: 'bottom',
    fontFamily: 'Noto Sans KR',
    fontColor: '#FFFF00',
    fontSize: 24,
  },
  {
    id: 'caption',
    label: '상단 설명',
    position: 'top',
    fontFamily: 'Pretendard',
    fontColor: '#FFFFFF',
    fontSize: 18,
  },
  {
    id: 'interview',
    label: '중앙 인터뷰',
    position: 'middle',
    fontFamily: 'Nanum Gothic',
    fontColor: '#FFFFFF',
    fontSize: 22,
  },
];

const DOWNLOAD_FORMATS = [
  { id: 'srt', name: '표준 자막', detail: '타임코드 포함' },
  { id: 'txt', name: '전체 텍스트', detail: '편집 내용 반영' },
  { id: 'ass', name: '스타일 자막', detail: '위치·폰트·색상 설정' },
];

const LANGUAGE_LABELS = {
  ko: '한국어',
  korean: '한국어',
  en: '영어',
  english: '영어',
  ja: '일본어',
  japanese: '일본어',
  zh: '중국어',
  chinese: '중국어',
  unknown: '자동 감지',
};

function formatResultDuration(segments) {
  const totalSeconds = segments.reduce((maximum, segment) => (
    Math.max(maximum, Number(segment.end) || 0)
  ), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function ResultPage() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const { token } = useAuth();

  // location.state가 있으면 sessionStorage에 저장, 없으면 복원
  useEffect(() => {
    if (state) {
      sessionStorage.setItem('lastResult', JSON.stringify(state));
    } else {
      const saved = sessionStorage.getItem('lastResult');
      if (!saved) navigate('/transcribe');
    }
  }, [state, navigate]);

  const resolved = state || (() => {
    try { return JSON.parse(sessionStorage.getItem('lastResult')); } catch { return null; }
  })();

  const { text = '', segments = [], language = '', diarize = false } = resolved || {};

  const [editedSegments, setEditedSegments] = useState(() => buildEditedSegments(segments, text));
  const [editorMode, setEditorMode] = useState('text');
  const [downloading, setDownloading] = useState(false);
  const editedText = editedSegments.map(segment => segment.text).join('\n');

  const DEFAULT_SPEAKER_COLORS = ['#FFFFFF', '#39FF14', '#FFE600', '#00F5FF', '#FF6B35', '#FF4BCB'];
  const speakerIds = [...new Set(segments.filter(s => s.speaker !== undefined).map(s => s.speaker))].sort((a, b) => a - b);
  const [speakerColors, setSpeakerColors] = useState(() => {
    const init = {};
    speakerIds.forEach(id => { init[String(id)] = DEFAULT_SPEAKER_COLORS[id] ?? '#39FF14'; });
    return init;
  });

  // 영어 번역 상태
  const [showTranslation, setShowTranslation] = useState(false);
  const [translatedSegments, setTranslatedSegments] = useState(null);
  const [translating, setTranslating] = useState(false);

  // ASS 설정 패널 표시 여부
  const [showAssPanel, setShowAssPanel] = useState(false);

  useEffect(() => {
    if (!showAssPanel) return;
    window.requestAnimationFrame(() => {
      document.getElementById('ass-style-panel')?.scrollIntoView({ block: 'start' });
    });
  }, [showAssPanel]);

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

  const activeAssPreset = ASS_PRESETS.find((preset) => (
    preset.position === assPosition
    && preset.fontFamily === assFontFamily
    && preset.fontColor === assFontColor
    && preset.fontSize === assFontSize
  ))?.id;

  // 미리보기용 샘플 텍스트 (첫 번째 세그먼트 사용)
  const previewText = editedSegments.length > 0 ? editedSegments[0].text : '자막 미리보기 텍스트';

  // 미리보기에서 자막 위치 계산
  function getPreviewAlign() {
    if (assPosition === 'top') return 'flex-start';
    if (assPosition === 'middle') return 'center';
    return 'flex-end';
  }

  function updateSegmentText(index, nextText) {
    setEditedSegments(previous => previous.map((segment, segmentIndex) => (
      segmentIndex === index ? { ...segment, text: nextText } : segment
    )));
  }

  function updateFullText(nextText) {
    setEditedSegments(buildEditedSegments(segments, nextText));
  }

  function applyAssPreset(preset) {
    setAssPosition(preset.position);
    setAssFontFamily(preset.fontFamily);
    setAssFontColor(preset.fontColor);
    setAssFontSize(preset.fontSize);
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
      const body = { segments: editedSegments, format };
      if (format === 'ass' && options) {
        body.assOptions = options;
      }
      if (speakerIds.length > 0) {
        body.speakerColors = speakerColors;
      }
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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
        body: JSON.stringify({ segments: editedSegments }),
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

  if (!resolved) return null;

  const languageLabel = LANGUAGE_LABELS[String(language).toLowerCase()] || language || '알 수 없음';
  const resultDuration = formatResultDuration(segments);
  const hasSpeakers = speakerIds.length > 0;

  return (
    <div className="result-workspace">
      <header className="result-heading">
        <div>
          <p className="workspace-kicker">TRANSCRIPTION COMPLETE</p>
          <h1 className="result-title">자막 편집</h1>
          <p className="result-description">변환된 문장을 확인하고 필요한 형식으로 내려받으세요.</p>
        </div>
        <button
          className="button button--secondary result-new-file"
          onClick={() => navigate('/transcribe')}
          type="button"
        >
          새 파일 변환
        </button>
      </header>

      <dl className="result-summary" aria-label="변환 결과 요약">
        <div>
          <dt>상태</dt>
          <dd><span className="result-status-dot" aria-hidden="true" />완료</dd>
        </div>
        <div>
          <dt>언어</dt>
          <dd>{languageLabel}</dd>
        </div>
        <div>
          <dt>길이</dt>
          <dd>{resultDuration}</dd>
        </div>
        <div>
          <dt>구간</dt>
          <dd>{segments.length}개</dd>
        </div>
        <div>
          <dt>화자</dt>
          <dd>{hasSpeakers ? `${speakerIds.length}명` : diarize ? '분석됨' : '단일'}</dd>
        </div>
      </dl>

      {hasSpeakers && (
        <section className="speaker-palette" aria-labelledby="speaker-palette-title">
          <div className="speaker-palette__heading">
            <p className="result-section-kicker">SPEAKERS</p>
            <h2 id="speaker-palette-title">화자 색상</h2>
          </div>
          <div className="speaker-palette__controls">
            {speakerIds.map(id => (
              <label className="speaker-color-control" key={id}>
                <input
                  aria-label={`인물 ${Number(id) + 1} 색상`}
                  type="color"
                  value={speakerColors[String(id)]}
                  onChange={(event) => setSpeakerColors(previous => ({
                    ...previous,
                    [String(id)]: event.target.value,
                  }))}
                />
                <span>인물 {Number(id) + 1}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      <div className="result-layout">
        <section className="result-editor-panel" aria-labelledby="result-editor-title">
          <div className="result-panel-heading">
            <div>
              <p className="result-section-kicker">EDITOR</p>
              <h2 id="result-editor-title">변환 결과</h2>
            </div>
            <span>{editedSegments.length}개 구간</span>
          </div>

          <div className="result-editor-tabs" aria-label="자막 편집 방식" role="tablist">
            {[
              { id: 'text', label: '전체 텍스트' },
              { id: 'segments', label: '구간별 편집' },
            ].map((mode) => (
              <button
                aria-controls={`editor-panel-${mode.id}`}
                aria-selected={editorMode === mode.id}
                className={editorMode === mode.id ? 'is-active' : ''}
                id={`editor-tab-${mode.id}`}
                key={mode.id}
                onClick={() => setEditorMode(mode.id)}
                role="tab"
                type="button"
              >
                {mode.label}
              </button>
            ))}
          </div>

          {editorMode === 'text' ? (
            <div
              aria-labelledby="editor-tab-text"
              className="result-text-editor"
              id="editor-panel-text"
              role="tabpanel"
            >
              <label className="sr-only" htmlFor="full-transcript">전체 변환 텍스트</label>
              <textarea
                id="full-transcript"
                onChange={(event) => updateFullText(event.target.value)}
                value={editedText}
              />
            </div>
          ) : (
            <div
              aria-labelledby="editor-tab-segments"
              className="result-segment-list"
              id="editor-panel-segments"
              role="tabpanel"
            >
              {editedSegments.map((segment, index) => (
                <article className="result-segment-row" key={`${segment.start}-${segment.end}-${index}`}>
                  <div className="result-segment-meta">
                    <span className="result-segment-index">#{String(index + 1).padStart(2, '0')}</span>
                    <span className="result-segment-time">
                      {formatSegmentTime(segment.start)} - {formatSegmentTime(segment.end)}
                    </span>
                    {segment.speaker !== undefined && (
                      <span
                        className="result-segment-speaker"
                        style={{ color: speakerColors[String(segment.speaker)] || 'var(--text-secondary)' }}
                      >
                        인물 {Number(segment.speaker) + 1}
                      </span>
                    )}
                  </div>
                  <textarea
                    aria-label={`자막 구간 ${index + 1}`}
                    onChange={(event) => updateSegmentText(index, event.target.value)}
                    rows={2}
                    value={segment.text}
                  />
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="result-tools" aria-label="자막 내보내기 도구">
          <section className="result-tool-section" aria-labelledby="export-title">
            <div className="result-tool-heading">
              <p className="result-section-kicker">EXPORT</p>
              <h2 id="export-title">다운로드</h2>
            </div>

            <div className="export-options">
              {DOWNLOAD_FORMATS.map((format) => (
                <button
                  className={format.id === 'ass' && showAssPanel ? 'export-option is-active' : 'export-option'}
                  disabled={downloading}
                  key={format.id}
                  onClick={() => handleDownload(format.id)}
                  type="button"
                >
                  <span className="export-option__format">{format.id.toUpperCase()}</span>
                  <span className="export-option__copy">
                    <strong>{format.name}</strong>
                    <small>{format.detail}</small>
                  </span>
                  <span className="export-option__action" aria-hidden="true">
                    {format.id === 'ass' ? '설정' : '↓'}
                  </span>
                </button>
              ))}
            </div>

            {hasSpeakers && (
              <p className="result-tool-note">화자 색상은 SRT와 ASS에 포함됩니다.</p>
            )}
            {downloading && <p className="result-tool-status" role="status">파일 생성 중...</p>}
          </section>

          <section className="result-tool-section" aria-labelledby="translation-title">
            <div className="result-tool-heading result-tool-heading--inline">
              <div>
                <p className="result-section-kicker">OPTIONAL</p>
                <h2 id="translation-title">영어 번역</h2>
              </div>
              {showTranslation && <span className="tool-state">켜짐</span>}
            </div>
            <button
              className={showTranslation ? 'button button--secondary tool-button is-active' : 'button button--secondary tool-button'}
              disabled={translating}
              onClick={handleToggleTranslation}
              type="button"
            >
              {translating
                ? `번역 중 · 약 ${Math.max(Math.ceil(segments.length / 30) * 5, 5)}초`
                : showTranslation ? '번역 닫기' : '영어 번역 만들기'}
            </button>

            {showTranslation && translatedSegments && (
              <>
                <div className="translation-results">
                  {translatedSegments.map((segment, index) => (
                    <div className="translation-row" key={index}>
                      <p>{segment.text}</p>
                      <p>{segment.translatedText}</p>
                    </div>
                  ))}
                </div>
                <button className="translation-download" onClick={handleTranslationTxtDownload} type="button">
                  번역 TXT 다운로드
                </button>
              </>
            )}
          </section>
        </aside>
      </div>

      {showAssPanel && (
        <section className="ass-style-panel" aria-labelledby="ass-style-title" id="ass-style-panel">
          <div className="ass-style-heading">
            <div>
              <p className="result-section-kicker">ASS STYLE</p>
              <h2 id="ass-style-title">스타일 자막 설정</h2>
            </div>
            <button
              aria-label="스타일 설정 닫기"
              className="icon-button ass-style-close"
              onClick={() => setShowAssPanel(false)}
              type="button"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>

          <div className="ass-preset-tabs" aria-label="ASS 자막 프리셋" role="group">
            {ASS_PRESETS.map((preset) => {
              const isActive = activeAssPreset === preset.id;
              return (
                <button
                  aria-pressed={isActive}
                  className={isActive ? 'is-active' : ''}
                  key={preset.id}
                  onClick={() => applyAssPreset(preset)}
                  type="button"
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div className="ass-config-layout">
            <div
              className="ass-preview"
              style={{ alignItems: getPreviewAlign() }}
            >
              <span className="ass-preview__label">16:9 PREVIEW</span>
              <p style={{
                color: assFontColor,
                fontFamily: assFontFamily,
                fontSize: `${Math.max(assFontSize * 0.8, 12)}px`,
              }}>
                {previewText}
              </p>
            </div>

            <div className="ass-controls">
              <div className="ass-control-grid">
                <label>
                  <span>자막 위치</span>
                  <select value={assPosition} onChange={(event) => setAssPosition(event.target.value)}>
                    <option value="top">상단</option>
                    <option value="middle">중앙</option>
                    <option value="bottom">하단</option>
                  </select>
                </label>

                <label>
                  <span>폰트</span>
                  <select value={assFontFamily} onChange={(event) => setAssFontFamily(event.target.value)}>
                    {fontOptions.map((font) => (
                      <option key={font.value} value={font.value}>{font.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <fieldset className="ass-color-field">
                <legend>글자 색상</legend>
                <div className="ass-color-swatches">
                  {colorPresets.map((color) => (
                    <button
                      aria-label={color.label}
                      aria-pressed={assFontColor === color.value}
                      className={assFontColor === color.value ? 'is-active' : ''}
                      key={color.value}
                      onClick={() => setAssFontColor(color.value)}
                      style={{ backgroundColor: color.value }}
                      type="button"
                    />
                  ))}
                  <label className="ass-custom-color">
                    <span className="sr-only">직접 색상 선택</span>
                    <input
                      aria-label="직접 색상 선택"
                      onChange={(event) => setAssFontColor(event.target.value)}
                      type="color"
                      value={assFontColor}
                    />
                  </label>
                </div>
              </fieldset>

              <label className="ass-size-control">
                <span>글자 크기 <strong>{assFontSize}px</strong></span>
                <input
                  max="48"
                  min="12"
                  onChange={(event) => setAssFontSize(Number(event.target.value))}
                  type="range"
                  value={assFontSize}
                />
              </label>

              <button
                className="gradient-btn ass-download"
                disabled={downloading}
                onClick={handleAssDownload}
                type="button"
              >
                {downloading ? '다운로드 중...' : 'ASS 자막 다운로드'}
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
