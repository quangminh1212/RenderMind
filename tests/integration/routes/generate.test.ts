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

describe('Generate API', () => {
  let app: express.Application;

  beforeAll(() => {
    app = createApp();
  });

  it('POST /api/v1/generate should return 400 without prompt', async () => {
    const response = await request(app).post('/api/v1/generate').send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/generate should accept valid prompt', async () => {
    const response = await request(app)
      .post('/api/v1/generate')
      .send({
        prompt: 'A beautiful sunset',
        width: 512,
        height: 512,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('id');
    expect(response.body).toHaveProperty('status');
  });

  it('POST /api/v1/generate should return 400 for invalid width', async () => {
    const response = await request(app)
      .post('/api/v1/generate')
      .send({
        prompt: 'test',
        width: 10,
      });

    expect(response.status).toBe(400);
  });

  it('GET /api/v1/status/:id should return 404 for unknown id', async () => {
    const response = await request(app).get('/api/v1/status/gen_unknown123');

    expect(response.status).toBe(404);
  });

  it('GET /api/v1/backends should list backends', async () => {
    const response = await request(app).get('/api/v1/backends');

    expect(response.status).toBe(200);
    expect(response.body.backends).toBeDefined();
    expect(Array.isArray(response.body.backends)).toBe(true);
  });
});
