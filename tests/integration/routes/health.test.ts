import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app';
import { useFakeEngine, FakeProvider, useTestConfig } from '../../helpers/harness';

/**
 * Health endpoint tests.
 *
 * The previous suite asserted that a Redis-less deployment returns 503, which locked in
 * the wrong contract: Redis is an optional dependency, so a perfectly healthy
 * single-provider deployment was reported as degraded and its container marked
 * unhealthy by the Dockerfile HEALTHCHECK.
 *
 * These tests pin the corrected split:
 *   /healthz — liveness, always 200
 *   /readyz  — readiness, 200 when >= 1 provider is available
 */

let redisConnected = false;

vi.mock('../../../src/services/cache.service', () => ({
  cacheService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    read: vi.fn().mockResolvedValue({ outcome: 'miss' }),
    write: vi.fn().mockResolvedValue(true),
    delete: vi.fn(),
    isConnected: vi.fn(() => redisConnected),
    getStats: vi.fn().mockReturnValue({
      hits: 1,
      misses: 2,
      errors: 0,
      writes: 3,
      writeFailures: 0,
    }),
  },
}));

describe('Health API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    redisConnected = false;
    useTestConfig();
  });

  describe('GET /healthz (liveness)', () => {
    it('returns 200 even without Redis', async () => {
      useFakeEngine([new FakeProvider()]);
      app = createApp();

      const res = await request(app).get('/healthz');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('returns 200 even when no provider is configured', async () => {
      // Liveness is about the process, not about dependencies.
      useFakeEngine([]);
      app = createApp();

      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
    });

    it('reports a version read from package.json rather than npm_package_version', async () => {
      useFakeEngine([new FakeProvider()]);
      // npm_package_version is unset when running `node dist/index.js`, which made the
      // old endpoint silently report a hardcoded value.
      const original = process.env.npm_package_version;
      delete process.env.npm_package_version;

      app = createApp();
      const res = await request(app).get('/healthz');

      expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);

      if (original !== undefined) process.env.npm_package_version = original;
    });
  });

  describe('GET /readyz (readiness)', () => {
    it('returns 200 with a provider available and no Redis', async () => {
      useFakeEngine([new FakeProvider()]);
      app = createApp();

      const res = await request(app).get('/readyz');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      // Redis absence is reported, but does not make the service unready.
      expect(res.body.checks.redis.connected).toBe(false);
      expect(res.body.checks.redis.ok).toBe(true);
    });

    it('returns 503 when no provider is available', async () => {
      useFakeEngine([]);
      app = createApp();

      const res = await request(app).get('/readyz');

      expect(res.status).toBe(503);
      expect(res.body.checks.providers.ok).toBe(false);
    });

    it('returns 503 when Redis is required by config and is down', async () => {
      useTestConfig({ HEALTH_REQUIRE_REDIS: 'true' });
      useFakeEngine([new FakeProvider()]);
      app = createApp();

      const res = await request(app).get('/readyz');

      expect(res.status).toBe(503);
      expect(res.body.checks.redis.required).toBe(true);
    });

    it('reports per-provider detail including breaker state', async () => {
      useFakeEngine([new FakeProvider()]);
      app = createApp();

      const res = await request(app).get('/readyz');

      expect(res.body.checks.providers.details[0]).toMatchObject({
        name: 'fake',
        status: 'available',
        breaker: 'closed',
      });
    });

    it('includes cache statistics', async () => {
      useFakeEngine([new FakeProvider()]);
      app = createApp();

      const res = await request(app).get('/readyz');
      expect(res.body.cache).toMatchObject({ hits: 1, misses: 2 });
    });
  });

  describe('GET /health (backwards-compatible alias)', () => {
    it('returns 200 and includes dependency detail', async () => {
      useFakeEngine([new FakeProvider()]);
      app = createApp();

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.dependencies).toBeDefined();
      expect(res.body.dependencies.providers).toBeDefined();
    });
  });

  describe('GET /metrics', () => {
    it('exposes Prometheus metrics', async () => {
      useFakeEngine([new FakeProvider()]);
      app = createApp();

      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.text).toContain('rendermind_');
    });
  });
});
