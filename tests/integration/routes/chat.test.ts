import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app';
import { useFakeEngine, FakeProvider, useTestConfig, silenceLogs } from '../../helpers/harness';
import { ProviderError } from '../../../src/engine/errors';

/**
 * Integration tests for the public generation surface.
 *
 * RenderMind exposes exactly two image endpoints — `/chat` and `/vision` — and they share
 * one translation path and one error envelope. These tests pin the caller-visible contract
 * of that surface: validation, the canonical translation, delivery strictness, and the
 * status each failure class maps to.
 */

vi.mock('../../../src/services/cache.service', () => ({
  cacheService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    read: vi.fn().mockResolvedValue({ outcome: 'miss' }),
    write: vi.fn().mockResolvedValue(true),
    delete: vi.fn(),
    isConnected: vi.fn(() => false),
    getStats: vi
      .fn()
      .mockReturnValue({ hits: 0, misses: 0, errors: 0, writes: 0, writeFailures: 0 }),
  },
}));

describe('POST /chat', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    useTestConfig();
    useFakeEngine([new FakeProvider()]);
    app = createApp();
  });

  it('generates one image from a prompt', async () => {
    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe('image.generation');
    expect(res.body.provider).toBe('fake');
    expect(res.body.images).toHaveLength(1);
    // base64 is the default delivery.
    expect(res.body.images[0].base64).toBeTruthy();
    expect(res.body.images[0].mime).toBe('image/png');
  });

  it('rejects a missing prompt with 400 and the chat envelope', async () => {
    const res = await request(app).post('/chat').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.message).toMatch(/prompt/i);
  });

  it('rejects a malformed size', async () => {
    const res = await request(app).post('/chat').send({ prompt: 'x', size: 'big' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/size/i);
  });

  it('honours count by fanning out into distinct images', async () => {
    const provider = new FakeProvider();
    useFakeEngine([provider]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(3);
    expect(provider.calls).toHaveLength(3);
  });

  it('returns a data URI when url delivery is requested', async () => {
    const res = await request(app).post('/chat').send({ prompt: 'x', response_format: 'url' });

    expect(res.status).toBe(200);
    expect(res.body.images[0].url).toMatch(/^data:image\/png;base64,/);
    expect(res.body.images[0].base64).toBeUndefined();
  });

  it('refuses input images with a pointer to /vision', async () => {
    const res = await request(app)
      .post('/chat')
      .send({ prompt: 'x', images: ['data:image/png;base64,AAAA'] });

    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe('images');
    expect(res.body.error.message).toMatch(/\/vision/);
  });

  it('reports a terminal unsupported_output as 422', async () => {
    useFakeEngine([
      new FakeProvider('fake', {
        error: new ProviderError({
          provider: 'fake',
          message: 'Model returned text only',
          code: 'unsupported_output',
          retryable: false,
        }),
      }),
    ]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_output');
  });

  it('reports an upstream 5xx as 502', async () => {
    useFakeEngine([
      new FakeProvider('fake', {
        error: new ProviderError({ provider: 'fake', message: 'boom', status: 500 }),
      }),
    ]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe('server_error');
  });

  it('reports a client-side upstream error as 400', async () => {
    useFakeEngine([
      new FakeProvider('fake', {
        error: new ProviderError({ provider: 'fake', message: 'bad prompt', status: 400 }),
      }),
    ]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(400);
  });

  it('reports 503 when no provider is configured', async () => {
    useFakeEngine([]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('no_provider_configured');
  });
});

describe('POST /vision', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    useTestConfig();
    useFakeEngine([new FakeProvider()]);
    app = createApp();
  });

  it('accepts a base64 data URI as an input image', async () => {
    const data = Buffer.from('input-image').toString('base64');
    const res = await request(app)
      .post('/vision')
      .send({ prompt: 'make it blue', images: [`data:image/png;base64,${data}`] });

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(1);
  });

  it('requires at least one image', async () => {
    const res = await request(app).post('/vision').send({ prompt: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/images/i);
  });

  it('rejects a remote URL rather than fetching it', async () => {
    const res = await request(app)
      .post('/vision')
      .send({ prompt: 'x', images: ['https://example.com/a.png'] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/base64 data URI/i);
  });

  it('rejects more than four input images', async () => {
    const data = Buffer.from('x').toString('base64');
    const res = await request(app)
      .post('/vision')
      .send({ prompt: 'x', images: Array(5).fill(`data:image/png;base64,${data}`) });

    expect(res.status).toBe(400);
  });

  it('passes the input images through to the provider', async () => {
    const provider = new FakeProvider();
    useFakeEngine([provider]);
    app = createApp();

    const data = Buffer.from('input-image').toString('base64');
    await request(app)
      .post('/vision')
      .send({ prompt: 'edit this', images: [`data:image/png;base64,${data}`] });

    expect(provider.calls[0].referenceImages).toHaveLength(1);
    expect(provider.calls[0].referenceImages?.[0].data).toBe(data);
    expect(provider.calls[0].metadata?.source).toBe('vision');
  });
});
