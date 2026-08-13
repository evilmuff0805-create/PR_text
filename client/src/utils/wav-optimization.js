import { MAX_UPLOAD_BYTES } from './upload-validation.js';

function createAbortError() {
  const error = new Error('WAV 최적화가 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}

export function optimizeLargeWavForUpload(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new Error('이 브라우저는 대용량 WAV 자동 최적화를 지원하지 않습니다. WAV를 MP3로 변환한 뒤 다시 시도해주세요.'));
      return;
    }
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const worker = new Worker(
      new URL('../workers/wav-optimizer.worker.js', import.meta.url),
      { type: 'module' },
    );
    let settled = false;

    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', handleAbort);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = () => finish(() => reject(createAbortError()));

    worker.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'progress') {
        onProgress?.(message.progress);
        return;
      }
      if (message?.type === 'error') {
        const error = new Error(message.message || 'WAV 파일을 최적화하지 못했습니다.');
        error.code = message.code;
        finish(() => reject(error));
        return;
      }
      if (message?.type === 'complete') {
        const optimizedFile = new File([message.blob], file.name, {
          type: 'audio/wav',
          lastModified: file.lastModified,
        });
        finish(() => resolve({ file: optimizedFile, metadata: message.metadata }));
      }
    };
    worker.onerror = () => {
      finish(() => reject(new Error('WAV 최적화 작업을 시작하지 못했습니다. 잠시 후 다시 시도해주세요.')));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    worker.postMessage({
      type: 'optimize',
      file,
      maxOutputBytes: MAX_UPLOAD_BYTES,
    });
  });
}
