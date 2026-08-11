import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthModal from '../components/AuthModal.jsx';
import CaptionIdeaHistory from '../components/CaptionIdeaHistory.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useDialogAccessibility } from '../utils/use-dialog-accessibility.js';
import { CAPTION_IDEA_MODES as MODES, createRequestId } from '../utils/caption-ideas.js';

export default function CaptionIdeasPage() {
  const { user, getToken, updateCredits } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('entertainment');
  const [text, setText] = useState('');
  const [ideas, setIdeas] = useState([]);
  const [remainingUses, setRemainingUses] = useState(0);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusUserId, setStatusUserId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyMounted, setHistoryMounted] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const modeRefs = useRef([]);
  const confirmationDialogRef = useRef(null);
  const confirmationCancelRef = useRef(null);
  const generateButtonRef = useRef(null);
  const pendingRequestRef = useRef(null);
  const copyTimerRef = useRef(null);

  const closeConfirmation = useCallback(() => {
    if (!generating) setConfirmationOpen(false);
  }, [generating]);

  useDialogAccessibility({
    active: confirmationOpen,
    containerRef: confirmationDialogRef,
    initialFocusRef: confirmationCancelRef,
    onClose: closeConfirmation,
    restoreFocusRef: generateButtonRef,
    closeOnEscape: !generating,
  });

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    setHistoryOpen(false);
    setHistoryMounted(false);
  }, [user?.id]);

  useEffect(() => {
    if (!user) {
      setStatusLoading(false);
      setStatusUserId(null);
      setRemainingUses(0);
      setIdeas([]);
      setError('');
      return;
    }

    let active = true;
    setStatusLoading(true);
    fetch('/api/caption-ideas/status', {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return data;
      })
      .then((data) => {
        if (!active) return;
        setRemainingUses(Number(data.remainingUses || 0));
        updateCredits(Number(data.credits || 0));
        setStatusUserId(user.id);
      })
      .catch((statusError) => {
        if (active) setError(statusError.message || '생성 가능 횟수를 확인하지 못했습니다.');
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });

    return () => { active = false; };
  }, [getToken, updateCredits, user?.id]);

  const statusPending = Boolean(user) && (statusLoading || statusUserId !== user.id);

  const runGeneration = async () => {
    const normalizedText = text.trim();
    if (!normalizedText) {
      setError('장면 또는 대사를 입력해주세요.');
      return;
    }

    const pending = pendingRequestRef.current;
    const requestId = pending?.text === normalizedText && pending?.mode === mode
      ? pending.requestId
      : createRequestId();
    pendingRequestRef.current = { requestId, text: normalizedText, mode };

    setGenerating(true);
    setConfirmationOpen(false);
    setError('');
    setAnnouncement('자막 아이디어를 만들고 있습니다.');
    setIdeas([]);

    try {
      const response = await fetch('/api/caption-ideas', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ requestId, mode, text: normalizedText }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 402) {
          updateCredits(Number(data.creditsHave || 0));
          setRemainingUses(Number(data.remainingUses || 0));
        }
        const requestError = new Error(data.error || '자막 아이디어를 만들지 못했습니다.');
        requestError.status = response.status;
        requestError.code = data.code;
        throw requestError;
      }

      pendingRequestRef.current = null;
      setIdeas(data.ideas || []);
      setRemainingUses(Number(data.remainingUses || 0));
      updateCredits(Number(data.creditsRemaining || 0));
      setAnnouncement(`자막 아이디어 3개가 완성되었습니다. ${data.remainingUses}회 남았습니다.`);
      setHistoryRefreshKey((current) => current + 1);
    } catch (generationError) {
      if (generationError.status === 409) pendingRequestRef.current = null;
      setError(generationError.message || '자막 아이디어를 만들지 못했습니다.');
      setAnnouncement('자막 아이디어 생성에 실패했습니다. 사용 횟수는 차감되지 않습니다.');
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerate = () => {
    setError('');
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (statusPending) return;
    if (!text.trim()) {
      setError('장면 또는 대사를 입력해주세요.');
      return;
    }
    if (remainingUses === 0 && Number(user.credits || 0) < 1) {
      navigate('/payment');
      return;
    }
    if (remainingUses === 0) {
      setConfirmationOpen(true);
      return;
    }
    runGeneration();
  };

  const handleModeKeyDown = (event, index) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (index + direction + MODES.length) % MODES.length;
    setMode(MODES[nextIndex].id);
    modeRefs.current[nextIndex]?.focus();
  };

  const copyIdea = async (idea, index) => {
    try {
      await navigator.clipboard.writeText(idea);
      setCopiedIndex(index);
      setAnnouncement(`${index + 1}번 자막을 복사했습니다.`);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedIndex(null), 1600);
    } catch {
      setError('클립보드에 복사하지 못했습니다.');
    }
  };

  const toggleHistory = () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (!historyOpen) setHistoryMounted(true);
    setHistoryOpen((current) => !current);
  };

  const generateLabel = !user
    ? '로그인하고 생성'
    : statusPending
      ? '사용 정보 확인 중'
      : remainingUses > 0
        ? `아이디어 3개 생성 · ${remainingUses}회 남음`
        : Number(user.credits || 0) > 0
          ? '1분으로 생성 5회 시작'
          : '변환 시간 충전';

  return (
    <div className="caption-ideas-page">
      <header className="workspace-heading">
        <p className="workspace-kicker">CAPTION IDEAS</p>
        <h1 className="workspace-title">자막 아이디어</h1>
        <p className="workspace-description">장면과 대사의 결을 살린 짧은 자막을 제안합니다.</p>
      </header>

      <div className="caption-ideas-visual">
        <img
          src="/caption-ideas-example.webp"
          alt="밤 11시 야근 장면을 예능, 상황, 감성 자막으로 다르게 표현한 예시"
          width="1600"
          height="893"
          decoding="async"
        />
      </div>

      <section className="caption-ideas-tool" aria-labelledby="caption-ideas-input-title">
        <div className="caption-ideas-field-heading">
          <label id="caption-ideas-input-title" htmlFor="caption-ideas-text">장면 또는 대사</label>
          <span>{Array.from(text).length}/500</span>
        </div>
        <textarea
          id="caption-ideas-text"
          value={text}
          maxLength={500}
          rows={6}
          placeholder="자막이 필요한 장면이나 대사를 입력하세요"
          onChange={(event) => {
            setText(event.target.value);
            setError('');
          }}
          disabled={generating}
        />

        <div className="caption-ideas-mode" role="radiogroup" aria-label="자막 유형">
          {MODES.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => { modeRefs.current[index] = node; }}
              type="button"
              role="radio"
              aria-checked={mode === item.id}
              className={mode === item.id ? 'is-active' : ''}
              tabIndex={mode === item.id ? 0 : -1}
              disabled={generating}
              onClick={() => setMode(item.id)}
              onKeyDown={(event) => handleModeKeyDown(event, index)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          ref={generateButtonRef}
          className="gradient-btn caption-ideas-generate"
          type="button"
          disabled={generating || statusPending}
          onClick={handleGenerate}
        >
          {generating ? '아이디어 생성 중...' : generateLabel}
        </button>

        {user && remainingUses > 0 && (
          <p className="caption-ideas-balance" role="status">
            이번 묶음 <strong>{remainingUses}/5회</strong> 남음
          </p>
        )}
        {error && <p className="caption-ideas-error" role="alert">{error}</p>}
      </section>

      {ideas.length > 0 && (
        <section className="caption-ideas-results" aria-labelledby="caption-ideas-results-title">
          <div className="caption-ideas-results-heading">
            <div>
              <p className="workspace-kicker">RESULT</p>
              <h2 id="caption-ideas-results-title">추천 자막</h2>
            </div>
            <span>3개</span>
          </div>
          <ol>
            {ideas.map((idea, index) => (
              <li key={`${idea}-${index}`}>
                <span className="caption-ideas-number">{String(index + 1).padStart(2, '0')}</span>
                <strong>{idea}</strong>
                <button
                  type="button"
                  className="caption-ideas-copy"
                  title={`${index + 1}번 자막 복사`}
                  aria-label={`${index + 1}번 자막 복사`}
                  onClick={() => copyIdea(idea, index)}
                >
                  {copiedIndex === index ? '완료' : '복사'}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className={historyOpen ? 'caption-history-disclosure is-open' : 'caption-history-disclosure'}>
        <button
          id="caption-history-toggle"
          className="caption-history-toggle"
          type="button"
          aria-expanded={historyOpen}
          aria-controls="caption-history-panel"
          onClick={toggleHistory}
        >
          <span className="caption-history-toggle__copy">
            <span className="workspace-kicker">HISTORY</span>
            <strong>자막 아이디어 내역</strong>
            <span>이전에 만든 예능·상황·강조·감성 자막을 다시 확인합니다.</span>
          </span>
          <span className="caption-history-toggle__action">
            {historyOpen ? '접기' : '보기'}
            <span className="caption-history-toggle__chevron" aria-hidden="true" />
          </span>
        </button>

        {historyMounted && (
          <div
            id="caption-history-panel"
            className="caption-history-panel"
            role="region"
            aria-labelledby="caption-history-toggle"
            hidden={!historyOpen}
          >
            <CaptionIdeaHistory refreshKey={historyRefreshKey} />
          </div>
        )}
      </section>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>

      {confirmationOpen && (
        <div className="caption-ideas-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeConfirmation();
        }}>
          <section
            ref={confirmationDialogRef}
            className="caption-ideas-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="caption-ideas-confirm-title"
            aria-describedby="caption-ideas-confirm-description"
            tabIndex={-1}
          >
            <p className="workspace-kicker">START A PACK</p>
            <h2 id="caption-ideas-confirm-title">1분으로 생성 5회를 시작할까요?</h2>
            <p id="caption-ideas-confirm-description">
              첫 생성이 성공하면 변환 시간 1분이 차감되고, 이후 4회를 이어서 사용할 수 있습니다.
            </p>
            <div className="caption-ideas-dialog-actions">
              <button
                ref={confirmationCancelRef}
                className="button button--secondary"
                type="button"
                onClick={closeConfirmation}
              >
                취소
              </button>
              <button className="button button--primary" type="button" onClick={runGeneration}>
                1분 사용하고 시작
              </button>
            </div>
          </section>
        </div>
      )}

      <AuthModal
        isOpen={authOpen}
        onClose={() => setAuthOpen(false)}
        restoreFocusRef={generateButtonRef}
        returnPath="/caption-ideas"
      />
    </div>
  );
}
