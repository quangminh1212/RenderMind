import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  NativeImageProvider,
  extractImages,
  sizeForAspect,
} from '../../../src/providers/image.provider';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Native image-provider tests.
 *
 * This provider is the one path in the engine that can return a real raster, so what it
 * claims matters more than what it does well. Two things are pinned here:
 *
 *   1. **What it sends.** The images API takes `model`, `prompt`, `n`, `size`, `quality` and
 *      `response_format` as fields — not as prose — and asking for `b64_json` is the only
 *      spelling that is correct on every deployment.
 *   2. **What it claims.** No SVG, no image-to-image, no seed. Each of those is asserted
 *      because the capability descriptor is what the matcher routes on, so a false claim
 *      here is not a documentation error — it is a request sent to an endpoint that cannot
 *      honour it, reported as a success.
 */

function req(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'a red apple',
    count: 1,
    size: null,
    aspect: null,
    quality: null,
    output: { format: 'png', delivery: 'base64' },
    ...over,
  };
}

function provider(over: Partial<ConstructorParameters<typeof NativeImageProvider>[0]> = {}) {
  return new NativeImageProvider({
    apiKey: 'test-key',
    baseUrl: 'https://litellm.example.com/v1',
    model: 'dall-e-3',
    ...over,
  });
}

/** Build a fetch Response stub. */
function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => init.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── availability ────────────────────────────────────────────

describe('NativeImageProvider availability', () => {
  it('is available with both a key and a model', () => {
    expect(provider().isAvailable()).toBe(true);
  });

  it('is unavailable without a key', () => {
    expect(provider({ apiKey: '' }).isAvailable()).toBe(false);
  });

  it('is unavailable without a model id', () => {
    // A key with no model cannot be called, so it must not be advertised as available.
    expect(provider({ model: '' }).isAvailable()).toBe(false);
  });

  it('reports status unavailable in its capabilities when half-configured', () => {
    expect(provider({ model: '' }).getCapabilities().status).toBe('unavailable');
  });
});

// ─── capability declaration ──────────────────────────────────

describe('NativeImageProvider capabilities', () => {
  it('declares native batch and native base64, and claims no more', () => {
    const caps = provider().getCapabilities();

    expect(caps.provider).toBe('native');
    expect(caps.features.batch).toBe(true);
    expect(caps.features.nativeBase64).toBe(true);
    expect(caps.features.nativeUrl).toBe(true);
    expect(caps.features.quality).toBe(true);

    // The three that must not be claimed.
    expect(caps.features.imageToImage).toBe(false);
    expect(caps.features.inpainting).toBe(false);
    expect(caps.features.seed).toBe(false);
    expect(caps.features.steps).toBe(false);
    expect(caps.features.guidanceScale).toBe(false);
    expect(caps.features.negativePrompt).toBe(false);
    expect(caps.features.style).toBe(false);
  });

  it('never advertises svg output', () => {
    // This is what routes format:svg to the chat path, so it is the single most
    // load-bearing claim in the descriptor.
    const caps = provider().getCapabilities();
    for (const model of caps.models) {
      expect(model.outputFormats).not.toContain('svg');
    }
  });

  it('declares discrete sizes, so an unsupported size is nearest-matched and disclosed', () => {
    const caps = provider().getCapabilities();
    expect(caps.models[0].sizes.kind).toBe('discrete');
  });

  it('can declare an upstream that only accepts one image per request', () => {
    const caps = provider({ supportsBatch: false }).getCapabilities();

    expect(caps.features.batch).toBe(false);
    expect(caps.limits.maxBatch).toBe(1);
  });

  it('lists the configured model plus every extra model', () => {
    const caps = provider({ extraModels: ['flux-1', 'sdxl'] }).getCapabilities();
    expect(caps.models.map((m) => m.id).sort()).toEqual(['dall-e-3', 'flux-1', 'sdxl']);
  });

  it('declares maxReferenceImages 0', () => {
    expect(provider().getCapabilities().limits.maxReferenceImages).toBe(0);
  });
});

// ─── the happy path ──────────────────────────────────────────

describe('NativeImageProvider generate', () => {
  it('POSTs to {baseUrl}/images/generations with the documented fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req({ size: { width: 1024, height: 1024 }, quality: 'high' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://litellm.example.com/v1/images/generations');
    expect(init.headers.Authorization).toBe('Bearer test-key');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('dall-e-3');
    expect(body.n).toBe(1);
    expect(body.size).toBe('1024x1024');
    expect(body.quality).toBe('high');
    // Asking for base64 is the only spelling correct on every deployment.
    expect(body.response_format).toBe('b64_json');
    expect(body.prompt).toContain('a red apple');
  });

  it('delivers a b64_json result as a decodable PNG', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] })),
    );

    const result = await provider().generate(req());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].mime).toBe('image/png');
    expect(isPng(result.images[0].base64)).toBe(true);
    expect(result.provider).toBe('native');
    expect(result.model).toBe('dall-e-3');
  });

  it('strips a data-URI prefix from a b64_json field', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [{ b64_json: `data:image/png;base64,${PNG_BASE64}` }] }),
        ),
    );

    const result = await provider().generate(req());
    expect(result.images[0].base64).toBe(PNG_BASE64);
  });

  it('reads a url result and reports the mime from the extension', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/x.webp' }] })),
    );

    const result = await provider().generate(req());
    expect(result.images[0].url).toBe('https://cdn.example/x.webp');
    expect(result.images[0].mime).toBe('image/webp');
  });

  it('honours an explicit mime on the record over the URL extension', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [{ url: 'https://cdn.example/x', mime_type: 'image/jpeg' }] }),
        ),
    );

    const result = await provider().generate(req());
    expect(result.images[0].mime).toBe('image/jpeg');
  });

  it('sends the requested aspect ratio to the endpoint through the prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req({ aspect: '16:9' }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.prompt).toContain('a red apple');
  });

  it('folds a negative prompt into the subject, since the API has no field for it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req({ negativePrompt: 'blurry' }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.prompt).toContain('blurry');
  });

  it('omits size and quality when the caller did not ask for them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req());

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.size).toBeUndefined();
    expect(body.quality).toBeUndefined();
    // A prompt-only request must not be padded with a default size the caller never chose.
    expect(body.prompt).toBe('a red apple');
  });

  it('uses an explicitly requested model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider({ extraModels: ['flux-1'] }).generate(req({ model: 'flux-1' }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.model).toBe('flux-1');
    expect(result.model).toBe('flux-1');
  });

  // ─── native batch ──────────────────────────────────────────

  it('sends n>1 in a single upstream call and returns every image', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req({ count: 3 }));

    // One call, not three: this is what `features.batch` promises the matcher.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.n).toBe(3);
    expect(result.images).toHaveLength(3);
  });

  // ─── failure paths ─────────────────────────────────────────

  it('maps an upstream 400 to a terminal ProviderError carrying the upstream code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { message: 'content policy violation', code: 'content_policy_violation' } },
            { status: 400 },
          ),
        ),
    );

    await expect(provider().generate(req())).rejects.toMatchObject({
      name: 'ProviderError',
      status: 400,
      code: 'content_policy_violation',
      retryable: false,
    });
  });

  it('maps an upstream 429 as retryable and preserves Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { message: 'busy' } },
            { status: 429, headers: { 'retry-after': '12' } },
          ),
        ),
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);

    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.retryable).toBe(true);
  });

  it('maps an upstream 500 as a retryable 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('upstream exploded', { status: 500 })),
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);

    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
    // A non-JSON body is never echoed to the caller verbatim — only a redacted prefix is kept.
    expect(error.message).toBe('Upstream error (500)');
    expect(error.upstreamBody).toBe('upstream exploded');
  });

  it('reports a transport failure as a retryable ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(provider().generate(req())).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'native',
      retryable: true,
    });
  });

  it('reports an empty data array as a terminal unsupported_output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [] })));

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
      retryable: false,
    });
  });

  it('reports records with no payload as terminal rather than emitting empty images', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ index: 0 }] })));

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
      retryable: false,
    });
  });

  it('reports a non-JSON success body as terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new Error('Unexpected token < in JSON');
        },
        text: async () => '<html>gateway</html>',
      } as unknown as Response),
    );

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
      retryable: false,
    });
  });
});

// ─── extractImages ───────────────────────────────────────────

describe('extractImages', () => {
  it('reads the documented { data: [{ b64_json }] } shape', () => {
    const out = extractImages({ data: [{ b64_json: 'QUJD' }] }, req());
    expect(out).toHaveLength(1);
    expect(out[0].base64).toBe('QUJD');
    expect(out[0].mime).toBe('image/png');
  });

  it('reads the { data: [{ url }] } shape', () => {
    const out = extractImages({ data: [{ url: 'https://cdn.example/a.png' }] }, req());
    expect(out[0].url).toBe('https://cdn.example/a.png');
    expect(out[0].mime).toBe('image/png');
  });

  it('reads an images[] array, a spelling some proxies use', () => {
    const out = extractImages({ images: [{ b64_json: 'QUJD' }] }, req());
    expect(out).toHaveLength(1);
  });

  it('reads a bare array body', () => {
    const out = extractImages([{ b64_json: 'QUJD' }], req());
    expect(out).toHaveLength(1);
  });

  it('reads a single unwrapped image record', () => {
    const out = extractImages({ b64_json: 'QUJD' }, req());
    expect(out).toHaveLength(1);
  });

  it('prefers b64_json over url when both are present', () => {
    const out = extractImages(
      { data: [{ b64_json: 'QUJD', url: 'https://cdn.example/a.png' }] },
      req(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].base64).toBe('QUJD');
    expect(out[0].url).toBeUndefined();
  });

  it('skips records carrying neither payload', () => {
    const out = extractImages({ data: [{ index: 0 }, { b64_json: 'QUJD' }] }, req());
    expect(out).toHaveLength(1);
  });

  it('returns nothing for an unrecognised body', () => {
    expect(extractImages({ message: 'ok' }, req())).toHaveLength(0);
    expect(extractImages(null, req())).toHaveLength(0);
    expect(extractImages('prose', req())).toHaveLength(0);
  });

  it('uses the requested format for a jpeg request when the record is silent', () => {
    const out = extractImages(
      { data: [{ b64_json: 'QUJD' }] },
      req({ output: { format: 'jpeg', delivery: 'base64' } }),
    );
    expect(out[0].mime).toBe('image/jpeg');
  });
});

// ─── sizeForAspect ───────────────────────────────────────────

describe('sizeForAspect', () => {
  const sizes = [
    { width: 1024, height: 1024 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
  ];

  it('finds the square size for 1:1', () => {
    expect(sizeForAspect('1:1', sizes)).toEqual({ width: 1024, height: 1024 });
  });

  it('finds the landscape size for 4:3', () => {
    expect(sizeForAspect('4:3', sizes)).toEqual({ width: 1024, height: 768 });
  });

  it('finds the portrait size for 3:4', () => {
    expect(sizeForAspect('3:4', sizes)).toEqual({ width: 768, height: 1024 });
  });

  it('returns null when no size is close enough', () => {
    // 16:9 against a set of only square and 4:3/3:4 options: nothing within tolerance.
    expect(sizeForAspect('16:9', [{ width: 1024, height: 1024 }])).toBeNull();
  });

  it('returns null for an unknown aspect', () => {
    expect(sizeForAspect('7:3', sizes)).toBeNull();
  });
});
