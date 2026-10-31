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
import { cacheSavedResult, isTranscriptionLogId, lastResultKey, readResultDraft, resolveSavedResult, resultSnapshotSignature, writeResultDraft } from '../utils/result-drafts.js';
import { confirmSubtitleCandidate, confirmSubtitleTiming, editSubtitleText, findRememberedSubtitle, formatSubtitleTimeInput, getBoundFixedCuePlan, getBoundLocalExclusion, getSubtitleCorrectionStatus, getSubtitleReviewIssues, getSubtitleTimingCandidate, getSubtitleTimingConfirmation, isLocallyExcluded, normalizeReviewMemory, normalizeSubtitleReview, parseSubtitleTimeInput, rememberSubtitleCandidate, restoreFixedCuePlan, setSubtitleExclusion, subtitleEditSignature, subtitleReviewIssueLabel, validateSubtitleCandidate, validateSubtitleTiming } from '../utils/subtitle-review.js';
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

  return segments.map((segment, index) => editSubtitleText(segment, lines[index] ?? segment.text ?? ''));
}

function joinSegmentLines(segments) {
  return segments.map((segment) => segment.text).join('\n');
}

function hasIncludedDialogue(segments, exclusionEnabled) {
  return segments.some((segment) => segment.text?.replace(/\./g, '').trim() && segment.end > segment.start
    && (!exclusionEnabled || !isLocallyExcluded(segment)));
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
  originalText,
  pendingReview,
  rememberedReview,
  reviewError,
  reviewApplyDisabled,
  audioAvailable,
  reviewSession,
  onReviewChange,
  onApplyReview,
  onConfirmCurrentReview,
  onUseRememberedReview,
  onPlayReviewRange,
  timingEnabled,
  displayHoldEnabled,
  pendingTiming,
  timingError,
  onTimingChange,
  onUseTimingCandidate,
  onConfirmTiming,
  exclusionEnabled,
  onSetExclusion,
  onRestoreCueCorrection,
}) {
  const review = normalizeSubtitleReview(segment.subtitleReview, segment.text);
  const issues = getSubtitleReviewIssues(segment);
  const fixedCuePlan = timingEnabled ? getBoundFixedCuePlan(segment) : undefined;
  const correctionStatus = timingEnabled ? getSubtitleCorrectionStatus(segment) : undefined;
  const candidate = pendingReview?.base === segment ? pendingReview.value
    : review?.correctionStatus === 'held' && correctionStatus !== 'held' ? '' : review?.candidateText ?? '';
  const remember = pendingReview?.base === segment && pendingReview.remember === true;
  const duration = Number.isFinite(segment.start) && Number.isFinite(segment.end) ? segment.end - segment.start : NaN;
  const timingCandidate = getSubtitleTimingCandidate(segment);
  const timingConfirmation = getSubtitleTimingConfirmation(segment);
  const timingStart = pendingTiming?.base === segment ? pendingTiming.startInput : formatSubtitleTimeInput(segment.start, { isStart: true });
  const timingEnd = pendingTiming?.base === segment ? pendingTiming.endInput : formatSubtitleTimeInput(segment.end);
  const localExclusion = exclusionEnabled ? review?.localExclusion : undefined;
  const boundExclusion = exclusionEnabled ? getBoundLocalExclusion(segment) : undefined;
  const excluded = exclusionEnabled && isLocallyExcluded(segment);
  return (
    <article className={`result-segment-row${excluded ? ' result-segment-row--excluded' : ''}`} id={`subtitle-segment-${index}`}>
      <div className="result-segment-meta">
        <span className="result-segment-index">#{String(index + 1).padStart(2, '0')}</span>
        <span className="result-segment-time">
          {formatSegmentTime(segment.start)} - {formatSegmentTime(segment.end)}
        </span>
        {excluded && <span className="subtitle-review__exclusion-label">{boundExclusion.status === 'automatic' ? '무음 근거로 자동 제외' : '사용자가 제외'}</span>}
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
      <details className="subtitle-review">
        <summary>문구·시간 검토{issues.length > 0 ? ` · ${issues.length}개 표시` : ''}</summary>
        <div className="subtitle-review__body">
          <p className="subtitle-review__status">{review?.textStatus === 'confirmed' ? '문구 확인됨 · 발화 싱크 미확인' : '문구·발화 싱크 미확인'}</p>
          <p>{formatSegmentTime(segment.start)} - {formatSegmentTime(segment.end)} · {Number.isFinite(duration) && duration > 0 ? `${duration.toFixed(3)}초` : '시간 확인 필요'} · {Array.from(segment.text || '').length}자</p>
          {issues.length > 0 && <ul>{issues.map((issue, issueIndex) => <li key={`${issue.code}-${issueIndex}`}>{subtitleReviewIssueLabel(issue)}</li>)}</ul>}
          <p className="subtitle-review__hint">표시는 원본 확인을 돕는 기준입니다. 짧은 구간만으로 인식 오류나 실제 발화 시간을 단정하지 않습니다.</p>
          <button type="button" className="button button--secondary" disabled={!audioAvailable} onClick={() => onPlayReviewRange(index, segment, reviewSession)}>앞뒤 포함 듣기</button>
          {correctionStatus && <section className="subtitle-review__memory" aria-label="문구 교정 처리 내역">
            <p className="subtitle-review__status" role="status">{correctionStatus === 'cue_applied'
              ? '기존 큐 시간을 유지해 교정 문구 반영 · 단어별 싱크 미확인'
              : correctionStatus === 'restored' ? '교정 전 문구로 복원됨 · 기존 큐 시간 유지 · 단어별 싱크 미확인'
                : '교정 후보 보류 · 현재 문구와 시간 유지'}</p>
            <p className="subtitle-review__hint">{correctionStatus === 'held'
              ? '후보를 자동 반영하지 않았습니다. 원음을 확인한 뒤 필요한 문구만 직접 적용해 주세요.'
              : '문구의 큐 경계만 보존한 결과이며 새 단어 정렬이나 수동 싱크 확인을 뜻하지 않습니다.'}</p>
            {correctionStatus === 'cue_applied' && fixedCuePlan?.original && <button id={`review-correction-restore-${index}`} type="button" className="button button--secondary" disabled={reviewApplyDisabled}
              onClick={() => onRestoreCueCorrection(index, segment, reviewSession)}>교정 전 문구 복원</button>}
          </section>}
          {review?.correctionStatus && !correctionStatus && <p className="subtitle-review__hint">문구나 시간이 달라 이전 자동 교정 판단은 적용하지 않습니다.</p>}
          {exclusionEnabled && <section className="subtitle-review__exclusion" aria-labelledby={`review-exclusion-title-${index}`}>
            <h3 id={`review-exclusion-title-${index}`}>내보내기 포함 여부</h3>
            <p className="subtitle-review__status" role="status">{excluded
              ? (boundExclusion.status === 'automatic' ? '확인된 무음과 인식 위험 근거로 자동 제외됨' : '사용자 선택으로 제외됨')
              : localExclusion && !boundExclusion ? '문구·시간 변경으로 이전 제외는 적용하지 않음 · 현재 자막 포함'
                : boundExclusion?.status === 'restored' ? '복원됨 · 현재 자막 포함' : '현재 자막 포함'}</p>
            {boundExclusion?.groupId && <p>같은 문구의 반복 검토 묶음 · 처리 당시 {boundExclusion.occurrences || 1}곳. 실제로 반복한 대사인지 원음을 확인해 주세요.</p>}
            {boundExclusion?.status === 'review' && <p className="subtitle-review__hint">{boundExclusion.audioStatus === 'signal_present'
              ? '음향 신호가 있어 무음으로 제외하지 않았습니다. 반복만으로 잘못된 자막이라고 판단하지 않습니다.'
              : '무음 여부가 확인되지 않아 대사를 유지했습니다. 원음을 듣고 확인해 주세요.'}</p>}
            {localExclusion && <p className="subtitle-review__hint">판단 당시 문구: {localExclusion.binding.text}<br />판단 당시 범위: {formatSegmentTime(localExclusion.binding.start)} - {formatSegmentTime(localExclusion.binding.end)}</p>}
            <p className="subtitle-review__hint">원음을 확인한 뒤 잘못된 자막만 제외하세요. 문구와 시간은 보존하며 SRT·ASS·TXT에서만 빠집니다. 문구나 시간을 바꾸면 이전 제외는 해제됩니다.</p>
            <button id={`review-exclusion-action-${index}`} type="button" className="button button--secondary" disabled={reviewApplyDisabled}
              onClick={() => onSetExclusion(index, segment, !excluded, reviewSession)}>{excluded ? '이 구간 복원' : '이 구간 제외'}</button>
          </section>}
          {timingEnabled && <section className="subtitle-review__timing" aria-labelledby={`review-timing-${index}`}>
            <h3 id={`review-timing-${index}`}>발화 시간 검토</h3>
            <p className="subtitle-review__status">{timingConfirmation ? '시간 수동 확인 · 음소·내부 단어 싱크 미확인' : '발화 시간 미확인'}</p>
            <dl className="subtitle-review__comparison">
              {review?.originalTiming && <div><dt>보존 발화 범위</dt><dd>{formatSegmentTime(review.originalTiming.start)} - {formatSegmentTime(review.originalTiming.end)}</dd></div>}
              <div><dt>현재 발화 범위</dt><dd>{formatSegmentTime(segment.start)} - {formatSegmentTime(segment.end)}</dd></div>
            </dl>
            {displayHoldEnabled && <p className="subtitle-review__hint">발화 끝과 표시 끝은 다를 수 있습니다. 일반 단일 SRT·ASS는 발화 뒤 간격이 1초 이내면 다음 자막까지 표시합니다. 마지막 자막과 1초 초과 간격은 늘리지 않습니다.</p>}
            {timingCandidate && <div className="subtitle-review__timing-candidate">
              <p className="subtitle-review__status">오디오 재측정 시간 후보 · {timingCandidate.status === 'consistent_estimate' ? '반복 측정 추정' : '미확인'}</p>
              <p>후보 발화 시작 {formatSegmentTime(timingCandidate.start)} · 발화 끝 {formatSegmentTime(timingCandidate.end)}</p>
              <p className="subtitle-review__hint">현재 문구와 원래 범위가 일치하는 후보입니다. 실제 음소 경계의 정답은 아닙니다. 불러오기만으로 현재 시간은 바뀌지 않습니다.</p>
              <button type="button" className="button button--secondary" onClick={() => onUseTimingCandidate(index, segment, reviewSession)}>시간 후보 불러오기</button>
            </div>}
            <div className="subtitle-review__time-inputs">
              <label htmlFor={`review-start-${index}`}><span>발화 시작</span><input id={`review-start-${index}`} type="text" inputMode="decimal" autoComplete="off" aria-describedby={`review-timing-help-${index}`} value={timingStart}
                onChange={(event) => onTimingChange(index, segment, { startInput: event.target.value }, reviewSession)} /></label>
              <label htmlFor={`review-end-${index}`}><span>발화 끝</span><input id={`review-end-${index}`} type="text" inputMode="decimal" autoComplete="off" aria-describedby={`review-timing-help-${index}`} value={timingEnd}
                onChange={(event) => onTimingChange(index, segment, { endInput: event.target.value }, reviewSession)} /></label>
            </div>
            <p id={`review-timing-help-${index}`} className="subtitle-review__hint">초(예: 338.125) 또는 HH:MM:SS.mmm로 입력합니다. 원본을 직접 듣고 시작·끝을 확인한 뒤 적용하세요. {fixedCuePlan ? '내부 자막은 보존된 큐 경계를 사용하며, 단어별 재정렬을 뜻하지 않습니다.' : '긴 문구의 내부 분할 시간은 이 범위 안의 글자 수 비례 추정이며, 단어별 재정렬은 보장하지 않습니다.'}</p>
            {!audioAvailable && <p className="subtitle-review__hint">시간을 적용하려면 위에서 이 파일의 원본을 연결해 재생 길이를 확인해 주세요.</p>}
            <button type="button" className="button button--secondary" disabled={!audioAvailable}
              onClick={() => onPlayReviewRange(index, segment, reviewSession, { start: parseSubtitleTimeInput(timingStart), end: parseSubtitleTimeInput(timingEnd) })}>입력 범위 앞뒤 듣기</button>
            <button type="button" className="button button--secondary" disabled={reviewApplyDisabled || !audioAvailable}
              onClick={() => onConfirmTiming(index, segment, timingStart, timingEnd, reviewSession)}>이 시간 적용·확인</button>
            {timingError && <p className="subtitle-review__error" role="alert">{timingError}</p>}
          </section>}
          <dl className="subtitle-review__comparison">
            <div><dt>보존 문구</dt><dd>{fixedCuePlan?.original?.text ?? review?.originalText ?? originalText ?? segment.text}</dd></div>
            <div><dt>현재 편집 문구</dt><dd>{segment.text}</dd></div>
          </dl>
          {rememberedReview && <div className="subtitle-review__memory">
            <p>이 창의 현재 파일에서 기억한 후보입니다. 다른 구간의 정답으로 보장하지 않습니다.</p>
            <p>기억한 원문: {rememberedReview.originalText}</p>
            <p>기억한 후보: {rememberedReview.candidateText}</p>
            <button type="button" className="button button--secondary" onClick={() => onUseRememberedReview(index, segment, rememberedReview, reviewSession)}>기억한 후보 불러오기</button>
          </div>}
          <label htmlFor={`review-candidate-${index}`}>정정 후보 · 적용 전까지 현재 문구와 분리됩니다</label>
          <textarea id={`review-candidate-${index}`} value={candidate} rows={2} maxLength={10000}
            onChange={(event) => onReviewChange(index, segment, { value: event.target.value }, reviewSession)} />
          <label className="subtitle-review__remember"><input type="checkbox" checked={remember}
            onChange={(event) => onReviewChange(index, segment, { remember: event.target.checked }, reviewSession)} />이 창의 현재 파일에만 후보 기억</label>
          <p className="subtitle-review__hint">후보는 권장 정답이 아닙니다. 숫자·말투·반복을 원본과 확인한 뒤 적용하세요. 문구를 바꿔도 자막 시간은 그대로이며, 발화 싱크는 따로 확인해야 합니다.</p>
          <p className="subtitle-review__hint">긴 문구는 내보내기에서 28자 이내로 나뉩니다. 수동 정정 후의 단어별 시간 정렬은 보장하지 않습니다.</p>
          {reviewApplyDisabled && <p>전체 편집의 줄 수를 먼저 맞춰 주세요. 입력 중인 내용은 유지됩니다.</p>}
          <div className="subtitle-review__actions">
            <button type="button" className="button button--secondary" disabled={reviewApplyDisabled} onClick={() => onConfirmCurrentReview(index, segment, reviewSession)}>현재 문구만 확인</button>
            <button type="button" className="button button--primary" disabled={reviewApplyDisabled || !candidate.trim()}
              onClick={() => onApplyReview(index, segment, candidate, remember, reviewSession)}>이 문구 적용·확인</button>
          </div>
          {reviewError && <p className="subtitle-review__error" role="alert">{reviewError}</p>}
        </div>
      </details>
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
  const restoredLogId = !resultState ? resolveSavedResult(sessionStorage, user?.id, null)?.transcriptionLogId : null;
  return <ResultEditor key={`${user?.id || 'anonymous'}:${resultState?.transcriptionLogId || restoredLogId || 'restore'}`} resultState={resultState} serverVerified={Boolean(!ownedState && legacy?.ownerId === user?.id)} />;
}

export function ResultEditor({ resultOverride = null, resultState = null, serverVerified = false, onRegisterFlush = null, onReturn = null }) {
  const { state: routeState, pathname = '/result', search = '', hash = '' } = useLocation();
  const navigate = useNavigate();
  const { user, token } = useAuth();
  const incomingState = resultOverride || resultState || (routeState?.ownerId === user?.id ? routeState : null);
  const state = useMemo(() => resultOverride || resolveSavedResult(sessionStorage, user?.id, incomingState, serverVerified),
    [resultOverride, incomingState, serverVerified, user?.id]);
  const resultStorageKey = lastResultKey(user?.id || 'anonymous');

  // location.state가 있으면 sessionStorage에 저장, 없으면 복원
  useEffect(() => {
    if (!user?.id || resultOverride) return;
    if (state) {
      try { const current = resolveSavedResult(sessionStorage, user.id, state, serverVerified); sessionStorage.setItem(resultStorageKey, JSON.stringify({ ...current, ownerId: user.id })); } catch { /* Server history is still available. */ }
    } else {
      let saved;
      try { saved = sessionStorage.getItem(resultStorageKey); } catch { saved = null; }
      if (!saved) navigate('/transcribe');
    }
  }, [state, navigate, resultOverride, resultStorageKey, user?.id, serverVerified]);

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
    grammarPolish = null,
  } = resolved || {};
  const polishRows = Array.isArray(segments) ? segments.filter((segment) => segment.grammarPolish) : [];
  const grammarPolishSummary = grammarPolish || (polishRows.length ? {
    applied: polishRows.filter((segment) => segment.grammarPolish.status === 'applied').length,
    unavailable: polishRows.some((segment) => ['timeout', 'api_error', 'invalid_response', 'timeline_fallback', 'verifier_unavailable', 'meaning_or_timing_rejected', 'unsafe_candidate'].includes(segment.grammarPolish.status)),
    limited: polishRows.some((segment) => segment.grammarPolish.status === 'limit'),
  } : null);
  const grammarPolishStatusCounts = grammarPolishSummary?.summary?.statuses || {};
  const resultSourceRef = useRef(null);
  resultSourceRef.current = { ownerId: user?.id, logId: transcriptionLogId, resolved, resultOverride, path: `${pathname}${search}${hash}` };

  const [editedSegments, setEditedSegments] = useState(() => {
    const restored = readStoredEdits(transcriptionLogId, segments, user?.id);
    if (restored) return restored.segments;
    return buildEditedSegments(segments, text);
  });
  const remainingPolishedOriginals = editedSegments.filter((segment) => (
    segment.grammarPolish?.status === 'applied' && typeof segment.grammarPolish.originalText === 'string'
  )).length;
  const sourceAppliedPolishCount = polishRows.filter((segment) => segment.grammarPolish.status === 'applied').length
    || grammarPolishSummary?.applied || 0;
  const restoredPolishCount = Math.max(0, sourceAppliedPolishCount - remainingPolishedOriginals);
  const polishRestored = restoredPolishCount > 0 && remainingPolishedOriginals === 0;
  // 사용자가 입력한 원문 그대로. 줄 수가 맞지 않아 아직 반영하지 못한 상태도 담는다.
  const [fullTextDraft, setFullTextDraft] = useState(() => {
    const restored = readStoredEdits(transcriptionLogId, segments, user?.id);
    if (restored) return restored.fullTextDraft !== undefined && !canApplyFullText(restored.segments, restored.fullTextDraft)
      ? restored.fullTextDraft : joinSegmentLines(restored.segments);
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
      if (!lineCountMismatchRef.current) setFullTextDraft(joinSegmentLines(editedSegments));
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
  const timingEnabled = !diarize && segments.every((segment) => segment.speaker === undefined || segment.speaker === null || segment.speaker === '');
  const exclusionEnabled = timingEnabled;
  const localExclusionSummary = useMemo(() => {
    const summary = { automatic: 0, user: 0, restored: 0, review: 0, groups: [] };
    if (!exclusionEnabled) return summary;
    const groups = new Map();
    editedSegments.forEach((segment, index) => {
      const value = getBoundLocalExclusion(segment);
      if (!value) return;
      summary[value.status] += 1;
      if (value.groupId) {
        if (!groups.has(value.groupId)) groups.set(value.groupId, { id: value.groupId, text: segment.text, members: [] });
        groups.get(value.groupId).members.push({ index, start: segment.start, end: segment.end });
      }
    });
    summary.groups = [...groups.values()];
    return summary;
  }, [editedSegments, exclusionEnabled]);
  const hasIncludedSubtitles = hasIncludedDialogue(editedSegments, exclusionEnabled);
  const [speakerColors, setSpeakerColors] = useState(() => {
    const init = {};
    speakerIds.forEach(id => { init[String(id)] = DEFAULT_SPEAKER_COLORS[id] ?? '#39FF14'; });
    const restored = readStoredEdits(transcriptionLogId, segments, user?.id);
    return restored?.speakerColors ? { ...init, ...restored.speakerColors } : init;
  });

  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState('');
  const persistedTextRef = useRef(joinSegmentLines(segments));
  const persistedEditSignatureRef = useRef(subtitleEditSignature(segments));
  const saveRequestRef = useRef(null);

  const reviewScope = `${user?.id || 'anonymous'}:${transcriptionLogId || 'unsaved'}`;
  const reviewScopeRef = useRef(reviewScope);
  reviewScopeRef.current = reviewScope;
  const reviewSession = useMemo(() => ({ scope: reviewScope }), [reviewScope]);
  const reviewSessionRef = useRef(reviewSession);
  reviewSessionRef.current = reviewSession;
  const reviewMountedRef = useRef(true);
  useEffect(() => { reviewMountedRef.current = true; return () => { reviewMountedRef.current = false; }; }, []);
  const [pendingReviews, setPendingReviews] = useState({});
  const pendingReviewsRef = useRef({});
  const [reviewError, setReviewError] = useState(null);
  const [pendingTimings, setPendingTimings] = useState({});
  const pendingTimingsRef = useRef({});
  const [timingError, setTimingError] = useState(null);
  const [reviewMemoryState, setReviewMemoryState] = useState(() => ({ scope: reviewScope,
    items: normalizeReviewMemory(readStoredEdits(transcriptionLogId, segments, user?.id)?.reviewMemory) }));
  const reviewMemory = reviewMemoryState.scope === reviewScope ? reviewMemoryState.items : [];
  const reviewMemoryRef = useRef(reviewMemory);
  reviewMemoryRef.current = reviewMemory;
  const [sourceAudio, setSourceAudio] = useState(null);
  const [sourceAudioError, setSourceAudioError] = useState('');
  const sourceAudioRef = useRef(null);
  const sourceAudioElementRef = useRef(null);
  const sourceLastElementRef = useRef(null);
  const sourceRangeRef = useRef(null);
  const sourceStopTimerRef = useRef(null);
  const playRequestRef = useRef(0);
  const visibleSourceAudio = sourceAudio?.scope === reviewScope ? sourceAudio : null;
  const stopRangeTimer = useCallback(() => {
    if (sourceStopTimerRef.current !== null) window.clearInterval(sourceStopTimerRef.current);
    sourceStopTimerRef.current = null;
    sourceRangeRef.current = null;
  }, []);
  const releaseSourceAudio = useCallback(() => {
    playRequestRef.current += 1;
    stopRangeTimer();
    const media = sourceAudioElementRef.current || sourceLastElementRef.current;
    sourceLastElementRef.current = null;
    media?.pause();
    media?.removeAttribute('src');
    media?.load();
    if (sourceAudioRef.current?.url) URL.revokeObjectURL(sourceAudioRef.current.url);
    sourceAudioRef.current = null;
    setSourceAudio(null);
    setSourceAudioError('');
  }, [stopRangeTimer]);
  useEffect(() => () => releaseSourceAudio(), [reviewScope, releaseSourceAudio]);
  const connectSourceAudio = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !reviewMountedRef.current) return;
    releaseSourceAudio();
    try {
      const next = { scope: reviewScopeRef.current, url: URL.createObjectURL(file), name: file.name, ready: false };
      sourceAudioRef.current = next; setSourceAudio(next);
    } catch { setSourceAudioError('원본 파일을 연결하지 못했습니다. 다시 선택해 주세요.'); }
  }, [releaseSourceAudio]);
  const isCurrentSource = useCallback((source) => Boolean(reviewMountedRef.current && source && source.scope === reviewScopeRef.current && source.url === sourceAudioRef.current?.url), []);
  const checkRangeEnd = useCallback(() => {
    const range = sourceRangeRef.current, media = sourceAudioElementRef.current;
    if (!range || !media) return;
    if (!isCurrentSource(range) || media.currentTime >= range.end) { media.pause(); stopRangeTimer(); }
  }, [isCurrentSource, stopRangeTimer]);
  const playReviewRange = useCallback(async (index, expectedSegment, session, requestedRange = null) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session) return;
    const source = sourceAudioRef.current, media = sourceAudioElementRef.current;
    if (!isCurrentSource(source) || !source.ready || !media || editedSegmentsRef.current[index] !== expectedSegment) return;
    const { start, end } = requestedRange || expectedSegment;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > media.duration + 0.001) {
      setSourceAudioError('연결한 파일의 길이와 이 구간 시간을 확인해 주세요.'); return;
    }
    const ticket = ++playRequestRef.current;
    stopRangeTimer(); media.pause(); setSourceAudioError('');
    try {
      media.currentTime = Math.max(0, start - 0.5);
      sourceRangeRef.current = { ...source, start: media.currentTime, end: Math.min(media.duration, end + 0.5) };
      sourceStopTimerRef.current = window.setInterval(checkRangeEnd, 50);
      await media.play();
      if (ticket !== playRequestRef.current || !isCurrentSource(source)) media.pause();
    } catch {
      if (ticket === playRequestRef.current && isCurrentSource(source)) { stopRangeTimer(); setSourceAudioError('재생하지 못했습니다. 원본 플레이어에서 파일 상태를 확인해 주세요.'); }
    }
  }, [checkRangeEnd, isCurrentSource, stopRangeTimer]);
  const changeReviewCandidate = useCallback((index, base, update, session) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session || editedSegmentsRef.current[index] !== base) return;
    const scope = reviewScopeRef.current;
    const current = pendingReviewsRef.current;
    const previous = current[index]?.base === base && current[index].session === session ? current[index] : null;
    const next = { ...current, [index]: { base, scope, session, value: previous?.value ?? normalizeSubtitleReview(base.subtitleReview, base.text)?.candidateText ?? '', remember: false, ...previous, ...update } };
    pendingReviewsRef.current = next; setPendingReviews(next);
    setReviewError(null);
  }, []);
  const useRememberedReview = useCallback((index, base, entry, session) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session || editedSegmentsRef.current[index] !== base || entry.originalText !== base.text
      || findRememberedSubtitle(reviewMemoryRef.current, editedSegmentsRef.current, index) !== entry) return;
    changeReviewCandidate(index, base, { value: entry.candidateText, remember: false }, session);
  }, [changeReviewCandidate]);
  const applyReviewCandidate = useCallback((index, base, candidate, remember, session) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session || editedSegmentsRef.current[index] !== base || lineCountMismatchRef.current) return;
    const scope = reviewScopeRef.current;
    const pending = pendingReviewsRef.current[index];
    if (pending?.base === base && pending.session === session && (pending.value !== candidate || Boolean(pending.remember) !== remember)) return;
    if ((!pending || pending.base !== base || pending.session !== session) && candidate !== (normalizeSubtitleReview(base.subtitleReview, base.text)?.candidateText ?? '')) return;
    const error = validateSubtitleCandidate(editedSegmentsRef.current, index, candidate);
    if (error) { setReviewError({ scope, index, message: error }); return; }
    if (remember) {
      const items = rememberSubtitleCandidate(reviewMemoryRef.current, editedSegmentsRef.current, index, candidate);
      reviewMemoryRef.current = items; setReviewMemoryState({ scope, items });
    }
    const next = editedSegmentsRef.current.map((segment, position) => position === index ? confirmSubtitleCandidate(segment, candidate) : segment);
    editedSegmentsRef.current = next; setEditedSegments(next);
    setFullTextDraft(joinSegmentLines(next)); setReviewError(null);
  }, []);

  const confirmCurrentReview = useCallback((index, base, session) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session || editedSegmentsRef.current[index] !== base || lineCountMismatchRef.current) return;
    changeReviewCandidate(index, base, { value: base.text, remember: false }, session);
    applyReviewCandidate(index, base, base.text, false, session);
  }, [applyReviewCandidate, changeReviewCandidate]);

  const changeTiming = useCallback((index, base, update, session) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session || editedSegmentsRef.current[index] !== base) return;
    const previous = pendingTimingsRef.current[index];
    const pending = previous?.base === base && previous.session === session ? previous : {
      base, session, startInput: formatSubtitleTimeInput(base.start, { isStart: true }), endInput: formatSubtitleTimeInput(base.end),
    };
    const next = { ...pendingTimingsRef.current, [index]: { ...pending, ...update } };
    pendingTimingsRef.current = next; setPendingTimings(next); setTimingError(null);
  }, []);
  const useTimingCandidate = useCallback((index, base, session) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session || editedSegmentsRef.current[index] !== base) return;
    const candidate = getSubtitleTimingCandidate(base);
    if (candidate) changeTiming(index, base, { startInput: formatSubtitleTimeInput(candidate.start, { isStart: true }), endInput: formatSubtitleTimeInput(candidate.end) }, session);
  }, [changeTiming]);
  const confirmTiming = useCallback((index, base, startInput, endInput, session) => {
    if (!reviewMountedRef.current || reviewSessionRef.current !== session || editedSegmentsRef.current[index] !== base
      || lineCountMismatchRef.current || !timingEnabled) return;
    const pending = pendingTimingsRef.current[index];
    const current = pending?.base === base && pending.session === session ? pending : {
      startInput: formatSubtitleTimeInput(base.start, { isStart: true }), endInput: formatSubtitleTimeInput(base.end),
    };
    if (startInput !== current.startInput || endInput !== current.endInput) return;
    const source = sourceAudioRef.current, media = sourceAudioElementRef.current;
    const scope = reviewScopeRef.current;
    if (!isCurrentSource(source) || !source.ready || !media || !Number.isFinite(media.duration) || media.duration <= 0) {
      setTimingError({ scope, index, message: '이 파일의 원본을 연결해 재생 길이를 확인한 뒤 시간을 적용해 주세요.' }); return;
    }
    const start = parseSubtitleTimeInput(startInput), end = parseSubtitleTimeInput(endInput);
    const error = validateSubtitleTiming(editedSegmentsRef.current, index, start, end, { durationSeconds: media.duration });
    if (error) { setTimingError({ scope, index, message: error }); return; }
    playRequestRef.current += 1; stopRangeTimer(); media.pause();
    const next = editedSegmentsRef.current.map((segment, position) => position === index ? confirmSubtitleTiming(segment, start, end) : segment);
    editedSegmentsRef.current = next; setEditedSegments(next);
    setFullTextDraft(joinSegmentLines(next)); setTimingError(null);
  }, [isCurrentSource, stopRangeTimer, timingEnabled]);

  const changeExclusion = useCallback((index, base, excluded, session) => {
    if (!exclusionEnabled || !reviewMountedRef.current || reviewSessionRef.current !== session
      || editedSegmentsRef.current[index] !== base || lineCountMismatchRef.current) return;
    const next = editedSegmentsRef.current.map((segment, position) => position === index ? setSubtitleExclusion(segment, excluded) : segment);
    editedSegmentsRef.current = next;
    setEditedSegments(next);
    setFullTextDraft(joinSegmentLines(next));
  }, [exclusionEnabled]);

  const restoreCueCorrection = useCallback((index, base, session) => {
    if (!timingEnabled || !reviewMountedRef.current || reviewSessionRef.current !== session
      || editedSegmentsRef.current[index] !== base || lineCountMismatchRef.current) return;
    const restored = restoreFixedCuePlan(base);
    if (restored === base) return;
    const textError = validateSubtitleCandidate(editedSegmentsRef.current, index, restored.text);
    const timingError = restored.start === base.start && restored.end === base.end ? null
      : validateSubtitleTiming(editedSegmentsRef.current, index, restored.start, restored.end);
    if (textError || timingError) {
      setReviewError({ scope: reviewScopeRef.current, index, message: textError || timingError });
      return;
    }
    const next = editedSegmentsRef.current.map((segment, position) => position === index ? restored : segment);
    editedSegmentsRef.current = next;
    setEditedSegments(next);
    setFullTextDraft(joinSegmentLines(next));
    setReviewError(null);
  }, [timingEnabled]);

  // 사용자와 기록별로 초안을 분리한다. 묶음의 다른 파일이나 계정에 편집본이 섞이지 않는다.
  useEffect(() => {
    if (editedSegments.length === 0 || !transcriptionLogId) return;
    writeResultDraft(sessionStorage, user?.id, transcriptionLogId, { segments: editedSegments, fullTextDraft, speakerColors, baseText: persistedTextRef.current, baseSignature: persistedEditSignatureRef.current, reviewMemory });
  }, [editedSegments, fullTextDraft, speakerColors, transcriptionLogId, user?.id, saveState, reviewMemory]);

  // 편집본을 서버에도 보관한다. sessionStorage만으로는 창을 닫으면 사라지고,
  // 재다운로드가 다듬기 전 원본을 내려주는 문제가 남는다.
  const flushEdits = useCallback(async () => {
    if (!transcriptionLogId || !token || !user?.id) throw new Error('로그인 후 편집 저장 상태를 확인해 주세요.');
    while (true) {
      if (lineCountMismatchRef.current) throw new Error('편집한 줄 수가 자막 수와 다릅니다. 먼저 줄 수를 맞춰 주세요.');
      if (saveRequestRef.current) { await saveRequestRef.current; continue; }
      const snapshot = editedSegmentsRef.current;
      const saveSource = resultSourceRef.current;
      const cachedBefore = !saveSource.resultOverride ? resolveSavedResult(sessionStorage, saveSource.ownerId, null) : null;
      const expectedCacheSignature = resultSnapshotSignature(cachedBefore || saveSource.resolved);
      const nextText = joinSegmentLines(snapshot);
      const nextSignature = subtitleEditSignature(snapshot);
      if (nextSignature === persistedEditSignatureRef.current) return;
      const request = (async () => {
        setSaveState('saving'); setSaveError('');
        try {
          const res = await fetch(`/api/auth/transcription/${transcriptionLogId}/segments`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ segments: snapshot }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(data?.error || '편집 내용을 저장하지 못했습니다. 이 화면의 내용을 유지한 채 다시 시도해 주세요.');
          }
          persistedTextRef.current = nextText; persistedEditSignatureRef.current = nextSignature;
          const currentSource = resultSourceRef.current;
          if (!saveSource.resultOverride && reviewMountedRef.current && currentSource.ownerId === saveSource.ownerId
            && currentSource.logId === saveSource.logId && currentSource.resolved === saveSource.resolved) {
            const saved = cacheSavedResult(sessionStorage, saveSource.ownerId, saveSource.logId, saveSource.resolved, snapshot, expectedCacheSignature);
            if (saved) {
              try { navigate(saveSource.path, { replace: true, state: saved }); } catch { /* The acknowledged session cache and server history remain available. */ }
            }
          }
          setSaveState('saved');
        } catch (error) { setSaveState('failed'); setSaveError(error.message); throw error; }
      })();
      saveRequestRef.current = request;
      try { await request; } finally { if (saveRequestRef.current === request) saveRequestRef.current = null; }
    }
  }, [transcriptionLogId, token, user?.id, navigate]);

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
      segmentIndex === index ? editSubtitleText(segment, nextText) : segment
    ));
    editedSegmentsRef.current = next;
    setEditedSegments(next);
    setFullTextDraft(joinSegmentLines(next));
    if (lineCountMismatchRef.current) {
      lineCountMismatchRef.current = false;
    }
  }, []);

  const restorePolishedOriginals = useCallback(() => {
    const next = editedSegmentsRef.current.map((segment) => {
      if (!segment.grammarPolish || typeof segment.grammarPolish.originalText !== 'string') return segment;
      const fixedPlan = getBoundFixedCuePlan(segment);
      const hasFixedEvidence = segment.fixedCuePlan !== undefined || segment.timingSource === 'speech_window';
      const canRestoreFixed = fixedPlan?.original?.text === segment.grammarPolish.originalText
        && fixedPlan.original.start === segment.start && fixedPlan.original.end === segment.end;
      const restored = canRestoreFixed ? restoreFixedCuePlan(segment)
        : hasFixedEvidence ? editSubtitleText(segment, segment.grammarPolish.originalText)
          : { ...segment, text: segment.grammarPolish.originalText };
      if (!hasFixedEvidence) {
        if (segment.grammarPolish.originalTimingSource === undefined) delete restored.timingSource;
        else restored.timingSource = segment.grammarPolish.originalTimingSource;
      }
      delete restored.grammarPolish;
      return restored;
    });
    editedSegmentsRef.current = next;
    setEditedSegments(next);
    setFullTextDraft(joinSegmentLines(next));
    lineCountMismatchRef.current = false;
  }, []);

  function updateFullText(nextText) {
    setFullTextDraft(nextText);
    lineCountMismatchRef.current = editedSegmentsRef.current.length > 0 && splitTextLines(nextText).length !== editedSegmentsRef.current.length;
    // 줄 수가 맞을 때만 자막에 반영한다. 어긋난 상태는 경고로 알리고 보류한다.
    if (canApplyFullText(editedSegments, nextText)) {
      const next = buildEditedSegments(editedSegmentsRef.current, nextText);
      editedSegmentsRef.current = next;
      setEditedSegments(next);
    }
  }

  function applyAssPreset(preset) {
    setAssPosition(preset.position);
    setAssFontFamily(preset.fontFamily);
    setAssFontColor(preset.fontColor);
    setAssFontSize(preset.fontSize);
  }

  async function handleDownload(format) {
    if (!hasIncludedDialogue(editedSegmentsRef.current, exclusionEnabled)) return;
    if (format === 'ass') {
      setShowAssPanel(true);
      return;
    }
    await doDownload(format);
  }

  async function doDownload(format, options) {
    // 버튼은 비활성화돼 있지만, 어긋난 상태로는 어떤 경로로도 파일이 나가지 않게 막는다.
    if (lineCountMismatch) return;
    const exportSegments = editedSegmentsRef.current;
    if (!hasIncludedDialogue(exportSegments, exclusionEnabled)) return;
    setDownloading(true);
    try {
      const body = { segments: exportSegments, format, holdShortGaps: holdShortGaps !== false };
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
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || '다운로드 실패');
      }
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
      {grammarPolishSummary && <div className="batch-note" role="status">
        {polishRestored
          ? `문장 다듬기 전 문장으로 ${restoredPolishCount}개 자막 구간을 복원했습니다.`
          : `문장 다듬기: ${grammarPolishSummary.applied || 0}개 자막 구간에 적용했습니다. 문맥이 모호하거나 검수되지 않은 구간은 원래 맞춤법 교정 결과를 유지합니다.`}
        {grammarPolishSummary.limited ? ' 파일당 최대 120개 구간·3,360자·60초 한도를 넘긴 내용은 건너뛰었습니다.' : ''}
        {' '}적용된 구간의 타임코드는 원래 음성 구간을 따르며, 새 문장에 맞춘 단어 단위 싱크를 보장하지 않습니다.
        {(grammarPolishStatusCounts.meaning_or_timing_rejected || grammarPolishStatusCounts.unsafe_candidate) ? ` 검수에서 보류한 구간 ${((grammarPolishStatusCounts.meaning_or_timing_rejected || 0) + (grammarPolishStatusCounts.unsafe_candidate || 0))}개.` : ''}
        {grammarPolishStatusCounts.review_pending ? ` 기존 자막 검토가 진행 중인 구간 ${grammarPolishStatusCounts.review_pending}개.` : ''}
        {grammarPolishStatusCounts.limit ? ` 설정 한도로 건너뛴 구간 ${grammarPolishStatusCounts.limit}개.` : ''}
        {grammarPolishStatusCounts.unsupported_cue ? ` 문장 다듬기를 적용할 수 없는 형식의 구간 ${grammarPolishStatusCounts.unsupported_cue}개.` : ''}
        {(grammarPolishStatusCounts.timeout || grammarPolishStatusCounts.api_error || grammarPolishStatusCounts.verifier_unavailable) ? ' 일부 구간은 시간 초과나 API·검수기 오류로 원래 결과를 유지했습니다.' : ''}
        {grammarPolishSummary.unavailable ? ' 일부 처리는 시간 초과, 검증 실패 또는 처리 오류로 적용하지 않았습니다.' : ''}
        {editedSegments.some((segment) => segment.grammarPolish?.originalText !== undefined) && <button className="result-editor-tip__link" onClick={restorePolishedOriginals} type="button">다듬기 전 문장으로 복원</button>}
      </div>}

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

          <details className="subtitle-review-source">
            <summary>원본 오디오로 검토하기 · 선택</summary>
            <p>파일은 이 창에서만 재생하며 서버에 업로드하지 않습니다. 이 변환과 시작점이 같은 원본인지 직접 확인해 주세요. 다른 파일·계정으로 이동하거나 새로고침하면 다시 연결합니다.</p>
            <label htmlFor="review-source-audio">이 파일의 원본 오디오 또는 영상 연결</label>
            <input id="review-source-audio" type="file" accept="audio/*,video/mp4,video/webm" onChange={connectSourceAudio} />
            {visibleSourceAudio && <div>
              <p>{visibleSourceAudio.name} · {visibleSourceAudio.ready ? '이 창에서 재생 준비됨' : '파일 정보 확인 중'}</p>
              <audio key={visibleSourceAudio.url} ref={sourceAudioElementRef} src={visibleSourceAudio.url} controls preload="metadata" aria-label="현재 파일의 원본 오디오"
                onLoadedMetadata={(event) => {
                  if (!isCurrentSource(visibleSourceAudio)) return;
                  sourceLastElementRef.current = event.currentTarget;
                  const duration = event.currentTarget.duration;
                  if (!Number.isFinite(duration) || duration <= 0) { setSourceAudioError('원본 파일의 재생 길이를 확인하지 못했습니다.'); return; }
                  const next = { ...visibleSourceAudio, ready: true }; sourceAudioRef.current = next; setSourceAudio(next);
                }}
                onTimeUpdate={checkRangeEnd} onEnded={stopRangeTimer}
                onSeeking={(event) => { const range = sourceRangeRef.current; if (range && (event.currentTarget.currentTime < range.start || event.currentTarget.currentTime >= range.end)) stopRangeTimer(); }}
                onError={() => { if (isCurrentSource(visibleSourceAudio)) { stopRangeTimer(); const next = { ...visibleSourceAudio, ready: false }; sourceAudioRef.current = next; setSourceAudio(next); setSourceAudioError('브라우저에서 이 원본 파일을 재생하지 못했습니다.'); } }} />
              <button type="button" className="button button--secondary" onClick={releaseSourceAudio}>원본 연결 해제</button>
            </div>}
            <p>구간별 편집의 ‘앞뒤 포함 듣기’는 앞뒤 0.5초를 함께 재생합니다. 자막 시간이나 파일은 바꾸지 않습니다.</p>
            {sourceAudioError && <p className="subtitle-review__error" role="alert">{sourceAudioError}</p>}
            {reviewMemory.length > 0 && <div><p>이 창의 현재 파일에 기억한 후보 {reviewMemory.length}개 · 다른 영상이나 계정에서 사용하지 않습니다.</p><button type="button" className="button button--secondary" onClick={() => { if (!reviewMountedRef.current || reviewSessionRef.current !== reviewSession) return; reviewMemoryRef.current = []; setReviewMemoryState({ scope: reviewScope, items: [] }); }}>이 파일의 후보 기억 지우기</button></div>}
          </details>
          {saveState === 'failed' && saveError && <p className="subtitle-review__error" role="alert">{saveError}</p>}
          <p className="subtitle-review-guidance">구간별 편집에서 문구·시간 검토와 원본 듣기를 사용할 수 있습니다. {exclusionEnabled ? '무음 근거로 자동 제외되거나 직접 제외한 구간 외에는 미검토 대사도 다운로드에 포함합니다.' : '검토가 끝나지 않은 대사도 다운로드에 포함합니다.'}</p>
          {exclusionEnabled && (localExclusionSummary.groups.length > 0 || localExclusionSummary.automatic + localExclusionSummary.user + localExclusionSummary.restored + localExclusionSummary.review > 0) && <details className="subtitle-review subtitle-review-groups">
            <summary>반복·제외 검토 · {localExclusionSummary.groups.length}개 묶음 · 제외 {localExclusionSummary.automatic + localExclusionSummary.user}개</summary>
            <p role="status">무음 근거 자동 제외 {localExclusionSummary.automatic}개 · 사용자 제외 {localExclusionSummary.user}개 · 복원 {localExclusionSummary.restored}개 · 미확정 검토 {localExclusionSummary.review}개</p>
            <p className="subtitle-review__hint">반복 묶음은 정답이나 오류 판정이 아닙니다. 일괄 제외하지 않으며 각 구간의 원음을 확인한 뒤 제외·복원할 수 있습니다.</p>
            {localExclusionSummary.groups.length > 0 && <ul className="subtitle-review-groups__list">{localExclusionSummary.groups.map((group) => <li key={group.id}>
              <p>{group.text}</p><p className="subtitle-review__hint">{group.members.map((member) => `#${member.index + 1} ${formatSegmentTime(member.start)} - ${formatSegmentTime(member.end)}`).join(' · ')}</p>
            </li>)}</ul>}
            <button type="button" className="result-editor-tip__link" onClick={() => selectEditorMode('segments')}>구간별에서 검토</button>
          </details>}

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
                    key={index}
                    onCopyIdea={isIdeaOpen ? copyIdea : null}
                    onGenerateIdeas={isIdeaOpen ? generateIdeas : null}
                    onIdeaModeChange={isIdeaOpen ? changeIdeaMode : null}
                    onIdeaFocusSelection={isIdeaOpen ? selectIdeaFocus : null}
                    onTextChange={updateSegmentText}
                    onToggleIdea={openIdeaPanel}
                    segment={segment}
                    speakerColor={speakerColors[String(segment.speaker)] || 'var(--text-secondary)'}
                    originalText={segments[index]?.text}
                    pendingReview={pendingReviews[index]?.session === reviewSession ? pendingReviews[index] : undefined}
                    rememberedReview={findRememberedSubtitle(reviewMemory, editedSegments, index)}
                    reviewError={reviewError?.scope === reviewScope && reviewError.index === index ? reviewError.message : ''}
                    reviewApplyDisabled={lineCountMismatch}
                    audioAvailable={Boolean(visibleSourceAudio?.ready)}
                    reviewSession={reviewSession}
                    onReviewChange={changeReviewCandidate}
                    onApplyReview={applyReviewCandidate}
                    onConfirmCurrentReview={confirmCurrentReview}
                    onUseRememberedReview={useRememberedReview}
                    onPlayReviewRange={playReviewRange}
                    timingEnabled={timingEnabled}
                    displayHoldEnabled={holdShortGaps !== false}
                    pendingTiming={pendingTimings[index]?.session === reviewSession ? pendingTimings[index] : undefined}
                    timingError={timingError?.scope === reviewScope && timingError.index === index ? timingError.message : ''}
                    onTimingChange={changeTiming}
                    onUseTimingCandidate={useTimingCandidate}
                    onConfirmTiming={confirmTiming}
                    exclusionEnabled={exclusionEnabled}
                    onSetExclusion={changeExclusion}
                    onRestoreCueCorrection={restoreCueCorrection}
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
                  disabled={downloading || lineCountMismatch || !hasIncludedSubtitles}
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

            <p className="result-tool-note">SRT에는 인식된 대사만 포함되며 첫 대사의 타임코드와 원문을 유지합니다. 글자 크기는 편집 프로그램에 따라 달라질 수 있습니다.</p>
            {!hasIncludedSubtitles && <p className="result-tool-note" role="status">남은 자막 없음 · 내보낼 대사가 없어 SRT·ASS·TXT를 만들 수 없습니다. 구간별 검토에서 제외한 자막을 복원할 수 있습니다.</p>}
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
                disabled={downloading || lineCountMismatch || !hasIncludedSubtitles}
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
