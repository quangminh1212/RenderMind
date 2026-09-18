import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../../src/config', () => ({
  getConfig: vi.fn(() => ({
    server: { port: 3000, host: '0.0.0.0', nodeEnv: 'test' },
    auth: { apiKeyHeader: 'x-api-key', apiKeys: [], enabled: false },
    cors: { origins: ['*'] },
    backends: {
      stability: { enabled: false, apiKey: '', apiHost: '' },
      openclaw: { enabled: false, apiKey: '' },
      replicate: { enabled: false, apiToken: '' },
    },
    cache: { ttl: 3600 },
    redis: { url: 'redis://localhost:6379' },
    queue: { concurrency: 5 },
    rateLimit: { windowMs: 60000, maxRequests: 60 },
    webhook: {},
  })),
}));

vi.mock('../../../src/services/cache.service', () => ({
  cacheService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    del: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../../../src/services/queue.service', () => ({
  queueService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isAvailable: vi.fn().mockReturnValue(false),
  },
}));

import { createApp } from '../../../src/app';

describe('Health API', () => {
  let app: express.Application;

  beforeAll(() => {
    app = createApp();
  });

  it('GET /health should return 503 when deps are down', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body).toHaveProperty('version');
    expect(response.body).toHaveProperty('uptime');
  });

  it('GET /health should include dependency info', async () => {
    const response = await request(app).get('/health');
    expect(response.body.dependencies).toBeDefined();
    expect(response.body.dependencies.redis).toBe('disconnected');
  });

  it('GET /health should include memory info', async () => {
    const response = await request(app).get('/health');
    expect(response.body.memory).toBeDefined();
    expect(response.body.memory.rss_mb).toBeGreaterThan(0);
  });

  it('GET /health should include backend info', async () => {
    const response = await request(app).get('/health');
    expect(response.body.backends).toBeDefined();
    expect(response.body.backends.total).toBe(3);
    expect(response.body.backends.available).toBe(0);
  });
});
