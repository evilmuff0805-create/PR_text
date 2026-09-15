import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { validatePreparedUploadFile } from '../utils/upload-validation.js';

import { pendingOperationStorageKey, readPendingOperation, classifyOperationResponse, canSubmitOperation } from '../utils/transcription-operation.js';

const TranscriptionContext = createContext(null);
const BUSY_STATUSES = new Set(['uploading', 'queued', 'processing']);

export const pendingJobStorageKey = (userId) => `pendingDiarizationJob:${userId}`;

function createIdleState(ownerId = null) {
  return {
    ownerId,
    status: 'idle',
    progress: '',
    error: '',
    activeDiarize: false,
    activeJobId: null,
    activeOperationKey: null,
    result: null,
  };
}

function uploadTranscription({ formData, token, onProgress, onUploadComplete, operationKey = null }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', operationKey ? '/api/transcribe/v2' : '/api/transcribe');
    if (operationKey) xhr.setRequestHeader('X-Transcription-Operation-Key', operationKey);
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

function resultFromResponse(data, diarize) {
  return {
    text: data.text,
    segments: data.segments,
    language: data.language,
    // 편집기가 다듬은 자막을 되돌려 저장할 대상. 빠뜨리면 편집본이 서버에 남지 않는다.
    transcriptionLogId: data.transcriptionLogId ?? null,
    diarize,
  };
}

export function TranscriptionProvider({ children }) {
  const { user, token, updateCredits, getToken } = useAuth();
  const [job, setJob] = useState(() => createIdleState());
  const [notice, setNotice] = useState(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location.pathname);
  const ownerRef = useRef(user?.id);
  ownerRef.current = user?.id;
  const [recoveryRevision, setRecoveryRevision] = useState(0);

  useEffect(() => {
    locationRef.current = location.pathname;
  }, [location.pathname]);

  const completeTranscription = useCallback((result) => {
    setJob((current) => ({
      ...current,
      status: 'completed',
      progress: '',
      error: '',
      activeJobId: null,
      activeOperationKey: null,
      result,
    }));
    setNotice({
      type: 'success',
      title: '변환이 완료되었습니다',
      message: '결과를 확인하고 자막 파일을 내려받을 수 있습니다.',
      result,
    });

    if (locationRef.current === '/transcribe') {
      navigate('/result', { state: result });
    }
  }, [navigate]);

  const failTranscription = useCallback((message) => {
    setJob((current) => ({
      ...current,
      status: 'error',
      progress: '',
      error: message,
      activeJobId: null,
    }));

    if (locationRef.current !== '/transcribe') {
      setNotice({
        type: 'error',
        title: '변환을 완료하지 못했습니다',
        message,
      });
    }
  }, []);

  useEffect(() => {
    if (!user?.id || !token) {
      setJob(createIdleState());
      setNotice(null);
      return;
    }

    setJob((current) => {
      if (current.ownerId === user.id) return current;

      const savedOperation = readPendingOperation(localStorage, user.id) || readPendingOperation(localStorage, 'completed:' + user.id);
      if (savedOperation?.operationKey) return { ...createIdleState(user.id), activeOperationKey: savedOperation.operationKey, status: 'queued', progress: '이전 변환 작업을 확인 중입니다...' };
      const savedJobId = localStorage.getItem(pendingJobStorageKey(user.id));
      if (!savedJobId) return createIdleState(user.id);

      return {
        ...createIdleState(user.id),
        status: 'queued',
        progress: '이전 다화자 분석 작업 상태를 확인 중입니다...',
        activeDiarize: true,
        activeJobId: savedJobId,
      };
    });
  }, [token, user?.id]);

  useEffect(() => {
    if (!job.activeJobId || !token || !user?.id) return;

    let cancelled = false;

    async function pollJob() {
      try {
        const response = await fetch(`/api/transcribe/jobs/${job.activeJobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '다화자 작업 상태를 확인하지 못했습니다.');
        if (cancelled) return;

        if (data.creditsRemaining !== undefined) updateCredits(data.creditsRemaining);

        if (data.status === 'completed') {
          localStorage.removeItem(pendingJobStorageKey(user.id));
          completeTranscription(resultFromResponse(data, true));
          return;
        }

        if (data.status === 'failed') {
          localStorage.removeItem(pendingJobStorageKey(user.id));
          failTranscription(data.error || '변환에 실패했지만 예약한 변환 시간은 자동 환불되었습니다.');
          return;
        }

        setJob((current) => ({
          ...current,
          status: data.status === 'running' ? 'processing' : 'queued',
          progress: data.status === 'running'
            ? '화자 분석과 자막 생성을 진행 중입니다.'
            : '다화자 분석 작업을 대기열에서 기다리고 있습니다.',
        }));
      } catch {
        if (!cancelled) {
          setJob((current) => ({
            ...current,
            progress: '작업 상태 연결을 다시 확인 중입니다...',
          }));
        }
      }
    }

    pollJob();
    const intervalId = window.setInterval(pollJob, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [completeTranscription, failTranscription, job.activeJobId, token, updateCredits, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const restore = (event) => {
      if (event.key !== pendingOperationStorageKey(user.id)) return;
      const saved = readPendingOperation(localStorage, user.id);
      if (saved?.operationKey) setJob((current) => ({ ...current, activeOperationKey: saved.operationKey, status: 'queued', progress: '다른 탭에서 접수한 작업을 확인 중입니다...' }));
    };
    window.addEventListener('storage', restore);
    return () => window.removeEventListener('storage', restore);
  }, [user?.id]);

  useEffect(() => {
    if (!job.activeOperationKey || !token || !user?.id) return;
    let disposed = false, timeout, errors = 0, stagedChecks = 0;
    const controller = new AbortController();
    const owner = user.id, key = job.activeOperationKey;
    async function poll() {
      try {
        const response = await fetch('/api/transcribe/v2/by-key/' + key, { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal });
        const data = await response.json();
        if (disposed || ownerRef.current !== owner) return;
        const kind = classifyOperationResponse(response.status, data);
        if (kind === 'login' || kind === 'missing') {
          if (kind === 'missing' && errors++ < 3) { timeout = window.setTimeout(poll, 5_000); return; }
          setJob((current) => ({ ...current, status: 'recovery', error: kind === 'login' ? '로그인이 필요합니다. 다시 로그인하면 작업 상태를 확인할 수 있습니다.' : '접수 여부를 확인하지 못했습니다. 같은 파일로 다시 시도하면 기존 작업을 먼저 확인합니다.', progress: '' }));
          return;
        }
        if (kind === 'retry') throw new Error('연결 확인 필요');
        errors = 0;
        if (data.creditsRemaining !== undefined) updateCredits(data.creditsRemaining);
        if (kind === 'completed') {
          localStorage.setItem(pendingOperationStorageKey('completed:' + owner), JSON.stringify({ operationKey: key }));
          localStorage.removeItem(pendingOperationStorageKey(owner));
          setJob((current) => ({ ...current, activeOperationKey: null }));
          completeTranscription(resultFromResponse(data, false)); return;
        }
        if (kind === 'terminal') {
          localStorage.removeItem(pendingOperationStorageKey(owner));
          setJob((current) => ({ ...current, activeOperationKey: null }));
          failTranscription(data.error || '작업이 종료되었습니다. 유효한 예약 시간은 반환되었습니다.'); return;
        }
        if (kind === 'staged') {
          if (!readPendingOperation(localStorage, owner)?.lastError && ++stagedChecks < 24) {
            setJob((current) => ({ ...current, status: 'queued', error: '', progress: '원본을 안전하게 저장하고 있습니다. 잠시 기다려주세요.' }));
            timeout = window.setTimeout(poll, 5_000); return;
          }
          setJob((current) => ({ ...current, status: 'recovery', progress: '', error: readPendingOperation(localStorage, owner)?.lastError || '파일 접수를 마치지 못했습니다. 같은 파일로 다시 시도해주세요.' }));
          return;
        }
        setJob((current) => ({ ...current, status: data.status === 'queued' ? 'queued' : 'processing', error: '', progress: data.status === 'finalizing' ? '완성된 자막을 안전하게 저장하고 있습니다.' : data.status === 'queued' ? '먼저 접수된 작업이 끝나면 변환을 시작합니다.' : '음성 전사와 자막 생성을 진행하고 있습니다.' }));
        timeout = window.setTimeout(poll, 5_000);
      } catch {
        if (disposed || ownerRef.current !== owner) return;
        if (++errors >= 6) {
          setJob((current) => ({ ...current, status: 'recovery', progress: '', error: '작업 상태 연결을 확인하지 못했습니다. 잠시 후 다시 확인해주세요. 접수된 변환은 서버에서 계속됩니다.' })); return;
        }
        setJob((current) => ({ ...current, progress: '작업 상태 연결을 다시 확인 중입니다...' }));
        timeout = window.setTimeout(poll, Math.min(5_000 * 2 ** (errors - 1), 30_000));
      }
    }
    poll();
    return () => { disposed = true; controller.abort(); window.clearTimeout(timeout); };
  }, [job.activeOperationKey, token, user?.id, recoveryRevision, completeTranscription, failTranscription, updateCredits]);

  const retryOperationStatus = useCallback(() => {
    setJob((current) => ({ ...current, status: 'queued', error: '', progress: '작업 상태를 다시 확인 중입니다...' }));
    setRecoveryRevision((value) => value + 1);
  }, []);

  const startNewOperation = useCallback(() => {
    if (!user?.id || BUSY_STATUSES.has(job.status)) return;
    if (readPendingOperation(localStorage, user.id)) return;
    localStorage.removeItem(pendingOperationStorageKey(user.id));
    localStorage.removeItem(pendingOperationStorageKey('completed:' + user.id));
    setJob(createIdleState(user.id)); setNotice(null);
  }, [user?.id, job.status]);

  const cancelOperation = useCallback(async () => {
    if (!user?.id || !token || !job.activeOperationKey || isCancelling) return;
    setIsCancelling(true);
    try {
      const response = await fetch('/api/transcribe/v2/by-key/' + job.activeOperationKey, { headers: { Authorization: 'Bearer ' + token } });
      const operation = await response.json();
      if (!response.ok) throw new Error('접수된 작업을 확인하지 못했습니다. 잠시 후 다시 확인해주세요.');
      const cancelled = await fetch('/api/transcribe/v2/' + operation.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      if (!cancelled.ok && cancelled.status !== 409) throw new Error('취소 여부를 확인하지 못했습니다. 다시 확인해주세요.');
      retryOperationStatus();
    } catch (error) { setJob((current) => ({ ...current, error: error.message })); }
    finally { setIsCancelling(false); }
  }, [user?.id, token, job.activeOperationKey, isCancelling, retryOperationStatus]);

  const startTranscription = useCallback(async ({ file, language, diarize }) => {
    if (!user?.id || BUSY_STATUSES.has(job.status)) return;
    if (!canSubmitOperation(readPendingOperation(localStorage, user.id), diarize)) {
      setJob((current) => ({ ...current, status: 'recovery', error: '기존 일반 변환을 완료하거나 취소한 뒤 다화자 변환을 시작해주세요.' }));
      return;
    }

    const uploadValidationError = validatePreparedUploadFile(file);
    if (uploadValidationError) {
      failTranscription(uploadValidationError);
      return;
    }

    setNotice(null);
    setJob({
      ...createIdleState(user.id),
      status: 'uploading',
      progress: '파일 업로드 중... 0%',
      activeDiarize: diarize,
    });

    let operationKey;
    const owner = user.id;
    try {
      if (!diarize) {
        localStorage.removeItem(pendingOperationStorageKey('completed:' + owner));
        operationKey = readPendingOperation(localStorage, owner)?.operationKey || crypto.randomUUID();
        localStorage.setItem(pendingOperationStorageKey(owner), JSON.stringify({ operationKey }));
      }
      const formData = new FormData();
      formData.append('audio', file);
      if (language) formData.append('language', language);
      if (diarize) formData.append('diarize', 'true');

      const currentToken = getToken();
      const { status, ok, data, requestId } = await uploadTranscription({
        formData,
        operationKey,
        token: currentToken,
        onProgress: (ratio) => {
          const percent = Math.min(Math.round(ratio * 100), 100);
          setJob((current) => ({ ...current, progress: `파일 업로드 중... ${percent}%` }));
        },
        onUploadComplete: () => {
          setJob((current) => ({
            ...current,
            status: 'processing',
            progress: diarize
              ? '화자 분석과 자막 생성을 진행 중입니다.'
              : '음성 전사와 맞춤법 교정을 진행 중입니다.',
          }));
        },
      });

      if (ownerRef.current !== owner) return;
      if (status === 409 && data.legacyFallback && !diarize) {
        localStorage.removeItem(pendingOperationStorageKey(owner));
        operationKey = null;
        const legacy = await uploadTranscription({ formData, token: currentToken, onProgress: () => {}, onUploadComplete: () => {} });
        if (ownerRef.current !== owner) return;
        if (!legacy.ok) throw new Error(legacy.data.error || '변환 요청을 확인하지 못했습니다.');
        if (legacy.data.creditsRemaining !== undefined) updateCredits(legacy.data.creditsRemaining);
        completeTranscription(resultFromResponse(legacy.data, false)); return;
      }
      if (status === 202 && data.operationId && !diarize) {
        setJob((current) => ({ ...current, activeOperationKey: operationKey, status: 'queued', progress: '접수된 변환을 확인 중입니다...' }));
        return;
      }
      if (status === 401) {
        throw new Error('로그인이 필요합니다. 좌측 사이드바에서 로그인해주세요.');
      }
      if (status === 402) {
        if (operationKey) localStorage.setItem(pendingOperationStorageKey(owner), JSON.stringify({ operationKey, lastError: '변환 가능 시간이 부족합니다. 충전 후 같은 작업으로 다시 시도해주세요.' }));
        throw new Error(`변환 가능 시간이 부족합니다. 필요: ${data.creditsNeeded}분, 보유: ${data.creditsHave}분. 결제 페이지에서 충전해주세요.`);
      }
      if (!ok) {
        const message = data.error || '변환 요청 실패';
        throw new Error(requestId ? `${message} (오류 코드: ${requestId})` : message);
      }

      if (data.creditsRemaining !== undefined) updateCredits(data.creditsRemaining);

      if (status === 202 && data.jobId) {
        localStorage.setItem(pendingJobStorageKey(user.id), data.jobId);
        setJob((current) => ({
          ...current,
          status: 'queued',
          progress: '다화자 분석 작업을 대기열에서 기다리고 있습니다.',
          activeJobId: data.jobId,
        }));
        return;
      }

      completeTranscription(resultFromResponse(data, data.diarize === true));
    } catch (error) {
      if (ownerRef.current !== owner) return;
      if (operationKey) {
        setJob((current) => ({ ...current, activeOperationKey: operationKey, status: 'recovery', progress: '', error: error.message || '접수 상태를 확인하고 있습니다.' }));
        setRecoveryRevision((value) => value + 1);
      } else failTranscription(error.message || '오류가 발생했습니다.');
    }
  }, [completeTranscription, failTranscription, getToken, job.status, updateCredits, user?.id]);

  const cancelDiarization = useCallback(async () => {
    if (!job.activeJobId || !token || !user?.id || isCancelling) return;

    setIsCancelling(true);
    try {
      const response = await fetch(`/api/transcribe/jobs/${job.activeJobId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '작업을 취소하지 못했습니다.');

      if (data.creditsRemaining !== undefined) updateCredits(data.creditsRemaining);
      localStorage.removeItem(pendingJobStorageKey(user.id));
      setJob({
        ...createIdleState(user.id),
        status: 'error',
        error: '작업을 취소하고 예약한 변환 시간을 환불했습니다.',
      });
    } catch (error) {
      setJob((current) => ({
        ...current,
        error: error.message || '작업 취소 중 오류가 발생했습니다.',
      }));
    } finally {
      setIsCancelling(false);
    }
  }, [isCancelling, job.activeJobId, token, updateCredits, user?.id]);

  const clearError = useCallback(() => {
    setJob((current) => (
      current.status === 'error'
        ? createIdleState(current.ownerId)
        : { ...current, error: '' }
    ));
  }, []);

  const openResult = useCallback(() => {
    const result = notice?.result || job.result;
    if (!result) return;
    setNotice(null);
    navigate('/result', { state: result });
  }, [job.result, navigate, notice?.result]);

  useEffect(() => {
    const shouldWarn = job.status === 'uploading'
      || (job.status === 'processing' && !job.activeJobId && !job.activeOperationKey);
    if (!shouldWarn) return;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [job.activeJobId, job.activeOperationKey, job.status]);

  const isBusy = BUSY_STATUSES.has(job.status);

  return (
    <TranscriptionContext.Provider value={{
      ...job,
      isBusy,
      isCancelling,
      startTranscription,
      cancelDiarization,
      cancelOperation,
      retryOperationStatus,
      startNewOperation,
      clearError,
      openResult,
    }}>
      {children}

      {notice && (
        <aside
          className={`transcription-notice transcription-notice--${notice.type}`}
          role={notice.type === 'error' ? 'alert' : 'status'}
          aria-live={notice.type === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          <span className="transcription-notice__mark" aria-hidden="true">
            {notice.type === 'success' ? '✓' : '!'}
          </span>
          <div className="transcription-notice__content">
            <strong>{notice.title}</strong>
            <p>{notice.message}</p>
          </div>
          <div className="transcription-notice__actions">
            {notice.result && location.pathname !== '/result' && (
              <button type="button" className="button button--primary" onClick={openResult}>
                결과 보기
              </button>
            )}
            <button
              type="button"
              className="icon-button transcription-notice__close"
              onClick={() => setNotice(null)}
              aria-label="변환 알림 닫기"
              title="닫기"
            >
              ×
            </button>
          </div>
        </aside>
      )}
    </TranscriptionContext.Provider>
  );
}

export function useTranscription() {
  const context = useContext(TranscriptionContext);
  if (!context) throw new Error('useTranscription must be used within TranscriptionProvider');
  return context;
}
