import { describe, it, expect, vi, afterEach } from 'vitest';
import { StabilityProvider } from '../../../src/providers/stability.provider';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Unit tests for the Stability AI provider.
 *
 * `fetch` is stubbed throughout. Stability's distinguishing traits under test are its
 * `text_prompts` weight encoding (native negative prompts), its range-based size
 * descriptor, and the `quality` → `steps` mapping applied only when `steps` is absent.
 */

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function fakeResponse({
  ok = true,
  status = 200,
  headers = {},
  body = {},
}: FakeResponseInit = {}): Response {
  return {
    ok,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function request(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'a red apple',
    count: 1,
    size: { width: 1024, height: 1024 },
    aspect: null,
    quality: null,
    output: { format: 'png', delivery: 'base64' },
    ...over,
  };
}

function provider(over: Partial<ConstructorParameters<typeof StabilityProvider>[0]> = {}) {
  return new StabilityProvider({ apiKey: 'test-key', ...over });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    call: () => {
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StabilityProvider — isAvailable', () => {
  it('is false with an empty API key', () => {
    expect(provider({ apiKey: '' }).isAvailable()).toBe(false);
  });

  it('is true with an API key', () => {
    expect(provider({ apiKey: 'sk-live' }).isAvailable()).toBe(true);
  });

  it('reports status unavailable in its descriptor without a key', () => {
    expect(provider({ apiKey: '' }).getCapabilities().status).toBe('unavailable');
  });
});

describe('StabilityProvider — getCapabilities', () => {
  it('declares a range size spec, not discrete sizes', () => {
    const model = provider()
      .getCapabilities()
      .models.find((m) => m.id === 'stable-diffusion-xl-1024-v1-0');

    expect(model?.sizes).toEqual({ kind: 'range', min: 64, max: 2048, multiple: 64 });
  });

  it('declares every model with a range-based size spec', () => {
    const models = provider().getCapabilities().models;
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.sizes.kind).toBe('range');
    }
  });

  it('declares negative prompts as natively supported', () => {
    expect(provider().getCapabilities().features.negativePrompt).toBe(true);
  });

  it('reports status available when a key is configured', () => {
    expect(provider().getCapabilities().status).toBe('available');
  });
});

describe('StabilityProvider — payload', () => {
  it('sends the prompt as a text prompt with weight 1', async () => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ prompt: 'a red apple' }));

    expect(call().body.text_prompts).toEqual([{ text: 'a red apple', weight: 1 }]);
  });

  it('sends the negative prompt as a text prompt with weight -1', async () => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ negativePrompt: 'blurry' }));

    expect(call().body.text_prompts).toEqual([
      { text: 'a red apple', weight: 1 },
      { text: 'blurry', weight: -1 },
    ]);
  });

  it('posts to the model text-to-image endpoint', async () => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ model: 'stable-diffusion-v1-6' }));

    expect(call().url).toBe(
      'https://api.stability.ai/v1/generation/stable-diffusion-v1-6/text-to-image',
    );
  });

  it('passes the requested size through as width/height', async () => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ size: { width: 512, height: 768 } }));

    expect(call().body.width).toBe(512);
    expect(call().body.height).toBe(768);
  });

  it('defaults to 1024x1024 when no size is given', async () => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ size: null }));

    expect(call().body.width).toBe(1024);
    expect(call().body.height).toBe(1024);
  });

  it('carries the requested count into samples', async () => {
    const { call } = stubFetch(
      fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }, { base64: 'QUJD' }] } }),
    );

    await provider().generate(request({ count: 2 }));

    expect(call().body.samples).toBe(2);
  });
});

describe('StabilityProvider — quality to steps mapping', () => {
  it.each([
    ['draft', 20],
    ['standard', 30],
    ['high', 50],
  ] as const)('maps quality %s to %i steps', async (quality, expected) => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ quality }));

    expect(call().body.steps).toBe(expected);
  });

  it('defaults to 30 steps when no quality is requested', async () => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ quality: null }));

    expect(call().body.steps).toBe(30);
  });

  it('prefers an explicit steps hint over the quality mapping', async () => {
    const { call } = stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    await provider().generate(request({ quality: 'high', steps: 12 }));

    expect(call().body.steps).toBe(12);
  });
});

describe('StabilityProvider — success', () => {
  it('maps artifacts onto canonical images with the requested dimensions', async () => {
    stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    const result = await provider().generate(request({ size: { width: 512, height: 768 } }));

    expect(result.images).toEqual([{ base64: 'QUJD', mime: 'image/png', width: 512, height: 768 }]);
    expect(result.provider).toBe('stability');
    expect(result.cached).toBe(false);
  });

  it('reports the seed it actually used', async () => {
    stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    const result = await provider().generate(request({ seed: 12345 }));

    expect(result.seedUsed).toBe(12345);
  });

  it('generates a seed when the request supplies none', async () => {
    stubFetch(fakeResponse({ body: { artifacts: [{ base64: 'QUJD' }] } }));

    const result = await provider().generate(request());

    expect(result.seedUsed).toBeTypeOf('number');
  });

  it('throws rather than returning zero images when there are no artifacts', async () => {
    stubFetch(fakeResponse({ body: { artifacts: [] } }));

    await expect(provider().generate(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it('treats a response with no artifacts field at all as empty output', async () => {
    stubFetch(fakeResponse({ body: {} }));

    await expect(provider().generate(request())).rejects.toThrow(/no image artifacts/i);
  });
});

describe('StabilityProvider — error translation', () => {
  it('preserves the upstream status on the ProviderError', async () => {
    stubFetch(
      fakeResponse({
        ok: false,
        status: 403,
        body: { message: 'invalid api key', name: 'invalid_auth' },
      }),
    );

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('invalid_auth');
    expect(error.message).toBe('invalid api key');
  });

  it('preserves a 429 and its Retry-After as retryable', async () => {
    stubFetch(
      fakeResponse({
        ok: false,
        status: 429,
        headers: { 'retry-after': '3' },
        body: { message: 'too many requests' },
      }),
    );

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(3);
  });

  it('marks a 400 as not retryable', async () => {
    stubFetch(fakeResponse({ ok: false, status: 400, body: { message: 'invalid dimensions' } }));

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
  });

  it('treats a transport failure as retryable with no status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(true);
  });
});
