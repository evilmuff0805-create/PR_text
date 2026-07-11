import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getDiarizationJobForUser, isDiarizationJobId } from '../services/diarization-jobs.js';

const router = Router();

router.get('/:jobId', authMiddleware, async (req, res, next) => {
  try {
    if (!isDiarizationJobId(req.params.jobId)) {
      return res.status(400).json({ error: '유효하지 않은 작업 ID입니다.' });
    }

    const job = await getDiarizationJobForUser(req.params.jobId, req.user.id);
    if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });

    res.json(job);
  } catch (error) {
    next(error);
  }
});

export default router;
