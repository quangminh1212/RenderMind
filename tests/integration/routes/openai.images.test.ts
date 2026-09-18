import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter, useFakeEngine, FakeProvider, useTestConfig } from '../../helpers/harness';
import imagesRouter from '../../../src/adapters/openai/images.router';
import { ProviderError } from '../../../src/engine/errors';

describe('openclaw images bridge', () => {
  let app: ReturnType<typeof mountRouter>;

  beforeEach(() => {
    useTestConfig();
    useFakeEngine([new FakeProvider()]);
    app = mountRouter('/v1/images/generations', imagesRouter);
  });

  describe('validation and error envelopes', () => {
    it('returns the openclaw error envelope for a missing prompt', async () => {
      const res = await request(app).post('/v1/images/generations').send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBeDefined();
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.statusCode).toBeUndefined();
    });

    it('rejects a malformed size instead of parsing NaN', async () => {
      const res = await request(app)
        .post('/v1/images/generations')
        .send({ prompt: 'x', size: '1024' });

      expect(res.status).toBe(400);
    });

    it('rejects an unsupported quality value with 400', async () => {
      const res = await request(app)
        .post('/v1/images/generations')
        .send({ prompt: 'x', model: 'dall-e-3', quality: 'ultra-mega' });

      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('quality');
    });

    it('enforces the model-specific n constraint for dall-e-3', async () => {
      // dall-e-3 accepts only n=1; the previous code quietly generated one image.
      const res = await request(app)
        .post('/v1/images/generations')
        .send({ prompt: 'x', model: 'dall-e-3', n: 3 });

      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('n');
    });
  });

  describe('n > 1 fan-out', () => {
    it('returns exactly n data items', async () => {
      const res = await request(app).post('/v1/images/generations').send({ prompt: 'x', n: 3 });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });

    it('dispatches n generations concurrently, not serially', async () => {
      let inFlight = 0;
      let peak = 0;

      class SlowProvider extends FakeProvider {
        async generate(request: any) {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          return super.generate(request);
        }
      }

      useFakeEngine([new SlowProvider()]);
      app = mountRouter('/v1/images/generations', imagesRouter);

      await request(app).post('/v1/images/generations').send({ prompt: 'x', n: 4 });

      expect(peak).toBeGreaterThan(1);
    });

    it('uses distinct seeds across sub-jobs so images actually differ', async () => {
      const provider = new FakeProvider();
      useFakeEngine([provider]);
      app = mountRouter('/v1/images/generations', imagesRouter);

      await request(app).post('/v1/images/generations').send({ prompt: 'x', n: 3, seed: 1000 });

      const seeds = provider.calls.map((c) => c.seed);
      expect(new Set(seeds).size).toBeGreaterThan(1);
    });
  });

  describe('response_format fidelity', () => {
    it('honours response_format url', async () => {
      useFakeEngine([
        new FakeProvider('url-only', {
          result: { images: [{ url: 'https://x/y.png', mime: 'image/png' }] },
        }),
      ]);
      app = mountRouter('/v1/images/generations', imagesRouter);

      const res = await request(app)
        .post('/v1/images/generations')
        .send({ prompt: 'x', response_format: 'url' });

      expect(res.status).toBe(200);
      expect(res.body.data[0].url).toBe('https://x/y.png');
    });

    it('omits the non-standard _rendermind block by default', async () => {
      const res = await request(app).post('/v1/images/generations').send({ prompt: 'x' });
      expect(res.body._rendermind).toBeUndefined();
    });
  });

  describe('provider outage vs capability gap', () => {
    it('reports an upstream outage as 503, not as a capability error', async () => {
      // A provider that always fails retryably trips the circuit breaker.
      const broken = new FakeProvider('always-down', {
        error: new ProviderError({
          provider: 'always-down',
          message: 'upstream is down',
          status: 503,
        }),
      });

      useFakeEngine([broken]);
      app = mountRouter('/v1/images/generations', imagesRouter);

      // Drive enough failures to open the breaker (threshold is 5 consecutive).
      let last: any;
      for (let i = 0; i < 12; i++) {
        last = await request(app).post('/v1/images/generations').send({ prompt: 'x' });
      }

      // Once every provider is tripped, the answer is a transient outage — never a
      // misleading 4xx telling the caller their request was wrong.
      expect(last.status).toBe(503);
      expect(last.headers['retry-after']).toBeDefined();
    }, 30000);
  });

  describe('size handling', () => {
    it('forwards an explicit size as width/height', async () => {
      const provider = new FakeProvider();
      useFakeEngine([provider]);
      app = mountRouter('/v1/images/generations', imagesRouter);

      await request(app).post('/v1/images/generations').send({ prompt: 'x', size: '1792x1024' });

      expect(provider.calls[0].size).toEqual({ width: 1792, height: 1024 });
    });

    it('reports a provider failure with the upstream status preserved', async () => {
      useFakeEngine([
        new FakeProvider('teapot', {
          error: new ProviderError({
            provider: 'teapot',
            message: 'upstream says no',
            status: 429,
            // A short Retry-After keeps the test fast; the engine also caps waits and
            // enforces a per-sub-job deadline so an upstream cannot stall a request.
            retryAfterSeconds: 1,
          }),
        }),
      ]);
      app = mountRouter('/v1/images/generations', imagesRouter);

      const res = await request(app).post('/v1/images/generations').send({ prompt: 'x' });

      // A rate limit is not a server fault: it must not be flattened to 502.
      expect(res.status).toBe(429);
      expect(res.body.error.type).toBe('rate_limit_error');
    }, 20000);
  });
});
