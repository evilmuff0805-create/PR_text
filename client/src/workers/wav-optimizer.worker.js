import { optimizeWavBlob } from '../utils/wav-optimization-core.js';

self.onmessage = async (event) => {
  if (event.data?.type !== 'optimize') return;

  try {
    const result = await optimizeWavBlob(event.data.file, {
      maxOutputBytes: event.data.maxOutputBytes,
      onProgress: (progress) => {
        self.postMessage({ type: 'progress', progress });
      },
    });
    self.postMessage({
      type: 'complete',
      blob: result.blob,
      metadata: result.metadata,
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      code: error?.code || 'WAV_OPTIMIZATION_FAILED',
      message: error?.message || 'WAV 파일을 최적화하지 못했습니다.',
    });
  }
};
