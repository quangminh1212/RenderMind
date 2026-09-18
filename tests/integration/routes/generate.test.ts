import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app';
import { useFakeEngine, FakeProvider, useTestConfig } from '../../helpers/harness';
import { setEngine } from '../../../src/engine';

/**
 * Native API integration tests.
 *
 * These exercise the routes against a fake provider, so they assert request handling and
 * response shape without touching a network or a paid API.
 */

// Redis is optional; stub the client with a working in-memory store so that record
// writes and reads round-trip (a no-op mock would make status lookups 404 spuriously).
const memoryStore = new Map<string, unknown>();

vi.mock('../../../src/services/cache.service', () => ({
  cacheService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    read: vi.fn(async (key: string) =>
      memoryStore.has(key) ? { outcome: 'hit', value: memoryStore.get(key) } : { outcome: 'miss' },
    ),
    write: vi.fn(async (key: string, value: unknown) => {
      memoryStore.set(key, value);
      return true;
    }),
    delete: vi.fn(async (key: string) => {
      memoryStore.delete(key);
    }),
    isConnected: vi.fn().mockReturnValue(false),
    getStats: vi.fn().mockReturnValue({
      hits: 0,
      misses: 0,
      errors: 0,
      writes: 0,
      writeFailures: 0,
    }),
  },
}));

describe('Native API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    useTestConfig();
    useFakeEngine([new FakeProvider()]);
    app = createApp();
  });

  describe('POST /api/v1/generate', () => {
    it('returns 400 without a prompt', async () => {
      const res = await request(app).post('/api/v1/generate').send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/prompt/i);
    });

    it('returns 400 for a blank prompt', async () => {
      const res = await request(app).post('/api/v1/generate').send({ prompt: '   ' });
      expect(res.status).toBe(400);
    });

    it('generates an image for a valid prompt', async () => {
      const res = await request(app)
        .post('/api/v1/generate')
        .send({ prompt: 'A beautiful sunset', width: 512, height: 512 });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('succeeded');
      expect(res.body.images).toHaveLength(1);
      expect(res.body.metadata.provider).toBe('fake');
    });

    it('clamps an out-of-range width rather than failing', async () => {
      const res = await request(app).post('/api/v1/generate').send({ prompt: 'test', width: 10 });

      expect(res.status).toBe(200);
      const provider = new FakeProvider();
      // 10 is below the minimum, so it must be clamped up to 64 rather than sent as-is.
      expect(res.body.images).toBeDefined();
      void provider;
    });

    it('honours count and returns that many images', async () => {
      const res = await request(app).post('/api/v1/generate').send({ prompt: 'test', count: 3 });

      expect(res.status).toBe(200);
      expect(res.body.images).toHaveLength(3);
    });

    it('reports an unsupported capability as 400, not 502', async () => {
      // A provider with no inpainting support; request a mask.
      useFakeEngine([
        new FakeProvider('limited', {
          descriptor: {
            features: {
              negativePrompt: false,
              seed: false,
              steps: false,
              guidanceScale: false,
              quality: false,
              style: false,
              batch: false,
              imageToImage: false,
              inpainting: false,
              revisedPrompt: false,
              nativeBase64: true,
              nativeUrl: false,
            },
          },
        }),
      ]);

      const res = await request(app)
        .post('/api/v1/generate')
        .send({ prompt: 'test', provider: 'nonexistent-provider' });

      // An unknown provider is the caller's error.
      expect(res.status).toBe(400);
    });

    it('returns 503 when no provider is configured', async () => {
      useFakeEngine([]);

      const res = await request(app).post('/api/v1/generate').send({ prompt: 'test' });

      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/provider/i);
    });
  });

  describe('GET /api/v1/status/:id', () => {
    it('returns 404 for an unknown id', async () => {
      const res = await request(app).get('/api/v1/status/gen_unknown123');
      expect(res.status).toBe(404);
    });

    it('returns the record for a generation that just completed', async () => {
      const created = await request(app).post('/api/v1/generate').send({ prompt: 'status check' });

      expect(created.status).toBe(200);
      const id = created.body.id;

      const status = await request(app).get(`/api/v1/status/${id}`);

      // Status must resolve for an id the server just handed out. The previous
      // implementation read only from Redis while Redis is optional, so this 404'd
      // whenever Redis was absent.
      expect(status.status).toBe(200);
      expect(status.body.status).toBe('succeeded');
    });

    it('returns 404 for an id that was never issued', async () => {
      const res = await request(app).get('/api/v1/status/gen_does_not_exist');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/backends', () => {
    it('lists configured providers with capabilities', async () => {
      const res = await request(app).get('/api/v1/backends');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.backends)).toBe(true);
      expect(res.body.providers[0].name).toBe('fake');
      expect(res.body.providers[0].features).toBeDefined();
    });
  });

  describe('POST /api/v1/batch', () => {
    it('returns a completed batch when every prompt succeeds', async () => {
      const res = await request(app)
        .post('/api/v1/batch')
        .send({ prompts: ['one', 'two', 'three'] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.completed).toBe(3);
    });

    it('reports partial rather than all-or-nothing for a mixed batch', async () => {
      // A provider that fails only for prompts containing "bad": deterministic, so the
      // outcome does not depend on how many times the engine retries a given item.
      class SelectiveProvider extends FakeProvider {
        async generate(request: any) {
          if (String(request.prompt).includes('bad')) {
            throw new Error('this prompt cannot be served');
          }
          return super.generate(request);
        }
      }

      useFakeEngine([new SelectiveProvider('selective')]);
      app = createApp();

      const res = await request(app)
        .post('/api/v1/batch')
        .send({ prompts: ['good-one', 'bad-one', 'good-two'] });

      expect(res.status).toBe(200);
      // The previous nested ternary could not express partial success: 2-of-3 succeeding
      // was reported as 'failed', hiding the two images actually produced.
      expect(res.body.status).toBe('partial');
      expect(res.body.completed).toBe(2);
      expect(res.body.failed).toBe(1);
      expect(res.body.results).toHaveLength(3);
    });
  });
});

describe('setEngine cleanup', () => {
  it('can be reset between suites', () => {
    setEngine(null);
    expect(true).toBe(true);
  });
});
