import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReplicateProvider } from '../../../src/providers/replicate.provider';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Unit tests for the Replicate (Flux) provider.
 *
 * Two behaviours dominate this suite:
 *
 *  1. **Endpoint routing by model-reference shape.** `/v1/predictions` takes a version
 *     *hash*; an `owner/name` id must go to `/v1/models/{owner}/{name}/predictions`. The
 *     old code sent a model name as `version` to the hash endpoint, which fails.
 *  2. **Polling.** The loop polls immediately, then backs off. Where a test needs to
 *     observe a wait, fake timers make it deterministic and instant.
 *
 * `fetch` is stubbed for every test; no request leaves the process.
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

/** A successful create-prediction response. */
function created(id = 'pred-1'): Response {
  return fakeResponse({ body: { id, status: 'starting' } });
}

/** A terminal poll response. */
function prediction(status: string, extra: Record<string, unknown> = {}): Response {
  return fakeResponse({ body: { status, ...extra } });
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

function provider(over: Partial<ConstructorParameters<typeof ReplicateProvider>[0]> = {}) {
  return new ReplicateProvider({ apiToken: 'r8-test-token', ...over });
}

/**
 * Stub fetch with a queue of responses, one per call, capturing every request.
 *
 * `generate()` issues a create call followed by one or more polls, so a test asserts
 * against `calls[0]` (create) and `calls[1..]` (polls) directly.
 */
function stubFetchSequence(responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  // Any call beyond the supplied queue is a bug in the poll loop; fail loudly.
  fetchMock.mockRejectedValue(new Error('unexpected extra fetch call'));
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    calls: () =>
      fetchMock.mock.calls.map(([url, init]) => ({
        url: url as string,
        init: init as RequestInit | undefined,
        body: (init as RequestInit | undefined)?.body
          ? (JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
          : undefined,
      })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ReplicateProvider — isAvailable', () => {
  it('is false with an empty API token', () => {
    expect(provider({ apiToken: '' }).isAvailable()).toBe(false);
  });

  it('is true with an API token', () => {
    expect(provider({ apiToken: 'r8-live' }).isAvailable()).toBe(true);
  });

  it('reports status unavailable in its descriptor without a token', () => {
    expect(provider({ apiToken: '' }).getCapabilities().status).toBe('unavailable');
  });
});

describe('ReplicateProvider — create call routing', () => {
  it('posts an owner/name model to /v1/models/{owner}/{name}/predictions', async () => {
    const { calls } = stubFetchSequence([created(), prediction('succeeded', { output: ['u'] })]);

    await provider().generate(request({ model: 'black-forest-labs/flux-schnell' }));

    expect(calls()[0].url).toBe(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',
    );
  });

  it('does NOT send a version field for an owner/name model', async () => {
    // Regression: an owner/name id was previously sent as `version` to /v1/predictions,
    // which only accepts a version hash.
    const { calls } = stubFetchSequence([created(), prediction('succeeded', { output: ['u'] })]);

    await provider().generate(request({ model: 'black-forest-labs/flux-schnell' }));

    expect(calls()[0].body?.version).toBeUndefined();
  });

  it('posts a hash-form model to /v1/predictions', async () => {
    const { calls } = stubFetchSequence([created(), prediction('succeeded', { output: ['u'] })]);

    await provider().generate(request({ model: 'a1b2c3d4e5f6' }));

    expect(calls()[0].url).toBe('https://api.replicate.com/v1/predictions');
  });

  it('sends the hash as the version field for a hash-form model', async () => {
    const { calls } = stubFetchSequence([created(), prediction('succeeded', { output: ['u'] })]);

    await provider().generate(request({ model: 'a1b2c3d4e5f6' }));

    expect(calls()[0].body?.version).toBe('a1b2c3d4e5f6');
  });

  it('sends a bearer token and the prompt as input', async () => {
    const { calls } = stubFetchSequence([created(), prediction('succeeded', { output: ['u'] })]);

    await provider().generate(request({ prompt: 'a red apple' }));

    expect((calls()[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer r8-test-token',
    );
    expect(calls()[0].body?.input).toMatchObject({ prompt: 'a red apple' });
  });

  it('maps quality onto a step count when steps are not given', async () => {
    const { calls } = stubFetchSequence([created(), prediction('succeeded', { output: ['u'] })]);

    await provider().generate(request({ quality: 'high' }));

    expect((calls()[0].body?.input as Record<string, unknown>).num_inference_steps).toBe(28);
  });

  it('throws when the create call returns no prediction id', async () => {
    stubFetchSequence([fakeResponse({ body: { status: 'starting' } })]);

    await expect(provider().generate(request())).rejects.toThrow(/prediction id/i);
  });
});

describe('ReplicateProvider — polling', () => {
  it('returns the image URL when the first poll reports succeeded', async () => {
    stubFetchSequence([created(), prediction('succeeded', { output: ['https://cdn.test/a.png'] })]);

    const result = await provider().generate(request());

    expect(result.images).toEqual([{ url: 'https://cdn.test/a.png', mime: 'image/png' }]);
    expect(result.provider).toBe('replicate');
  });

  it('polls immediately rather than sleeping before the first poll', async () => {
    // The old loop slept a fixed 1000ms before every poll, burning requests and latency.
    const { fetchMock } = stubFetchSequence([
      created(),
      prediction('succeeded', { output: ['https://cdn.test/a.png'] }),
    ]);

    await provider().generate(request());

    // Create + exactly one poll, with no timer advanced.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('polls the prediction endpoint by id', async () => {
    const { calls } = stubFetchSequence([
      created('pred-42'),
      prediction('succeeded', { output: ['https://cdn.test/a.png'] }),
    ]);

    await provider().generate(request());

    expect(calls()[1].url).toBe('https://api.replicate.com/v1/predictions/pred-42');
  });

  it('keeps polling through non-terminal states until succeeded', async () => {
    vi.useFakeTimers();

    stubFetchSequence([
      created(),
      prediction('starting'),
      prediction('processing'),
      prediction('succeeded', { output: ['https://cdn.test/a.png'] }),
    ]);

    const promise = provider().generate(request());
    // Two intermediate polls each wait once; advancing past both settles the promise.
    await vi.advanceTimersByTimeAsync(10000);

    const result = await promise;
    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('https://cdn.test/a.png');
  });

  it('accepts a bare string output and normalises it to one image', async () => {
    stubFetchSequence([created(), prediction('succeeded', { output: 'https://cdn.test/a.png' })]);

    const result = await provider().generate(request());

    expect(result.images).toEqual([{ url: 'https://cdn.test/a.png', mime: 'image/png' }]);
  });

  it('returns every URL when the output is an array', async () => {
    stubFetchSequence([
      created(),
      prediction('succeeded', { output: ['https://cdn.test/a.png', 'https://cdn.test/b.png'] }),
    ]);

    const result = await provider().generate(request());

    expect(result.images.map((i) => i.url)).toEqual([
      'https://cdn.test/a.png',
      'https://cdn.test/b.png',
    ]);
  });
});

describe('ReplicateProvider — polling failures', () => {
  it('throws on status failed', async () => {
    stubFetchSequence([created(), prediction('failed', { error: 'NSFW content detected' })]);

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('failed');
    expect(error.message).toContain('NSFW content detected');
  });

  it('throws on status canceled', async () => {
    stubFetchSequence([created(), prediction('canceled')]);

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('canceled');
  });

  it('throws rather than returning zero images for an empty output array', async () => {
    stubFetchSequence([created(), prediction('succeeded', { output: [] })]);

    await expect(provider().generate(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws when succeeded carries no output field at all', async () => {
    stubFetchSequence([created(), prediction('succeeded')]);

    await expect(provider().generate(request())).rejects.toThrow(/empty output/i);
  });

  it('translates a non-ok poll response into a ProviderError', async () => {
    stubFetchSequence([
      created(),
      fakeResponse({
        ok: false,
        status: 404,
        body: { detail: 'prediction not found', title: 'not_found' },
      }),
    ]);

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('prediction not found');
  });

  it('translates a non-ok create response into a ProviderError', async () => {
    stubFetchSequence([
      fakeResponse({
        ok: false,
        status: 401,
        body: { detail: 'invalid token', title: 'unauthorized' },
      }),
    ]);

    const error = (await provider()
      .generate(request())
      .catch((e: unknown) => e)) as ProviderError;

    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
  });

  it('times out when a prediction never reaches a terminal state', async () => {
    vi.useFakeTimers();

    // Every poll keeps reporting a non-terminal state, so only the deadline can end it.
    const fetchMock = vi.fn().mockResolvedValue(prediction('processing'));
    fetchMock.mockResolvedValueOnce(created());
    vi.stubGlobal('fetch', fetchMock);

    const pending = provider()
      .generate(request())
      .then(() => {
        throw new Error('expected a timeout, but generate() resolved');
      })
      .catch((e: unknown) => e);

    // Advance past the 300s provider timeout so the deadline check fires.
    await vi.advanceTimersByTimeAsync(300001);

    const error = await pending;
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(504);
    expect((error as ProviderError).code).toBe('prediction_timeout');
  });
});
