import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app';
import {
  useFakeEngine,
  FakeProvider,
  useTestConfig,
  silenceLogs,
  providerReturningContent,
} from '../../helpers/harness';
import { ProviderError } from '../../../src/engine/errors';

/**
 * End-to-end coverage of the SVG fallback across the real HTTP surface.
 *
 * The unit suites prove the parser and the gate in isolation. This one proves the thing the
 * feature actually promises: a text-only model's SVG reply travels through the real
 * `ChatProvider`, the real validator, the real rasterizer and the real response builder,
 * and arrives at a caller as a valid image payload — with the requested container honoured
 * and every refusal reported truthfully.
 *
 * The engine is still faked (no network, no credential, no cost), but the provider under
 * test is the production `ChatProvider` driven through a stubbed `fetch`, so nothing in the
 * path between the model's reply and the response body is mock behaviour.
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

/** The shape of drawing the instruction asks for. */
const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" fill="#3366cc"/>' +
  '<circle cx="32" cy="32" r="16" fill="#ffcc00"/>' +
  '</svg>';

/** Whether a base64 payload decodes to bytes carrying the PNG signature and IHDR chunk. */
function isPng(base64: unknown): boolean {
  if (typeof base64 !== 'string' || base64.length === 0) return false;
  const bytes = Buffer.from(base64, 'base64');
  return (
    bytes.byteLength > 16 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes.toString('latin1', 12, 16) === 'IHDR'
  );
}

describe('POST /chat — SVG fallback end to end', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    useTestConfig();
    app = createApp();
  });

  /** Install an engine backed by the production ChatProvider with a stubbed upstream. */
  function useRealChatProvider(content: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const engine = useFakeEngine([providerReturningContent('test-key')]);
    return { engine, fetchMock };
  }

  it('delivers a valid PNG payload for a text-only SVG reply', async () => {
    useRealChatProvider(VALID_SVG);

    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(200);
    // The acceptance criterion, at the public surface: PNG magic bytes.
    expect(res.body.images).toHaveLength(1);
    expect(res.body.images[0].mime).toBe('image/png');
    expect(isPng(res.body.images[0].base64)).toBe(true);
  });

  it('delivers image/svg+xml only when svg is explicitly requested', async () => {
    useRealChatProvider(VALID_SVG);

    const res = await request(app).post('/chat').send({ prompt: 'a red apple', format: 'svg' });

    expect(res.status).toBe(200);
    expect(res.body.images[0].mime).toBe('image/svg+xml');
    expect(res.body.images[0].svg).toBe(VALID_SVG);
  });

  it('never downgrades a PNG request to a bare document', async () => {
    useRealChatProvider(VALID_SVG);

    const res = await request(app).post('/chat').send({ prompt: 'a red apple', format: 'png' });

    expect(res.status).toBe(200);
    // A caller who asked for a bitmap must not receive a document in the raster slot.
    expect(res.body.images[0].mime).toBe('image/png');
    expect(isPng(res.body.images[0].base64)).toBe(true);
  });

  it('returns an SVG data URI when url delivery is requested with svg format', async () => {
    useRealChatProvider(VALID_SVG);

    const res = await request(app)
      .post('/chat')
      .send({ prompt: 'a red apple', format: 'svg', response_format: 'url' });

    expect(res.status).toBe(200);
    expect(res.body.images[0].url).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('returns a PNG data URI when url delivery is requested with the default format', async () => {
    useRealChatProvider(VALID_SVG);

    const res = await request(app)
      .post('/chat')
      .send({ prompt: 'a red apple', response_format: 'url' });

    expect(res.status).toBe(200);
    expect(res.body.images[0].url).toMatch(/^data:image\/png;base64,/);
  });

  it('reports prose as a truthful 422 rather than an empty success', async () => {
    useRealChatProvider('I cannot draw that.');

    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_output');
    // Nothing was invented to fill the gap.
    expect(res.body.images).toBeUndefined();
  });

  it('reports unsafe SVG as a truthful 422 and names the defect', async () => {
    useRealChatProvider(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        '<script>alert(1)</script><rect width="64" height="64"/></svg>',
    );

    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_output');
    expect(res.body.error.message).toMatch(/svg_unsafe_element/);
  });

  it('reports a geometry-free placeholder as a truthful 422', async () => {
    useRealChatProvider(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><title>A cat</title></svg>',
    );

    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/svg_no_geometry/);
  });

  it('reports a truncated document as a truthful 422', async () => {
    useRealChatProvider(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64"',
    );

    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_output');
  });

  it('varies the prompt across a batch so count>1 cannot return copies', async () => {
    const { fetchMock } = useRealChatProvider(VALID_SVG);

    const res = await request(app).post('/chat').send({ prompt: 'a red apple', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const prompts = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse((call[1] as { body: string }).body);
      const userTurn = body.messages[body.messages.length - 1];
      return typeof userTurn.content === 'string'
        ? userTurn.content
        : JSON.stringify(userTurn.content);
    });

    // Every sub-job must ask a different question, or an upstream that cannot take a seed
    // returns the same drawing three times and the count is a lie.
    expect(new Set(prompts).size).toBe(3);
    for (const prompt of prompts) expect(prompt).toContain('a red apple');
  });

  it('rejects an unknown format value at the boundary', async () => {
    useRealChatProvider(VALID_SVG);

    const res = await request(app).post('/chat').send({ prompt: 'x', format: 'bmp' });

    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });
});

describe('POST /chat — batch failure honesty', () => {
  it('reports a partial batch failure rather than a short success', async () => {
    silenceLogs();
    useTestConfig();
    useFakeEngine([
      new FakeProvider('fake', {
        error: new ProviderError({
          provider: 'fake',
          message: 'no image',
          code: 'unsupported_output',
          retryable: false,
        }),
      }),
    ]);
    const app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', count: 2 });

    expect(res.status).toBe(422);
  });
});
