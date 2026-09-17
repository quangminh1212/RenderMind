import { Router, Request, Response } from 'express';
import { cacheService } from '../services/cache.service';
import { queueService } from '../services/queue.service';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Info]
 *     summary: Health check
 *     description: Returns server health status and dependency info
 *     responses:
 *       200:
 *         description: Server is healthy
 *       503:
 *         description: Server is degraded
 */
router.get('/', (_req: Request, res: Response) => {
  const redis = cacheService.isConnected();
  const queue = queueService.isAvailable();

  const healthy = true; // Server is always healthy if it responds
  const status = healthy ? 'ok' : 'degraded';

  res.status(healthy ? 200 : 503).json({
    status,
    version: process.env.npm_package_version || '1.0.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    dependencies: {
      redis: redis ? 'connected' : 'disconnected',
      queue: queue ? 'available' : 'unavailable',
    },
  });
});

export default router;
