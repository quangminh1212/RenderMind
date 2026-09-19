import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatProvider,
  extractImages,
  SYSTEM_INSTRUCTION,
} from '../../../src/providers/chat.provider';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Chat-provider tests.
 *
 * Two things are pinned here that the engine's correctness depends on:
 *   1. `extractImages` — the four response shapes a model might return, and the fact that
 *      anything else yields *no* image (which `generate` turns into a terminal error).
 *   2. `generate` — the outgoing payload, and the honest classification of every failure
 *      (transport, upstream 4xx/5xx, Retry-After, and the text-only case).
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

function provider(over: Partial<ConstructorParameters<typeof ChatProvider>[0]> = {}) {
  return new ChatProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'default-model',
    visionModel: 'vision-model',
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── extractImages ───────────────────────────────────────────

describe('extractImages', () => {
  it('reads an image_url content part (multimodal shape)', () => {
    const out = extractImages([
      { type: 'text', text: 'here' },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://cdn.example.com/a.png');
  });

  it('reads an image_url given as a bare string', () => {
    const out = extractImages([{ image_url: 'https://cdn.example.com/a.jpg' }]);
    expect(out[0].url).toBe('https://cdn.example.com/a.jpg');
    expect(out[0].mime).toBe('image/jpeg');
  });

  it('reads a bare data URI in text', () => {
    const out = extractImages('![image](data:image/png;base64,QUJD)');
    expect(out).toHaveLength(1);
    expect(out[0].base64).toBe('QUJD');
    expect(out[0].mime).toBe('image/png');
  });

  it('reads a bare image URL in text', () => {
    const out = extractImages('Here: https://cdn.example.com/art.webp done');
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://cdn.example.com/art.webp');
    expect(out[0].mime).toBe('image/webp');
  });

  it('reads a JSON object with b64_json emitted as text', () => {
    const out = extractImages('{"b64_json":"QUJDRA=="}');
    expect(out).toHaveLength(1);
    expect(out[0].base64).toBe('QUJDRA==');
  });

  it('strips a data-URI prefix from an embedded base64 field', () => {
    const out = extractImages([{ b64_json: 'data:image/png;base64,QUJD' }]);
    expect(out[0].base64).toBe('QUJD');
  });

  it('returns nothing for prose with no image', () => {
    expect(extractImages('I cannot draw that, sorry.')).toHaveLength(0);
  });

  it('returns nothing for a NO_IMAGE reply', () => {
    expect(extractImages('NO_IMAGE')).toHaveLength(0);
  });

  it('returns nothing for null/undefined content', () => {
    expect(extractImages(null)).toHaveLength(0);
    expect(extractImages(undefined)).toHaveLength(0);
  });

  it('ignores a non-image http URL', () => {
    expect(extractImages('see https://example.com/page.html')).toHaveLength(0);
  });

  it('dedupes the same image echoed twice', () => {
    const out = extractImages([
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
    ]);
    expect(out).toHaveLength(1);
  });

  it('collects several distinct images', () => {
    const out = extractImages([
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/b.png' } },
    ]);
    expect(out).toHaveLength(2);
  });
});

// ─── capabilities & availability ─────────────────────────────

describe('ChatProvider capabilities', () => {
  it('is available only with a key', () => {
    expect(provider({ apiKey: '' }).isAvailable()).toBe(false);
    expect(provider({ apiKey: 'k' }).isAvailable()).toBe(true);
  });

  it('reports unavailable in its descriptor without a key', () => {
    expect(provider({ apiKey: '' }).getCapabilities().status).toBe('unavailable');
  });

  it('declares the default, vision and extra models', () => {
    const models = provider({ extraModels: ['m3'] })
      .getCapabilities()
      .models.map((m) => m.id);
    expect(models).toEqual(expect.arrayContaining(['default-model', 'vision-model', 'm3']));
  });

  it('declares image-to-image support when a vision model is set', () => {
    expect(provider({ visionModel: 'v' }).getCapabilities().features.imageToImage).toBe(true);
    expect(provider({ visionModel: '' }).getCapabilities().features.imageToImage).toBe(false);
  });

  it('discloses unsupported native hints rather than pretending', () => {
    const features = provider().getCapabilities().features;
    expect(features.steps).toBe(false);
    expect(features.seed).toBe(false);
    expect(features.negativePrompt).toBe(false);
    expect(features.batch).toBe(false);
  });
});

// ─── generate ────────────────────────────────────────────────

describe('ChatProvider.generate', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('posts to chat/completions and returns the extracted image', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '![i](data:image/png;base64,QUJD)' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('default-model');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(SYSTEM_INSTRUCTION);
    expect(result.images[0].base64).toBe('QUJD');
    expect(result.provider).toBe('chat');
  });

  it('uses the vision model when input images are present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '![i](data:image/png;base64,QUJD)' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req({ referenceImages: [{ data: 'QUJD', mime: 'image/png' }] }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('vision-model');
    // The reference is attached as an image_url part, followed by the instruction.
    const parts = body.messages[1].content;
    expect(parts[0]).toMatchObject({ type: 'image_url' });
    expect(parts[0].image_url.url).toBe('data:image/png;base64,QUJD');
    expect(parts[parts.length - 1]).toMatchObject({ type: 'text' });
  });

  it('honours an explicit model over the default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '![i](data:image/png;base64,QUJD)' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req({ model: 'pinned-model' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('pinned-model');
  });

  it('forwards the seed when one is set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '![i](data:image/png;base64,QUJD)' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req({ seed: 7 }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).seed).toBe(7);
  });

  it('treats a text-only reply as a terminal unsupported_output error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'I cannot.' } }] })),
    );

    await expect(provider().generate(req())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'unsupported_output',
      retryable: false,
    });
  });

  it('wraps a transport failure as a ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(provider().generate(req())).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps a non-ok response to a ProviderError carrying the upstream status', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { message: 'bad prompt', code: 'content_policy' } },
            { status: 400 },
          ),
        ),
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('bad prompt');
    expect(error.code).toBe('content_policy');
  });

  it('keeps a generic message for a non-JSON error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('Internal Server Error', { status: 500 })),
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);
    expect(error.status).toBe(500);
    // The raw body must not leak into the client-facing message.
    expect(error.message).toBe('Upstream error (500)');
  });

  it('captures a numeric Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { message: 'slow down' } },
            { status: 429, headers: { 'retry-after': '30' } },
          ),
        ),
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('ignores a non-numeric Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: {} }, { status: 429, headers: { 'retry-after': 'later' } }),
        ),
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('uses a configured system prompt override', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '![i](data:image/png;base64,QUJD)' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await provider({ systemPrompt: 'CUSTOM RULE' }).generate(req());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toBe('CUSTOM RULE');
  });
});
