import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing
vi.mock('../../../src/config', () => ({
  getConfig: vi.fn(() => ({
    server: { port: 3000, host: '0.0.0.0', nodeEnv: 'test' },
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
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../../../src/services/webhook.service', () => ({
  webhookService: {
    deliver: vi.fn().mockResolvedValue(undefined),
  },
}));

import { BackendService } from '../../../src/services/backend.service';

describe('BackendService', () => {
  let service: BackendService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BackendService();
  });

  describe('generate', () => {
    it('should return error when no backends are available', async () => {
      const result = await service.generate({
        prompt: 'test prompt',
        width: 1024,
        height: 1024,
        steps: 30,
        cfg_scale: 7.5,
        backend: 'auto',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('No available backend');
    });
  });

  describe('getStatus', () => {
    it('should return null for non-existent id', () => {
      const result = service.getStatus('gen_nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getBackends', () => {
    it('should return list of backends', () => {
      const backends = service.getBackends();
      expect(backends).toHaveLength(3);
      expect(backends[0].name).toBe('stability');
      expect(backends[1].name).toBe('openclaw');
      expect(backends[2].name).toBe('replicate');
    });

    it('should show backends as unavailable when not configured', () => {
      const backends = service.getBackends();
      backends.forEach((b) => {
        expect(b.status).toBe('unavailable');
      });
    });
  });
});
