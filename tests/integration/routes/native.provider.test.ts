import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app';
import {
  useFakeEngine,
  chatFakeForNative,
  useTestConfig,
  silenceLogs,
} from '../../helpers/harness';
import { NativeImageProvider } from '../../../src/providers/image.provider';
import { circuitBreaker } from '../../../src/platform/http.client';

/**
 * End-to-end coverage of the native image path across the real HTTP surface.
 *
 * The unit suite proves the provider's own logic. This one proves the property the feature
 * actually promises a caller: that a real raster produced by an images endpoint arrives as a
 * valid image payload, in the container and delivery mode requested — and that nothing is
 * substituted for it along the way.
 *
 * The engine, the matcher, the artifact store and the response builder are all real. Only
 * `fetch` is stubbed, so nothing between the upstream response body and the client's bytes
 * is mock behaviour. No network call and no credential is involved.
 *
 * What is specifically *not* claimed here: that the LiteLLM endpoint configured for this
 * environment can serve images at all. It has been shown not to (see the note in
 * `docs/providers.md`). These tests exercise the code path, not a live upstream.
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

/** A 1x1 PNG, so a decoded payload is verifiable rather than merely present. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /chat — native provider end to end', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    // Breakers are module-global, and several tests below deliberately fail upstream five
    // times over. Without this reset an opened breaker leaks into the next test and makes it
    // report `no_provider_configured` — a failure with nothing to do with what it asserts.
    circuitBreaker.reset();
    useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
    });
    app = createApp();
  });

  /** Install an engine backed by the production native provider, with a stubbed upstream. */
  function useRealNativeProvider(options: { body?: unknown; status?: number } = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: (options.status ?? 200) < 300,
      status: options.status ?? 200,
      headers: { get: () => null },
      json: async () => options.body ?? { data: [{ b64_json: PNG_BASE64 }] },
      text: async () => JSON.stringify(options.body ?? { data: [{ b64_json: PNG_BASE64 }] }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    // A chat fallback is present but must not be needed for any of these.
    const engine = useFakeEngine(
      [
        chatFakeForNative(),
        new NativeImageProvider({
          apiKey: 'image-key',
          baseUrl: 'https://litellm.example.com/v1',
          model: 'dall-e-3',
        }),
      ],
      'auto',
    );
    return { engine, fetchMock };
  }

  it('delivers a real PNG from a b64_json result', async () => {
    useRealNativeProvider();

    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('native');
    expect(res.body.model).toBe('dall-e-3');
    expect(res.body.images).toHaveLength(1);
    expect(res.body.images[0].mime).toBe('image/png');
    // The acceptance criterion, at the public surface: PNG magic bytes.
    expect(isPng(res.body.images[0].base64)).toBe(true);
  });

  it('inlines an upstream URL into base64 when the caller asked for b64_json', async () => {
    // The upstream answers with a URL even though base64 was requested. The engine's artifact
    // store must fetch and inline it, because the caller's `response_format` is a RenderMind
    // contract and not an upstream one.
    const fetchMock = vi
      .fn()
      // First call: the images endpoint.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: [{ url: 'https://cdn.example/generated.png' }] }),
        text: async () => '',
      } as unknown as Response)
      // Second call: fetching the artifact.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from(PNG_BASE64, 'base64'),
        body: null,
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    useFakeEngine(
      [
        chatFakeForNative(),
        new NativeImageProvider({
          apiKey: 'image-key',
          baseUrl: 'https://litellm.example.com/v1',
          model: 'dall-e-3',
        }),
      ],
      'auto',
    );
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', response_format: 'b64_json' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('native');
    // Strict delivery: base64 arrived, and no URL was substituted for it.
    expect(isPng(res.body.images[0].base64)).toBe(true);
    expect(res.body.images[0].url).toBeUndefined();
  });

  it('surfaces an upstream URL when url delivery was requested', async () => {
    useRealNativeProvider({ body: { data: [{ url: 'https://cdn.example/generated.png' }] } });

    const res = await request(app).post('/chat').send({ prompt: 'x', response_format: 'url' });

    expect(res.status).toBe(200);
    expect(res.body.images[0].url).toBe('https://cdn.example/generated.png');
    expect(res.body.images[0].base64).toBeUndefined();
  });

  it('produces n images from one upstream call', async () => {
    const { fetchMock } = useRealNativeProvider({
      body: {
        data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
      },
    });

    const res = await request(app).post('/chat').send({ prompt: 'x', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(3);
    // One call carrying n=3, not three calls: the native batch the matcher selected.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.n).toBe(3);
  });

  /**
   * Install the production native provider with **no** chat fallback.
   *
   * The failure-path tests need this: under `auto` a terminal native error fails over to
   * chat, so a request against a broken native endpoint still returns 200. That is correct
   * behaviour and it is covered in the routing suite — but it means a test about how a
   * native failure is *classified* must remove the fallback, or it would be asserting on the
   * fallback's success instead.
   */
  function useNativeProviderOnly(options: { body?: unknown; status?: number } = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: (options.status ?? 200) < 300,
      status: options.status ?? 200,
      headers: { get: () => null },
      json: async () => options.body ?? { data: [{ b64_json: PNG_BASE64 }] },
      text: async () => JSON.stringify(options.body ?? { data: [{ b64_json: PNG_BASE64 }] }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    useFakeEngine(
      [
        new NativeImageProvider({
          apiKey: 'image-key',
          baseUrl: 'https://litellm.example.com/v1',
          model: 'dall-e-3',
        }),
      ],
      'auto',
    );
    return { fetchMock };
  }

  it('reports an upstream 400 as a 400 naming the upstream code', async () => {
    useNativeProviderOnly({
      status: 400,
      body: { error: { message: 'content policy violation', code: 'content_policy_violation' } },
    });
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('content_policy_violation');
  });

  it('reports an upstream 500 as a 502', async () => {
    useNativeProviderOnly({ status: 500, body: { error: { message: 'boom' } } });
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe('server_error');
  });

  it('reports an empty upstream result honestly rather than as an empty success', async () => {
    useNativeProviderOnly({ body: { data: [] } });
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_output');
    expect(res.body.images).toBeUndefined();
  });

  it('fails over to chat when the native endpoint fails terminally', async () => {
    // The same upstream 400 that is a 400 above becomes a 200 here, served by chat — and
    // the response names chat as the provider that actually produced the image.
    useRealNativeProvider({
      status: 400,
      body: { error: { message: 'content policy violation', code: 'content_policy_violation' } },
    });
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('chat');
  });

  it('discloses a size substitution rather than silently rewriting it', async () => {
    useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
      OPENAI_RESPONSE_METADATA: 'true',
    });
    // Native alone: with the chat fallback present, its open 64..4096 range would accept
    // 1000x1000 verbatim and there would be nothing to disclose.
    useNativeProviderOnly();
    app = createApp();

    // 1000x1000 is not in the native provider's discrete size set, so the matcher snaps it
    // to the nearest supported size and must say so.
    const res = await request(app).post('/chat').send({ prompt: 'x', size: '1000x1000' });

    expect(res.status).toBe(200);
    const adaptations = res.body._rendermind.adaptations;
    expect(adaptations.sizeAdjustedFrom).toEqual({ width: 1000, height: 1000 });
    expect(adaptations.notes.join(' ')).toMatch(/adjusted to/);
  });

  it('does not disclose a size adaptation when the requested size is supported', async () => {
    useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
      OPENAI_RESPONSE_METADATA: 'true',
    });
    useNativeProviderOnly();
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', size: '1024x1024' });

    expect(res.status).toBe(200);
    expect(res.body._rendermind.adaptations?.sizeAdjustedFrom).toBeUndefined();
  });
});
