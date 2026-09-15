import { Router } from 'express';
import uploadMiddleware from '../middleware/upload.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  cancelQueuedTranscriptionOperation,
  createAndQueueTranscriptionOperation,
  getTranscriptionOperationByKeyForUser,
  getTranscriptionOperationForUser,
  isOperationKey,
  isTranscriptionOperationId,
} from '../services/transcription-operations.js';

const router = Router();

function upload(req, res, next) {
  uploadMiddleware(req, res, next);
}

router.post('/', authMiddleware, upload, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '오디오 파일이 필요합니다.' });
    const operationKey = req.get('X-Transcription-Operation-Key');
    if (!isOperationKey(operationKey)) return res.status(400).json({ error: '유효하지 않은 변환 작업 키입니다.' });
    const language = req.body.language || null;
    try {
      const queued = await createAndQueueTranscriptionOperation({
        userId: req.user.id, operationKey, buffer: req.file.buffer, filename: req.file.originalname,
        contentType: req.file.mimetype, language,
      });
      console.log('[transcription.operation.accepted]', JSON.stringify({
        requestId: req.requestId, operationId: queued.operationId, existing: queued.existing,
        responseClosed: res.writableEnded,
      }));
      return res.status(202).json({ operationId: queued.operationId, status: queued.status, creditsRemaining: queued.creditsRemaining });
    } catch (error) {
      // Keep formats whose duration cannot be read on the existing synchronous
      // route until a separately reviewed provisional-reservation design exists.
      if (['DURATION_UNKNOWN', 'LEGACY_MODE'].includes(error.code)) {
        return res.status(409).json({
          error: '파일 길이를 확인하지 못해 기존 변환 방식으로 전환합니다.', legacyFallback: true,
        });
      }
      if (error.code === 'TO429') return res.status(429).json({ error: error.message });
      if (error.status === 402) return res.status(402).json({ error: error.message, creditsNeeded: error.creditsNeeded, creditsHave: req.user.credits });
      if (error.status === 409 || error.code === 'TO409') return res.status(409).json({ error: error.message, conflict: true });
      throw error;
    }
  } catch (error) { next(error); }
});

router.get('/by-key/:operationKey', authMiddleware, async (req, res, next) => {
  try {
    if (!isOperationKey(req.params.operationKey)) return res.status(400).json({ error: '유효하지 않은 작업 키입니다.' });
    const operation = await getTranscriptionOperationByKeyForUser(req.params.operationKey, req.user.id);
    if (!operation) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
    res.json(operation);
  } catch (error) { next(error); }
});

router.get('/:operationId', authMiddleware, async (req, res, next) => {
  try {
    if (!isTranscriptionOperationId(req.params.operationId)) return res.status(400).json({ error: '유효하지 않은 작업 ID입니다.' });
    const operation = await getTranscriptionOperationForUser(req.params.operationId, req.user.id);
    if (!operation) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
    res.json(operation);
  } catch (error) { next(error); }
});

router.delete('/:operationId', authMiddleware, async (req, res, next) => {
  try {
    if (!isTranscriptionOperationId(req.params.operationId)) return res.status(400).json({ error: '유효하지 않은 작업 ID입니다.' });
    const cancelled = await cancelQueuedTranscriptionOperation(req.params.operationId, req.user.id);
    if (!cancelled) return res.status(409).json({ error: '이미 완료되었거나 취소할 수 없는 작업입니다.' });
    res.status(202).json({ status: 'cancelled', creditsRemaining: cancelled.credits_remaining, creditsRestored: cancelled.credits_restored });
  } catch (error) { next(error); }
});

export default router;