import { Router, Request, Response } from 'express';
import { cacheService } from '../services/cache.service';
import { getEngine } from '../engine';
import { circuitBreaker, OPEN_DURATION_MS } from '../platform/http.client';
import { getConfig } from '../config';
import { availableProviders, breakerState } from '../platform/metrics';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Liveness and readiness.
 *
 * The audit found the single `/health` endpoint conflating the two: it returned 503
 * whenever Redis was unreachable, even though Redis is an optional dependency and the
 * service is fully functional without it. Since the Dockerfile's HEALTHCHECK consumed
 * the same endpoint, a correctly configured Redis-less deployment was marked unhealthy
 * and restarted.
 *
 *   /healthz — the process is alive. Always 200 while the event loop is running.
 *   /readyz  — the process can serve generation traffic (>= 1 provider available).
 *              Optional dependencies are reported as degraded components, not failures.
 *   /health  — retained as an alias for backwards compatibility.
 */
const router = Router();

/** Read the real version rather than relying on npm_package_version, which is unset when
 * running `node dist/index.js` and silently drifted to a hardcoded value. */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return process.env.npm_package_version ?? '0.0.0';
  }
}

function livenessPayload() {
  return {
    status: 'ok',
    version: appVersion(),
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Readiness detail.
 *
 * `ready` depends only on whether any provider can actually serve a request. Redis and
 * the queue are reported for visibility, and only affect readiness when the operator has
 * explicitly opted in via HEALTH_REQUIRE_REDIS.
 */
function readinessPayload() {
  const config = getConfig();
  const redis = cacheService.isConnected();

  let providers: Array<{ name: string; status: string; models: number; breaker: string }> = [];
  let engineError: string | undefined;

  try {
    providers = getEngine()
      .registry.capabilityDescriptors()
      .map((d) => ({
        name: d.provider,
        status: d.status,
        models: d.models.length,
        breaker: circuitBreaker.state(d.provider),
      }));
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
  }

  const availableCount = providers.filter((p) => p.status === 'available').length;

  // Report breaker state as a gauge so an operator can alert on it.
  for (const provider of providers) {
    const value = provider.breaker === 'open' ? 2 : provider.breaker === 'half-open' ? 1 : 0;
    breakerState.set({ provider: provider.name }, value);
  }
  availableProviders.set(availableCount);

  const dependenciesOk = config.health.requireRedis ? redis : true;
  const ready = availableCount > 0 && dependenciesOk && !engineError;

  return {
    status: ready ? 'ready' : 'not_ready',
    version: appVersion(),
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      providers: {
        ok: availableCount > 0,
        available: availableCount,
        total: providers.length,
        details: providers,
      },
      redis: {
        // Optional by design: `ok` reflects configured intent, not mere absence.
        ok: !config.health.requireRedis || redis,
        required: config.health.requireRedis,
        connected: redis,
        mode: redis ? 'redis' : 'in-memory-fallback',
      },
      engine: { ok: !engineError, error: engineError },
    },
    cache: cacheService.getStats(),
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  };
}

/** Liveness — always 200 while the process is running. */
router.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json(livenessPayload());
});

/** Readiness — 200 only when at least one provider can serve traffic. */
router.get('/readyz', (_req: Request, res: Response) => {
  const payload = readinessPayload();
  res.status(payload.status === 'ready' ? 200 : 503).json(payload);
});

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Info]
 *     summary: Liveness check
 *     description: Always returns 200 while the process is running. Use /readyz for readiness.
 *     responses:
 *       200:
 *         description: Process is alive
 */
router.get('/', (_req: Request, res: Response) => {
  // Backwards-compatible alias: liveness semantics, with readiness detail attached so
  // existing dashboards keep working without being told the process is dead.
  res.status(200).json({
    ...livenessPayload(),
    ready: readinessPayload().status === 'ready',
    dependencies: readinessPayload().checks,
  });
});

export { OPEN_DURATION_MS };
export default router;
