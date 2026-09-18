import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenclawProvider } from '../../../src/providers/openclaw.provider';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Unit tests for the openclaw `/images/generations` provider.
 *
 * `fetch` is stubbed for every test — this suite must never touch the network. The stub
 * records the URL and the parsed body so payload construction can be asserted directly,
 * which is where the interesting behaviour lives (size handling, `n`, folded negative
 * prompts, quality mapping).
 */

/** The shape of a fake `Response` that satisfies everything the provider touches. */
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

/** A canonical request with sane defaults; override only what a test cares about. */
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

function provider(over: Partial<ConstructorParameters<typeof OpenclawProvider>[0]> = {}) {
  return new OpenclawProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.openclaw.test/v1',
    defaultModel: 'dall-e-3',
    ...over,
  });
}

/** Install a fetch stub and return a reader for the captured request. */
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

describe('OpenclawProvider — isAvailable', () => {
  it('is false when the API key is empty', () => {
    expect(provider({ apiKey: '' }).isAvailable()).toBe(false);
  });

  it('is true when an API key is present', () => {
    expect(provider({ apiKey: 'sk-live' }).isAvailable()).toBe(true);
  });

  it('does not become available from a base URL alone', () => {
    // Regression: a keyless provider advertised itself as available, was auto-selected
    // by the matcher, then failed upstream with a 401.
    expect(provider({ apiKey: '', baseUrl: 'https://api.openclaw.test/v1' }).isAvailable()).toBe(
      false,
    );
  });

  it('reports status unavailable in its descriptor without a key', () => {
    expect(provider({ apiKey: '' }).getCapabilities().status).toBe('unavailable');
  });
});

describe('OpenclawProvider — getCapabilities', () => {
  it("declares DALL-E 3's discrete sizes", () => {
    const model = provider()
      .getCapabilities()
      .models.find((m) => m.id === 'dall-e-3');

    expect(model?.sizes).toEqual({
      kind: 'discrete',
      sizes: [
        { width: 1024, height: 1024 },
        { width: 1024, height: 1792 },
        { width: 1792, height: 1024 },
      ],
    });
  });

  it('reports status available when a key is configured', () => {
    expect(provider().getCapabilities().status).toBe('available');
  });

  it('declares extra models as range-sized rather than constraining them to DALL-E buckets', () => {
    const model = provider({ extraModels: ['local-sdxl'] })
      .getCapabilities()
      .models.find((m) => m.id === 'local-sdxl');

    expect(model?.sizes).toEqual({ kind: 'range', min: 64, max: 4096, multiple: 8 });
  });

  it('does not duplicate a known model passed as an extra model', () => {
    const models = provider({ extraModels: ['dall-e-3'] }).getCapabilities().models;
    expect(models.filter((m) => m.id === 'dall-e-3')).toHaveLength(1);
  });

  it('declares negative prompts as unsupported, since they are folded into the prompt', () => {
    expect(provider().getCapabilities().features.negativePrompt).toBe(false);
  });
});

describe('OpenclawProvider — payload for a known model', () => {
  it('sends the size as a "WxH" string', async () => {
    const { call } = stubFetch(
      fakeResponse({ body: { data: [{ b64_json: 'QUJD' }], created: 1 } }),
    );

    await provider().generate(request({ model: 'dall-e-3', size: { width: 1024, height: 1792 } }));

    expect(call().body.size).toBe('1024x1792');
    expect(call().body.width).toBeUndefined();
    expect(call().body.height).toBeUndefined();
  });

  it('forces n to 1 for DALL-E 3, which is single-image only', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ model: 'dall-e-3', count: 4 }));

    expect(call().body.n).toBe(1);
  });

  it('preserves the requested n for a multi-image known model', async () => {
    const { call } = stubFetch(
      fakeResponse({ body: { data: [{ b64_json: 'QUJD' }, { b64_json: 'QUJD' }] } }),
    );

    await provider().generate(request({ model: 'dall-e-2', count: 2 }));

    expect(call().body.n).toBe(2);
  });

  it('posts to {baseUrl}/images/generations with a bearer token', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider({ baseUrl: 'https://api.openclaw.test/v1/' }).generate(request());

    expect(call().url).toBe('https://api.openclaw.test/v1/images/generations');
    expect(call().init.method).toBe('POST');
    expect((call().init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('falls back to the default model when the request names none', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider({ defaultModel: 'dall-e-2' }).generate(request());

    expect(call().body.model).toBe('dall-e-2');
  });

  it('omits response_format for gpt-image-1, which rejects it', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ model: 'gpt-image-1' }));

    expect(call().body.response_format).toBeUndefined();
  });
});

describe('OpenclawProvider — payload for an unknown model', () => {
  it('sends explicit width/height instead of a size string', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ model: 'local-sdxl', size: { width: 768, height: 512 } }));

    expect(call().body.width).toBe(768);
    expect(call().body.height).toBe(512);
    expect(call().body.size).toBeUndefined();
  });

  it('reflects the requested count in n', async () => {
    const { call } = stubFetch(
      fakeResponse({
        body: { data: [{ b64_json: 'Q' }, { b64_json: 'Q' }, { b64_json: 'Q' }] },
      }),
    );

    await provider().generate(request({ model: 'local-sdxl', count: 3 }));

    expect(call().body.n).toBe(3);
  });

  it('omits width/height when the request carries no explicit size', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ model: 'local-sdxl', size: null }));

    expect(call().body.width).toBeUndefined();
    expect(call().body.height).toBeUndefined();
  });
});

describe('OpenclawProvider — prompt handling', () => {
  it('folds a negative prompt into the prompt text', async () => {
    // This protocol has no native negative-prompt field, so the only honest option is to
    // append it — the descriptor already declares negativePrompt:false so the engine
    // discloses that it was not honoured natively.
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ prompt: 'a red apple', negativePrompt: 'blurry' }));

    expect(call().body.prompt).toBe('a red apple\n\nAvoid: blurry');
    expect(call().body.negative_prompt).toBeUndefined();
  });

  it('sends the prompt verbatim when there is no negative prompt', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ prompt: 'a red apple' }));

    expect(call().body.prompt).toBe('a red apple');
  });
});

describe('OpenclawProvider — quality mapping', () => {
  it.each([
    ['high', 'hd'],
    ['draft', 'standard'],
    ['standard', 'standard'],
  ] as const)('maps quality %s to %s', async (quality, expected) => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ model: 'dall-e-3', quality }));

    expect(call().body.quality).toBe(expected);
  });

  it('omits quality entirely when the request does not ask for one', async () => {
    const { call } = stubFetch(fakeResponse({ body: { data: [{ b64_json: 'QUJD' }] } }));

    await provider().generate(request({ model: 'dall-e-3', quality: null }));

    expect(call().body.quality).toBeUndefined();
  });
});

describe('OpenclawProvider — success', () => {
  it('maps the upstream payload onto canonical images', async () => {
    stubFetch(
      fakeResponse({
        body: {
          data: [
            { b64_json: 'QUJD', url: 'https://cdn.test/a.png', revised_prompt: 'a green apple' },
          ],
        },
      }),
    );

    const result = await provider().generate(request());

    expect(result.images[0]).toEqual({
      base64: 'QUJD',
      url: 'https://cdn.test/a.png',
      mime: 'image/png',
      revisedPrompt: 'a green apple',
    });
    expect(result.provider).toBe('openclaw');
    expect(result.model).toBe('dall-e-3');
    expect(result.cached).toBe(false);
  });

  it('throws rather than returning zero images for a 200 with an empty data array', async () => {
    stubFetch(fakeResponse({ body: { data: [], created: 1 } }));

    await expect(provider().generate(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it('treats a 200 with no data field at all as empty output', async () => {
    stubFetch(fakeResponse({ body: { created: 1 } }));

    await expect(provider().generate(request())).rejects.toThrow(/no image data/i);
  });
});

describe('OpenclawProvider — error translation', () => {
  it('preserves status, retryability and Retry-After on a 429', async () => {
    stubFetch(
      fakeResponse({
        ok: false,
        status: 429,
        headers: { 'retry-after': '7' },
        body: { error: { message: 'rate limited', code: 'rate_limit_exceeded' } },
      }),
    );

    const error = await provider()
      .generate(request())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.status).toBe(429);
    expect(providerError.retryable).toBe(true);
    expect(providerError.retryAfterSeconds).toBe(7);
    expect(providerError.code).toBe('rate_limit_exceeded');
    expect(providerError.message).toBe('rate limited');
  });

  it('marks a 400 as not retryable', async () => {
    // A 4xx is the caller's fault; retrying it burns upstream quota on a request that
    // can never succeed.
    stubFetch(
      fakeResponse({
        ok: false,
        status: 400,
        body: { error: { message: 'invalid size', code: 'invalid_parameter' } },
      }),
    );

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(error.isClientError).toBe(true);
  });

  it('ignores a non-numeric Retry-After rather than parsing it as NaN', async () => {
    stubFetch(
      fakeResponse({
        ok: false,
        status: 429,
        headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        body: { error: { message: 'slow down' } },
      }),
    );

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('keeps a generic message for a non-JSON error body', async () => {
    const response = {
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => '<html>gateway error</html>',
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('500');
  });

  it('treats a transport failure as retryable with no status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNREFUSED');
  });
});
