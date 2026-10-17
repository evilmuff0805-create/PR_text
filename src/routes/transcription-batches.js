import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import uploadMiddleware from '../middleware/upload.js';
import { isBatchId } from '../services/transcription-batches.js';
import { createBatchSrtArchive } from '../services/batch-archive.js';

const ERROR_STATUS = { TB400: 400, TB404: 404, TB409: 409, TB429: 429, TB402: 402, TO409: 409, TO429: 429 };

export function createTranscriptionBatchesRouter({
  service, authenticate = authMiddleware, upload = uploadMiddleware, archive = createBatchSrtArchive,
} = {}) {
  if (!service) throw new TypeError('Batch service is required');
  const router = Router();
  router.use(authenticate);
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const handle = callback => async (req, res, next) => {
    try { await callback(req, res, next); }
    catch (error) {
      const status = ERROR_STATUS[error.code] || error.status;
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        return res.status(status).json({ error: error.message, code: error.code, ...(Number.isFinite(error.creditsNeeded) ? { creditsNeeded: error.creditsNeeded } : {}) });
      }
      if (status === 503) {
        const safeCode = ['BATCH_ADMISSIONS_DISABLED', 'BATCH_UNAVAILABLE'].includes(error.code) ? error.code : 'BATCH_UNAVAILABLE';
        return res.status(503).json({ error: safeCode === error.code ? error.message : '묶음 작업 연결을 확인하지 못했습니다. 같은 작업으로 다시 확인해 주세요.', code: safeCode });
      }
      next(error);
    }
  };
  const checkIds = (req, res, next) => {
    if (!isBatchId(req.params.batchId) || (req.params.itemId !== undefined && !isBatchId(req.params.itemId))) {
      return res.status(400).json({ error: '묶음 또는 파일 번호를 확인해 주세요.' });
    }
    next();
  };
  const parseUpload = (req, res, next) => upload(req, res, error => {
    if (!error) return next();
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '파일당 업로드 한도는 150MiB입니다.' : '오디오 파일 형식과 업로드 내용을 확인해 주세요.' });
  });

  router.get('/', handle(async (req, res) => res.json(await service.list(req.user.id))));
  router.post('/', handle(async (req, res) => {
    const { batchKey, language, files } = req.body || {};
    const created = await service.create({ userId: req.user.id, batchKey, language, files });
    res.status(created.existing ? 200 : 201).json(created);
  }));
  router.get('/:batchId', checkIds, handle(async (req, res) => {
    const batch = await service.get(req.params.batchId, req.user.id);
    if (!batch) return res.status(404).json({ error: '묶음 작업을 찾을 수 없습니다.' });
    res.json({ batch });
  }));
  router.post('/:batchId/items/:itemId/audio', checkIds, handle(async (req, res, next) => {
    // Check ownership before buffering a potentially large multipart file.
    const batch = await service.get(req.params.batchId, req.user.id);
    if (!batch || !batch.items?.some(item => item.id === req.params.itemId)) {
      return res.status(404).json({ error: '묶음 파일을 찾을 수 없습니다.' });
    }
    next();
  }), parseUpload, handle(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '오디오 파일을 선택해 주세요.' });
    const batch = await service.upload({ userId: req.user.id, batchId: req.params.batchId, itemId: req.params.itemId,
      buffer: req.file.buffer, filename: req.file.originalname, contentType: req.file.mimetype });
    res.status(202).json({ batch });
  }));
  router.post('/:batchId/start', checkIds, handle(async (req, res) => {
    const { requestId, expectedCredits } = req.body || {};
    if (!isBatchId(requestId) || !Number.isInteger(expectedCredits) || expectedCredits < 1) {
      return res.status(400).json({ error: '요청 번호와 확인한 사용 시간을 확인해 주세요.' });
    }
    const batch = await service.start({ userId: req.user.id, batchId: req.params.batchId, requestId, expectedCredits });
    res.status(202).json({ batch });
  }));
  router.post('/:batchId/items/:itemId/retry', checkIds, handle(async (req, res) => {
    const { requestId } = req.body || {};
    if (!isBatchId(requestId)) return res.status(400).json({ error: '재시도 요청 번호를 확인해 주세요.' });
    const batch = await service.retry({ userId: req.user.id, batchId: req.params.batchId, itemId: req.params.itemId, requestId });
    res.status(202).json({ batch });
  }));
  router.delete('/:batchId', checkIds, handle(async (req, res) => {
    const batch = await service.cancel(req.params.batchId, req.user.id);
    res.status(202).json({ batch });
  }));
  router.post('/:batchId/archive', checkIds, handle(async (req, res) => {
    const allowPartial = req.body?.allowPartial ?? false;
    if (typeof allowPartial !== 'boolean') return res.status(400).json({ error: '부분 다운로드 선택을 확인해 주세요.' });
    const items = await service.archiveItems(req.params.batchId, req.user.id);
    if (!items) return res.status(404).json({ error: '묶음 작업을 찾을 수 없습니다.' });
    const result = archive({ items, allowPartial });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Completed-Files', String(result.completedCount));
    res.send(result.buffer);
  }));
  return router;
}
