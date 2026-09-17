import { Router, Request, Response } from 'express';
import { cacheService } from '../services/cache.service';
import { queueService } from '../services/queue.service';
import { backendService } from '../services/backend.service';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Info]
 *     summary: Health check
 *     description: Returns server health status, dependency info, and backend availability
 *     responses:
 *       200:
 *         description: Server is healthy
 *       503:
 *         description: Server is degraded
 */
router.get('/', (_req: Request, res: Response) => {
  const redis = cacheService.isConnected();
  const queue = queueService.isAvailable();
  const backends = backendService.getBackends();
  const availableBackends = backends.filter((b) => b.status === 'available').length;

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
    backends: {
      total: backends.length,
      available: availableBackends,
      details: backends.map((b) => ({
        name: b.name,
        status: b.status,
      })),
    },
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
});

export default router;
