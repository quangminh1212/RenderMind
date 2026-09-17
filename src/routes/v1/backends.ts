import { Router, Request, Response } from 'express';
import { backendService } from '../../services/backend.service';

const router = Router();

/**
 * @openapi
 * /api/v1/backends:
 *   get:
 *     tags: [Info]
 *     list: [Generation]
 *     summary: List available backends
 *     description: Get a list of all configured image generation backends and their status
 *     responses:
 *       200:
 *         description: List of backends
 */
router.get('/', (_req: Request, res: Response) => {
  const backends = backendService.getBackends();
  res.json({ backends });
});

export default router;
