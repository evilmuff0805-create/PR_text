import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { formatSegmentTime } from '../utils/format-segment-time.js';
import { isTranscriptionLogId, lastResultKey, readResultDraft, writeResultDraft } from '../utils/result-drafts.js';
import {
  buildSceneContext,
  createCaptionRequestTracker,
  isCaptionIdeaResult,
  CAPTION_IDEA_MODES,
} from '../utils/caption-ideas.js';

function splitTextLines(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/g, '')
    .split('\n');
}

// 줄 하나를 지우거나 더하면 그 뒤 자막이 전부 한 칸씩 밀려 타임코드와 어긋난다.
// 그래서 줄 수가 자막 수와 정확히 같을 때만 반영한다. 판정은 buildEditedSegments를
// 호출하는 쪽에서 하고, 여기서는 1:1로 맞는 입력만 받는다.
function canApplyFullText(segments, editedText) {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  return splitTextLines(editedText).length === segments.length;
}

function buildEditedSegments(segments, editedText) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const lines = splitTextLines(editedText);

  return segments.map((segment, index) => ({
    ...segment,
    text: lines[index] ?? segment.text ?? '',
  }));
}

function joinSegmentLines(segments) {
  return segments.map((segment) => segment.text).join('\n');
}

// 변환 기록 ID로만 편집본을 식별한다. 세그먼트 개수와 앞뒤 시간으로 식별하던 때는
// 같은 파일을 다시 올리면 값이 똑같아서, 새로 분석한 결과에 이전 편집본이 덮어씌워졌다.
// 새 변환은 항상 새 ID를 받으므로 겹칠 수 없다. ID가 없으면 복원하지 않는다.
function readStoredEdits(logId, segments, ownerId) {
  if (!logId) return null;
  return readResultDraft(sessionStorage, ownerId, logId, segments);
}

// ASS 기준 해상도(src/services/subtitle.js와 동일). 글자 크기는 이 좌표계의 픽셀이다.
const ASS_PLAY_RES_X = 1920;
const ASS_DEFAULT_FONT_SIZE = 48;
const SUBTITLE_MAX_CHARS = 28;

function buildSingleLinePreviewText(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '자막 미리보기 텍스트';
  if (normalized.length <= SUBTITLE_MAX_CHARS) return normalized;

  const candidate = normalized.slice(0, SUBTITLE_MAX_CHARS + 1);
  const wordBoundary = candidate.lastIndexOf(' ');
  return normalized.slice(0, wordBoundary > 0 ? wordBoundary : SUBTITLE_MAX_CHARS).trimEnd();
}
// 미리보기 박스는 1920px 폭을 축소해서 보여주므로 같은 비율로 글자도 줄인다.
const ASS_PREVIEW_WIDTH = 560;

const ASS_PRESETS = [
  {
    id: 'youtube',
    label: 'YouTube 기본',
    position: 'bottom',
    fontFamily: 'Pretendard',
    fontColor: '#FFFFFF',
    fontSize: 48,
  },
  {
    id: 'highlight',
    label: '강조형',
    position: 'bottom',
    fontFamily: 'Noto Sans KR',
    fontColor: '#FFFF00',
    fontSize: 58,
  },
  {
    id: 'caption',
    label: '상단 설명',
    position: 'top',
    fontFamily: 'Pretendard',
    fontColor: '#FFFFFF',
    fontSize: 44,
  },
  {
    id: 'interview',
    label: '중앙 인터뷰',
    position: 'middle',
    fontFamily: 'Nanum Gothic',
    fontColor: '#FFFFFF',
    fontSize: 54,
  },
];

const DOWNLOAD_FORMATS = [
  { id: 'srt', name: '표준 자막', detail: '타임코드 포함' },
  { id: 'txt', name: '전체 텍스트', detail: '편집 내용 반영' },
  { id: 'ass', name: '스타일 자막', detail: '위치·폰트·색상 설정' },
];

const EDITOR_MODES = [
  { id: 'text', label: '전체 텍스트' },
  { id: 'segments', label: '구간별 편집' },
];

const DEFAULT_SPEAKER_COLORS = ['#FFFFFF', '#39FF14', '#FFE600', '#00F5FF', '#FF6B35', '#FF4BCB'];

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

const SegmentEditorRow = memo(function SegmentEditorRow({
  copiedIdea,
  ideaError,
  ideaLoading,
  ideaMode,
  ideaResults,
  ideaScene,
  ideaResultPrevious,
  index,
  isIdeaOpen,
  onCopyIdea,
  onGenerateIdeas,
  onIdeaModeChange,
  onIdeaFocusSelection,
  onTextChange,
  onToggleIdea,
  segment,
  speakerColor,
}) {
  return (
    <article className="result-segment-row">
      <div className="result-segment-meta">
        <span className="result-segment-index">#{String(index + 1).padStart(2, '0')}</span>
        <span className="result-segment-time">
          {formatSegmentTime(segment.start)} - {formatSegmentTime(segment.end)}
        </span>
        {segment.speaker !== undefined && (
          <span className="result-segment-speaker" style={{ color: speakerColor }}>
            인물 {Number(segment.speaker) + 1}
          </span>
        )}
        <button
          aria-expanded={isIdeaOpen}
          className="result-segment-idea-toggle"
          onClick={() => onToggleIdea(index)}
          type="button"
        >
          자막 아이디어
        </button>
      </div>
      <textarea
        aria-label={`자막 구간 ${index + 1}`}
        onChange={(event) => onTextChange(index, event.target.value)}
        rows={2}
        value={segment.text}
      />
      {isIdeaOpen && (
        <div className="segment-idea-panel">
          <p className="segment-idea-panel__hint">
            앞뒤 대사를 참고해 이번 구간의 편집용 문구를 제안합니다. 원래 대사와 시간은 유지됩니다.
          </p>
          <details className="segment-idea-panel__context">
            <summary>생성에 사용할 문맥 확인</summary>
            <dl>
              <dt>앞 대사</dt><dd>{ideaScene.context.before.join('\n') || '앞 대사 없음'}</dd>
              <dt>이번 대사 · {formatSegmentTime(segment.start)} - {formatSegmentTime(segment.end)}</dt>
              <dd>{ideaScene.text || ideaScene.sourceText}</dd>
              <dt>뒤 대사</dt><dd>{ideaScene.context.after.join('\n') || '뒤 대사 없음'}</dd>
            </dl>
          </details>
          {(ideaScene.omittedBefore > 0 || ideaScene.omittedAfter > 0) && (
            <p className="caption-ideas-help" role="status">500자 한도로 앞 {ideaScene.omittedBefore}줄·뒤 {ideaScene.omittedAfter}줄을 제외했습니다. 문맥을 확인해 주세요.</p>
          )}
          {ideaScene.requiresSelection && (
            <div className="segment-idea-panel__selection">
              <label htmlFor={`idea-focus-${index}`}>아이디어에 쓸 부분을 아래 원문에서 드래그해 선택해 주세요.</label>
              <p className="caption-ideas-help" id={`idea-focus-help-${index}`}>이 대사는 500자를 넘습니다. 선택한 부분만 아이디어에 사용하며 원래 편집본은 그대로 둡니다.</p>
              <textarea id={`idea-focus-${index}`} aria-describedby={`idea-focus-help-${index}`} readOnly rows={5}
                value={ideaScene.sourceText} onSelect={(event) => {
                  const field = event.currentTarget;
                  if (field.selectionStart !== field.selectionEnd) onIdeaFocusSelection(field.value, field.selectionStart, field.selectionEnd);
                }} />
              <p className="caption-ideas-help" role="status">{ideaScene.valid ? `선택한 부분 ${Array.from(ideaScene.text).length}/500자` : '500자 이내의 부분을 선택하면 생성할 수 있습니다.'}</p>
            </div>
          )}
          <div className="segment-idea-panel__modes" role="radiogroup" aria-label="자막 유형">
            {CAPTION_IDEA_MODES.map((item) => (
              <button
                aria-checked={ideaMode === item.id}
                className={ideaMode === item.id ? 'is-active' : ''}
                key={item.id}
                onClick={() => onIdeaModeChange(item.id)}
                role="radio"
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="caption-ideas-help">{CAPTION_IDEA_MODES.find((item) => item.id === ideaMode)?.hint}</p>
          <button
            className="gradient-btn segment-idea-panel__run"
            disabled={ideaLoading || !ideaScene.valid}
            onClick={onGenerateIdeas}
            type="button"
          >
            {ideaLoading ? '만드는 중...' : ideaScene.requiresSelection ? '선택한 부분으로 3개 만들기' : '아이디어 3개 만들기'}
          </button>
          <p className="segment-idea-panel__cost">성공 5회당 변환 시간 1분이 차감됩니다</p>
          {ideaError && <p className="segment-idea-panel__error" role="alert">{ideaError}</p>}
          {ideaResultPrevious && <p className="caption-ideas-help">이전 입력·유형으로 만든 추천입니다. 새 후보가 필요하면 생성 버튼을 눌러 주세요.</p>}
          {ideaResults?.length > 0 && (
            <ul className="segment-idea-panel__results">
              {ideaResults.map((idea) => (
                <li key={idea}>
                  <span>{idea}</span>
                  <button onClick={() => onCopyIdea(idea)} type="button">
                    {copiedIdea === idea ? '복사됨' : '복사'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
});

export default function ResultPage() {
  const { state } = useLocation();
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [legacy, setLegacy] = useState(null);
  const [legacyError, setLegacyError] = useState('');
  const ownedState = state?.ownerId === user?.id ? state : null;
  const needsVerification = Boolean(user?.id && !state?.ownerId && isTranscriptionLogId(state?.transcriptionLogId));
  useEffect(() => {
    if (!needsVerification || !token) return;
    const controller = new AbortController(); setLegacy(null); setLegacyError('');
    fetch(`/api/auth/transcription/${state.transcriptionLogId}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('이전 변환 기록을 확인하지 못했습니다. 재다운로드에서 기록을 다시 선택해 주세요.'); return response.json(); })
      .then((log) => { if (!controller.signal.aborted) setLegacy({ ...log, text: joinSegmentLines(log.segments || []), transcriptionLogId: state.transcriptionLogId, ownerId: user.id }); })
      .catch((error) => { if (!controller.signal.aborted) setLegacyError(error.message); });
    return () => controller.abort();
  }, [needsVerification, state?.transcriptionLogId, token, user?.id]);
  if (needsVerification && legacy?.ownerId !== user.id) return <div className="result-workspace"><p role={legacyError ? 'alert' : 'status'}>{legacyError || '이전 변환 기록의 소유권과 최신 편집본을 확인하고 있습니다…'}</p>{legacyError && <button type="button" className="button button--secondary" onClick={() => navigate('/redownload')}>변환 기록 확인</button>}</div>;
  const resultState = ownedState || (legacy?.ownerId === user?.id ? legacy : null);
  return <ResultEditor key={`${user?.id || 'anonymous'}:${resultState?.transcriptionLogId || 'restore'}`} resultState={resultState} />;
}

export function ResultEditor({ resultOverride = null, resultState = null, onRegisterFlush = null, onReturn = null }) {
  const { state: routeState } = useLocation();
  const navigate = useNavigate();
  const { user, token } = useAuth();
  const state = resultOverride || resultState || (routeState?.ownerId === user?.id ? routeState : null);
  const resultStorageKey = lastResultKey(user?.id || 'anonymous');

  // location.state가 있으면 sessionStorage에 저장, 없으면 복원
  useEffect(() => {
    if (!user?.id || resultOverride) return;
    if (state) {
      try { sessionStorage.setItem(resultStorageKey, JSON.stringify({ ...state, ownerId: user.id })); } catch { /* Server history is still available. */ }
    } else {
      let saved;
      try { saved = sessionStorage.getItem(resultStorageKey); } catch { saved = null; }
      if (!saved) navigate('/transcribe');
    }
  }, [state, navigate, resultOverride, resultStorageKey, user?.id]);

  const resolved = useMemo(() => (
    state || (() => {
      try { const saved = JSON.parse(sessionStorage.getItem(resultStorageKey)); return saved?.ownerId === user?.id ? saved : null; } catch { return null; }
    })()
  ), [state, resultStorageKey, user?.id]);

  const {
    text = '',
    segments = [],
    language = '',
    diarize = false,
    transcriptionLogId = null,
    holdShortGaps = true,
  } = resolved || {};

  const [editedSegments, setEditedSegments] = useState(() => {
    const restored = readStoredEdits(transcriptionLogId, segments, user?.id);
    if (restored) return restored.segments;
    return buildEditedSegments(segments, text);
  });
  // 사용자가 입력한 원문 그대로. 줄 수가 맞지 않아 아직 반영하지 못한 상태도 담는다.
  const [fullTextDraft, setFullTextDraft] = useState(() => {
    const restored = readStoredEdits(transcriptionLogId, segments, user?.id);
    if (restored) return restored.fullTextDraft ?? joinSegmentLines(restored.segments);
    return joinSegmentLines(buildEditedSegments(segments, text));
  });
  const [editorMode, setEditorMode] = useState('text');
  const [downloading, setDownloading] = useState(false);

  const draftLineCount = splitTextLines(fullTextDraft).length;
  const lineCountMismatch = editedSegments.length > 0 && draftLineCount !== editedSegments.length;
  const editedSegmentsRef = useRef(editedSegments);
  const lineCountMismatchRef = useRef(lineCountMismatch);
  editedSegmentsRef.current = editedSegments;
  lineCountMismatchRef.current = lineCountMismatch;

  const selectEditorMode = useCallback((nextMode) => {
    if (nextMode !== editorMode && nextMode === 'text') {
      setFullTextDraft(joinSegmentLines(editedSegments));
    }
    setEditorMode(nextMode);
  }, [editedSegments, editorMode]);

  const handleEditorTabKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % EDITOR_MODES.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + EDITOR_MODES.length) % EDITOR_MODES.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = EDITOR_MODES.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextMode = EDITOR_MODES[nextIndex];
    selectEditorMode(nextMode.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`editor-tab-${nextMode.id}`)?.focus();
    });
  };

  const speakerIds = useMemo(() => (
    [...new Set(segments.filter(s => s.speaker !== undefined).map(s => s.speaker))]
      .sort((a, b) => a - b)
  ), [segments]);
  const [speakerColors, setSpeakerColors] = useState(() => {
    const init = {};
    speakerIds.forEach(id => { init[String(id)] = DEFAULT_SPEAKER_COLORS[id] ?? '#39FF14'; });
    const restored = readStoredEdits(transcriptionLogId, segments, user?.id);
    return restored?.speakerColors ? { ...init, ...restored.speakerColors } : init;
  });

  const [saveState, setSaveState] = useState('idle');
  const persistedTextRef = useRef(joinSegmentLines(segments));
  const saveRequestRef = useRef(null);

  // 사용자와 기록별로 초안을 분리한다. 묶음의 다른 파일이나 계정에 편집본이 섞이지 않는다.
  useEffect(() => {
    if (editedSegments.length === 0 || !transcriptionLogId) return;
    writeResultDraft(sessionStorage, user?.id, transcriptionLogId, { segments: editedSegments, fullTextDraft, speakerColors, baseText: persistedTextRef.current });
  }, [editedSegments, fullTextDraft, speakerColors, transcriptionLogId, user?.id, saveState]);

  // 편집본을 서버에도 보관한다. sessionStorage만으로는 창을 닫으면 사라지고,
  // 재다운로드가 다듬기 전 원본을 내려주는 문제가 남는다.
  const flushEdits = useCallback(async () => {
    if (!transcriptionLogId || !token || !user?.id) throw new Error('로그인 후 편집 저장 상태를 확인해 주세요.');
    while (true) {
      if (lineCountMismatchRef.current) throw new Error('편집한 줄 수가 자막 수와 다릅니다. 먼저 줄 수를 맞춰 주세요.');
      if (saveRequestRef.current) { await saveRequestRef.current; continue; }
      const snapshot = editedSegmentsRef.current;
      const nextText = joinSegmentLines(snapshot);
      if (nextText === persistedTextRef.current) return;
      const request = (async () => {
        setSaveState('saving');
        try {
          const res = await fetch(`/api/auth/transcription/${transcriptionLogId}/segments`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ segments: snapshot }),
          });
          if (!res.ok) throw new Error('편집 내용을 저장하지 못했습니다. 이 화면의 내용을 유지한 채 다시 시도해 주세요.');
          persistedTextRef.current = nextText; setSaveState('saved');
        } catch (error) { setSaveState('failed'); throw error; }
      })();
      saveRequestRef.current = request;
      try { await request; } finally { if (saveRequestRef.current === request) saveRequestRef.current = null; }
    }
  }, [transcriptionLogId, token, user?.id]);

  useEffect(() => {
    if (!transcriptionLogId || !token || !editedSegments.length) return;
    if (lineCountMismatch) return;
    const timer = setTimeout(() => { flushEdits().catch(() => {}); }, 1500);
    return () => clearTimeout(timer);
  }, [editedSegments, transcriptionLogId, token, lineCountMismatch, flushEdits]);

  useEffect(() => {
    onRegisterFlush?.(flushEdits);
    return () => onRegisterFlush?.(null);
  }, [flushEdits, onRegisterFlush]);

  // 아이디어 상태는 대사 편집·저장과 분리한다. 입력과 요청 키는 메모리에만 둔다.
  const [ideaIndex, setIdeaIndex] = useState(null);
  const [ideaMode, setIdeaMode] = useState('situation');
  const [ideaResults, setIdeaResults] = useState([]);
  const [ideaLoading, setIdeaLoading] = useState(false);
  const [ideaError, setIdeaError] = useState('');
  const [copiedIdea, setCopiedIdea] = useState('');
  const [ideaSelection, setIdeaSelection] = useState(null);
  const [ideaResultInfo, setIdeaResultInfo] = useState(null);
  const ideaRequestRef = useRef(null);
  if (!ideaRequestRef.current) ideaRequestRef.current = createCaptionRequestTracker();
  const sourceFocus = String(editedSegments[ideaIndex]?.text ?? '').trim();
  const selectedFocus = ideaSelection?.index === ideaIndex && ideaSelection.sourceText === sourceFocus
    ? ideaSelection.text : '';
  const ideaScene = useMemo(() => buildSceneContext(editedSegments, ideaIndex, selectedFocus),
    [editedSegments, ideaIndex, selectedFocus]);
  const ideaSnapshot = { ownerId: user?.id ?? null, logId: transcriptionLogId, focusIndex: ideaIndex,
    mode: ideaMode, text: ideaScene.text, context: ideaScene.context, sourceText: sourceFocus };
  const ideaSnapshotKey = ideaRequestRef.current.sync(ideaSnapshot);
  const ideaScopeKey = JSON.stringify([user?.id ?? null, transcriptionLogId]);
  const activeIdeaScopeRef = useRef(ideaScopeKey);
  activeIdeaScopeRef.current = ideaScopeKey;
  const visibleIdeaResults = ideaResultInfo?.scopeKey === ideaScopeKey ? ideaResults : [];

  useEffect(() => {
    setIdeaIndex(null); setIdeaSelection(null); setIdeaResults([]); setIdeaResultInfo(null);
    setIdeaLoading(false); setIdeaError(''); setCopiedIdea('');
  }, [user?.id, transcriptionLogId]);
  useEffect(() => () => ideaRequestRef.current.reset(), []);

  const openIdeaPanel = useCallback((index) => {
    ideaRequestRef.current.invalidate();
    setIdeaIndex((current) => (current === index ? null : index));
    setIdeaSelection(null); setIdeaResults([]); setIdeaResultInfo(null);
    setIdeaError(''); setCopiedIdea('');
  }, []);

  const changeIdeaMode = (nextMode) => {
    if (nextMode !== ideaMode) ideaRequestRef.current.invalidate();
    setIdeaMode(nextMode);
  };

  const selectIdeaFocus = (sourceText, start, end) => {
    if (sourceText !== sourceFocus || !Number.isInteger(start) || !Number.isInteger(end)) return;
    // 브라우저의 UTF16 선택 경계가 이모지 한 글자를 반으로 나누지 않게 한다.
    let first = Math.max(0, start), last = Math.min(sourceText.length, end);
    if (first > 0 && /[\uDC00-\uDFFF]/.test(sourceText[first]) && /[\uD800-\uDBFF]/.test(sourceText[first - 1])) first -= 1;
    if (last < sourceText.length && /[\uDC00-\uDFFF]/.test(sourceText[last]) && /[\uD800-\uDBFF]/.test(sourceText[last - 1])) last += 1;
    const text = sourceText.slice(first, last).trim();
    if (ideaSelection?.index === ideaIndex && ideaSelection.sourceText === sourceText && ideaSelection.text === text) return;
    ideaRequestRef.current.invalidate();
    setIdeaSelection({ index: ideaIndex, sourceText, text });
  };

  async function generateIdeas() {
    if (!user?.id || !ideaScene.valid) {
      setIdeaError(ideaScene.requiresSelection ? '원문에서 아이디어에 쓸 부분을 500자 이내로 선택해 주세요.' : '이 구간에는 내용이 없습니다.');
      return;
    }
    const latestSnapshot = () => {
      const scene = buildSceneContext(editedSegmentsRef.current, ideaIndex, selectedFocus);
      return { ...ideaSnapshot, text: scene.text, context: scene.context, sourceText: scene.sourceText };
    };
    if (JSON.stringify(latestSnapshot()) !== ideaSnapshotKey) return;
    const ticket = ideaRequestRef.current.begin(ideaSnapshot);
    if (!ticket) return;
    setIdeaLoading(true); setIdeaError('');
    try {
      const res = await fetch('/api/caption-ideas/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ requestId: ticket.requestId, mode: ideaMode, text: ideaScene.text, context: ideaScene.context }),
      });
      const data = await res.json().catch(() => ({}));
      if (!ideaRequestRef.current.isCurrent(ticket) || JSON.stringify(latestSnapshot()) !== ticket.key) return;
      if (!res.ok) {
        const error = new Error(res.status === 404
          ? '문맥을 활용하는 자막 아이디어를 준비 중입니다. 입력을 유지한 채 업데이트 후 다시 시도해 주세요.'
          : data.error || '자막 아이디어를 만들지 못했습니다.');
        error.status = res.status; error.code = data.code;
        throw error;
      }
      if (!isCaptionIdeaResult(data)) throw new Error('생성 결과를 확인하지 못했습니다. 같은 입력으로 다시 시도해 주세요.');
      ideaRequestRef.current.complete(ticket);
      setIdeaResults(data.ideas);
      setIdeaResultInfo({ scopeKey: ideaScopeKey, snapshotKey: ticket.key });
    } catch (error) {
      if (!ideaRequestRef.current.isCurrent(ticket) || JSON.stringify(latestSnapshot()) !== ticket.key) return;
      if (error.status === 409) ideaRequestRef.current.complete(ticket);
      setIdeaError(error.status ? error.message : '생성 결과를 확인하지 못했습니다. 같은 입력으로 다시 시도하면 완료된 요청을 확인합니다.');
    } finally {
      if (ideaRequestRef.current.finish(ticket)) setIdeaLoading(false);
    }
  }

  const copyIdea = useCallback(async (idea) => {
    const scopeKey = ideaResultInfo?.scopeKey;
    if (scopeKey !== activeIdeaScopeRef.current) return;
    try {
      await navigator.clipboard.writeText(idea);
      if (scopeKey === activeIdeaScopeRef.current) setCopiedIdea(idea);
    } catch {
      if (scopeKey === activeIdeaScopeRef.current) setIdeaError('복사하지 못했습니다. 직접 선택해 복사해주세요.');
    }
  }, [ideaResultInfo]);

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
  const [assFontSize, setAssFontSize] = useState(ASS_DEFAULT_FONT_SIZE);

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
  const previewText = buildSingleLinePreviewText(editedSegments[0]?.text);

  // 미리보기에서 자막 위치 계산
  function getPreviewAlign() {
    if (assPosition === 'top') return 'flex-start';
    if (assPosition === 'middle') return 'center';
    return 'flex-end';
  }

  const updateSegmentText = useCallback((index, nextText) => {
    const next = editedSegmentsRef.current.map((segment, segmentIndex) => (
      segmentIndex === index ? { ...segment, text: nextText } : segment
    ));
    editedSegmentsRef.current = next;
    setEditedSegments(next);
    if (lineCountMismatchRef.current) {
      setFullTextDraft(joinSegmentLines(next));
      lineCountMismatchRef.current = false;
    }
  }, []);

  function updateFullText(nextText) {
    setFullTextDraft(nextText);
    // 줄 수가 맞을 때만 자막에 반영한다. 어긋난 상태는 경고로 알리고 보류한다.
    if (canApplyFullText(editedSegments, nextText)) {
      setEditedSegments(buildEditedSegments(editedSegments, nextText));
    }
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
    // 버튼은 비활성화돼 있지만, 어긋난 상태로는 어떤 경로로도 파일이 나가지 않게 막는다.
    if (lineCountMismatch) return;
    setDownloading(true);
    try {
      const body = { segments: editedSegments, format, holdShortGaps: holdShortGaps !== false };
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

  const resultDuration = useMemo(() => formatResultDuration(segments), [segments]);
  const hasSpeakers = speakerIds.length > 0;

  if (!resolved || !user) return null;

  const languageLabel = LANGUAGE_LABELS[String(language).toLowerCase()] || language || '알 수 없음';

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
          onClick={onReturn || (() => navigate('/transcribe'))}
          type="button"
        >
          {onReturn ? '묶음으로 돌아가기' : '새 파일 변환'}
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
            <div className="result-panel-heading__status">
              {saveState !== 'idle' && (
                <span className={`result-save-state result-save-state--${saveState}`} role="status">
                  {saveState === 'saving' && '저장 중...'}
                  {saveState === 'saved' && '저장됨 · 재다운로드 반영'}
                  {saveState === 'failed' && (resultOverride ? '저장 실패 · ZIP 전에 다시 저장해 주세요' : '저장 실패 · 이 창에서는 다운로드 가능')}
                </span>
              )}
              <span>{editedSegments.length}개 구간</span>
            </div>
          </div>

          <div className="result-editor-tabs" aria-label="자막 편집 방식" role="tablist">
            {EDITOR_MODES.map((mode, index) => (
              <button
                aria-controls={`editor-panel-${mode.id}`}
                aria-selected={editorMode === mode.id}
                className={editorMode === mode.id ? 'is-active' : ''}
                id={`editor-tab-${mode.id}`}
                key={mode.id}
                onClick={() => selectEditorMode(mode.id)}
                onKeyDown={(event) => handleEditorTabKeyDown(event, index)}
                role="tab"
                tabIndex={editorMode === mode.id ? 0 : -1}
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
              {/* 자막 아이디어 버튼은 구간별 편집에만 있다. 여기서 찾지 못하고 지나치기 쉬워 안내한다. */}
              <p className="result-editor-tip">
                구간마다 어울리는 자막 문구를 제안받으려면
                <button className="result-editor-tip__link" onClick={() => selectEditorMode('segments')} type="button">
                  구간별 편집
                </button>
                으로 넘어가세요. 장면을 다시 입력할 필요 없이 앞뒤 대사를 문맥으로 넘겨 후보를 만듭니다.
              </p>
              <label className="sr-only" htmlFor="full-transcript">전체 변환 텍스트</label>
              <textarea
                aria-describedby={lineCountMismatch ? 'full-transcript-warning' : undefined}
                aria-invalid={lineCountMismatch || undefined}
                id="full-transcript"
                onChange={(event) => updateFullText(event.target.value)}
                value={fullTextDraft}
              />
              {lineCountMismatch && (
                <p className="result-edit-warning" id="full-transcript-warning" role="alert">
                  줄 수가 자막 수와 다릅니다 (현재 {draftLineCount}줄 / 자막 {editedSegments.length}개).
                  줄을 추가하거나 지우면 뒤쪽 자막이 전부 밀려 타임코드가 어긋나기 때문에,
                  줄 수를 맞추기 전까지 편집 내용을 반영하지 않고 다운로드도 막아둡니다.
                  한 줄이 곧 자막 하나입니다.
                </p>
              )}
            </div>
          ) : (
            <div
              aria-labelledby="editor-tab-segments"
              className="result-segment-list"
              id="editor-panel-segments"
              role="tabpanel"
            >
              {editedSegments.map((segment, index) => {
                const isIdeaOpen = ideaIndex === index;
                return (
                  <SegmentEditorRow
                    copiedIdea={isIdeaOpen ? copiedIdea : null}
                    ideaError={isIdeaOpen ? ideaError : null}
                    ideaLoading={isIdeaOpen ? ideaLoading : false}
                    ideaMode={isIdeaOpen ? ideaMode : null}
                    ideaResults={isIdeaOpen ? visibleIdeaResults : null}
                    ideaScene={isIdeaOpen ? ideaScene : null}
                    ideaResultPrevious={isIdeaOpen && visibleIdeaResults.length > 0 && ideaResultInfo?.snapshotKey !== ideaSnapshotKey}
                    index={index}
                    isIdeaOpen={isIdeaOpen}
                    key={`${segment.start}-${segment.end}-${index}`}
                    onCopyIdea={isIdeaOpen ? copyIdea : null}
                    onGenerateIdeas={isIdeaOpen ? generateIdeas : null}
                    onIdeaModeChange={isIdeaOpen ? changeIdeaMode : null}
                    onIdeaFocusSelection={isIdeaOpen ? selectIdeaFocus : null}
                    onTextChange={updateSegmentText}
                    onToggleIdea={openIdeaPanel}
                    segment={segment}
                    speakerColor={speakerColors[String(segment.speaker)] || 'var(--text-secondary)'}
                  />
                );
              })}
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
                  disabled={downloading || lineCountMismatch}
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

            <p className="result-tool-note">SRT에는 첫 0~2초 시작 안내 자막이 포함됩니다. 글자 크기는 편집 프로그램에 따라 달라질 수 있습니다.</p>
            <p className="result-tool-note">SRT는 밀리초 타임코드로 저장됩니다. 프리미어 시퀀스의 프레임레이트를 원본 영상과 맞춰 주세요.</p>
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
                fontSize: `${Math.max(assFontSize * (ASS_PREVIEW_WIDTH / ASS_PLAY_RES_X), 9).toFixed(1)}px`,
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
                  max="96"
                  min="24"
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
