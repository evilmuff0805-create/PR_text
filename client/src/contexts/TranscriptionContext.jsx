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
    result: null,
  };
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

function resultFromResponse(data, diarize) {
  return {
    text: data.text,
    segments: data.segments,
    language: data.language,
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

  const startTranscription = useCallback(async ({ file, language, diarize }) => {
    if (!user?.id || BUSY_STATUSES.has(job.status)) return;

    setNotice(null);
    setJob({
      ...createIdleState(user.id),
      status: 'uploading',
      progress: '파일 업로드 중... 0%',
      activeDiarize: diarize,
    });

    try {
      const formData = new FormData();
      formData.append('audio', file);
      if (language) formData.append('language', language);
      if (diarize) formData.append('diarize', 'true');

      const currentToken = getToken();
      const { status, ok, data, requestId } = await uploadTranscription({
        formData,
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

      if (status === 401) {
        throw new Error('로그인이 필요합니다. 좌측 사이드바에서 로그인해주세요.');
      }
      if (status === 402) {
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
      failTranscription(error.message || '오류가 발생했습니다.');
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
      || (job.status === 'processing' && !job.activeJobId);
    if (!shouldWarn) return;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [job.activeJobId, job.status]);

  const isBusy = BUSY_STATUSES.has(job.status);

  return (
    <TranscriptionContext.Provider value={{
      ...job,
      isBusy,
      isCancelling,
      startTranscription,
      cancelDiarization,
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
