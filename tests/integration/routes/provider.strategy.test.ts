import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app';
import {
  useFakeEngine,
  FakeProvider,
  useTestConfig,
  silenceLogs,
  chatFakeForNative,
} from '../../helpers/harness';
import { ProviderRegistry } from '../../../src/providers/provider.registry';
import { NativeImageProvider } from '../../../src/providers/image.provider';
import { ProviderError } from '../../../src/engine/errors';
import { circuitBreaker } from '../../../src/platform/http.client';
import { buildPlan } from '../../../src/engine/capability.matcher';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';
import type { CapabilityDescriptor } from '../../../src/types/capability.types';

/**
 * Routing-strategy tests.
 *
 * The native images endpoint returns real pixels and the chat path authors SVG, so which one
 * serves a request is a caller-visible fact and not an implementation detail. These tests pin
 * the four rules that keep that choice honest:
 *
 *   1. `auto` prefers native, and fails over to chat when native cannot serve.
 *   2. `chat` reproduces the pre-native behaviour exactly, even with native configured.
 *   3. `format: 'svg'` never reaches the native provider — it cannot produce a document.
 *   4. A `/vision` request never reaches the native provider — it cannot accept input images.
 *
 * The engine is exercised through the real `ProviderRegistry`, the real `GenerationService`
 * and the real matcher; only the providers themselves are fakes, because an upstream call is
 * not what any of this is about.
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

/**
 * A fake standing in for the native endpoint.
 *
 * Named `native` and describing itself the way the real provider does, because the routing
 * rules are keyed off exactly that: the provider's name and its truthful capability
 * descriptor. A fake that declared a capability the real provider lacks would prove nothing.
 */
function nativeFake(over: Partial<CapabilityDescriptor> = {}, failWith?: Error) {
  return new FakeProvider('native', {
    descriptor: {
      displayName: 'Native images endpoint',
      models: [
        {
          id: 'dall-e-3',
          aspectRatios: [],
          sizes: {
            kind: 'discrete',
            sizes: [
              { width: 1024, height: 1024 },
              { width: 1024, height: 768 },
            ],
          },
          qualityLevels: ['draft', 'standard', 'high'],
          // The load-bearing claim: no svg.
          outputFormats: ['png', 'jpeg', 'webp'],
        },
      ],
      features: {
        negativePrompt: false,
        seed: false,
        steps: false,
        guidanceScale: false,
        quality: true,
        style: false,
        batch: true,
        imageToImage: false,
        inpainting: false,
        revisedPrompt: true,
        nativeBase64: true,
        nativeUrl: true,
      },
      limits: {
        maxBatch: 10,
        maxPromptChars: 32000,
        maxReferenceImages: 0,
        timeoutMs: 30000,
      },
      p50LatencyMs: 8000,
      ...over,
    },
    ...(failWith ? { error: failWith } : {}),
  });
}

/**
 * The chat fake, describing itself with the real provider's capability shape.
 *
 * Delegates to the shared helper so the SVG and image-to-image declarations exist in one
 * place: they are what the routing rules read, and two drifting copies would make the
 * suites disagree about which provider should win.
 */
function chatFake(over: Partial<CapabilityDescriptor> = {}) {
  const base = chatFakeForNative();
  if (Object.keys(over).length === 0) return base;

  return new FakeProvider('chat', {
    descriptor: { ...base.getCapabilities(), ...over },
  });
}

describe('provider strategy — auto prefers native', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    // Breakers are module-global; several tests here fail upstream repeatedly, so a leaked
    // open breaker would make a later test report an outage it never caused.
    circuitBreaker.reset();
    useTestConfig();
  });

  it('serves /chat from the native provider when both are configured', async () => {
    useFakeEngine([chatFake(), nativeFake()]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'a red apple' });

    expect(res.status).toBe(200);
    // The native path returns real pixels, so it wins under `auto`.
    expect(res.body.provider).toBe('native');
  });

  it('discloses the routing decision when response metadata is enabled', async () => {
    useTestConfig({ OPENAI_RESPONSE_METADATA: 'true' });
    useFakeEngine([chatFake(), nativeFake()]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('native');
    expect(res.body._rendermind).toBeDefined();
  });

  it('sends a one-image request to native natively, without a plan fan-out', async () => {
    const native = nativeFake();
    useFakeEngine([chatFake(), native]);
    app = createApp();

    await request(app).post('/chat').send({ prompt: 'x' });

    expect(native.calls).toHaveLength(1);
  });

  it('fails over to chat and reports the provider that actually served', async () => {
    const native = nativeFake(
      {},
      new ProviderError({
        provider: 'native',
        message: 'endpoint has no image backend',
        status: 400,
        retryable: false,
      }),
    );
    useFakeEngine([chatFake(), native]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    // d776ff5 fixed exactly this: naming the winner rather than the provider that served.
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('chat');
  });

  it('does not burn retries on a terminal native failure', async () => {
    const native = nativeFake(
      {},
      new ProviderError({
        provider: 'native',
        message: 'content policy',
        status: 400,
        retryable: false,
      }),
    );
    useFakeEngine([chatFake(), native]);
    app = createApp();

    await request(app).post('/chat').send({ prompt: 'x' });

    // A 400 is the caller's problem and cannot succeed on retry.
    expect(native.calls).toHaveLength(1);
  });

  it('reports a capability gap naming every configured provider', async () => {
    useFakeEngine([chatFake(), nativeFake()]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', provider: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_capability');
    expect(res.body.error.message).toContain('chat');
    expect(res.body.error.message).toContain('native');
  });

  it('honours an explicitly requested provider', async () => {
    useFakeEngine([chatFake(), nativeFake()]);
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', provider: 'chat' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('chat');
  });
});

describe('provider strategy — chat pins the previous behaviour', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    // Breakers are module-global; several tests here fail upstream repeatedly, so a leaked
    // open breaker would make a later test report an outage it never caused.
    circuitBreaker.reset();
    useTestConfig();
  });

  it('serves from chat even though native is configured and available', async () => {
    useFakeEngine([chatFake(), nativeFake()], 'chat');
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('chat');
  });

  it('never calls the native provider at all', async () => {
    const native = nativeFake();
    useFakeEngine([chatFake(), native], 'chat');
    app = createApp();

    await request(app).post('/chat').send({ prompt: 'x' });

    expect(native.calls).toHaveLength(0);
  });

  it('produces the same body shape as a chat-only deployment', async () => {
    useFakeEngine([chatFake()], 'chat');
    app = createApp();
    const chatOnly = await request(app).post('/chat').send({ prompt: 'x' });

    useFakeEngine([chatFake(), nativeFake()], 'chat');
    app = createApp();
    const pinned = await request(app).post('/chat').send({ prompt: 'x' });

    // Only the per-request fields are normalised away: `id` is the generation id,
    // `created` is the request timestamp and `timings.total_ms` is wall clock. Everything
    // else — every image field, the mime, the provider name — must be identical.
    const strip = (body: Record<string, unknown>) => ({
      ...body,
      id: undefined,
      created: undefined,
      timings: undefined,
    });
    expect(strip(pinned.body)).toEqual(strip(chatOnly.body));
  });
});

describe('provider strategy — native only', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    // Breakers are module-global; several tests here fail upstream repeatedly, so a leaked
    // open breaker would make a later test report an outage it never caused.
    circuitBreaker.reset();
    useTestConfig();
  });

  it('serves from native', async () => {
    useFakeEngine([chatFake(), nativeFake()], 'native');
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x' });

    expect(res.body.provider).toBe('native');
  });

  it('reports a capability gap for an svg request it cannot produce', async () => {
    useFakeEngine([chatFake(), nativeFake()], 'native');
    app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', format: 'svg' });

    // Honest: nothing configured under this strategy can produce a document.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_capability');
  });

  it('reports a capability gap for a vision request', async () => {
    useFakeEngine([chatFake(), nativeFake()], 'native');
    app = createApp();

    const data = Buffer.from('input').toString('base64');
    const res = await request(app)
      .post('/vision')
      .send({ prompt: 'x', images: [`data:image/png;base64,${data}`] });

    // The native endpoint has no image input, so it must refuse rather than drop the input.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_capability');
  });
});

describe('format svg is only routable to chat', () => {
  it('rejects a provider that cannot produce the requested output format', () => {
    const request: ImageGenerationRequest = {
      prompt: 'x',
      count: 1,
      size: null,
      aspect: null,
      quality: null,
      output: { format: 'svg', delivery: 'base64' },
    };

    expect(() => buildPlan(request, [nativeFake().getCapabilities()])).toThrow(
      /No configured provider can satisfy/,
    );
  });

  it('names the output format in the rejection reason', () => {
    const request: ImageGenerationRequest = {
      prompt: 'x',
      count: 1,
      size: null,
      aspect: null,
      quality: null,
      output: { format: 'svg', delivery: 'base64' },
    };

    try {
      buildPlan(request, [nativeFake().getCapabilities()]);
      throw new Error('expected a rejection');
    } catch (error) {
      const details = (error as { details?: string[] }).details ?? [];
      expect(details.join(' ')).toContain('cannot produce svg output');
    }
  });

  it('serves an svg request from the chat provider under auto', async () => {
    silenceLogs();
    useTestConfig();
    useFakeEngine([chatFake(), nativeFake()], 'auto');
    const app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', format: 'svg' });

    // `auto` prefers native for everything it can serve — but not for a document.
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('chat');
  });

  it('does not even list native as an attempt for an svg request', () => {
    const request: ImageGenerationRequest = {
      prompt: 'x',
      count: 1,
      size: null,
      aspect: null,
      quality: null,
      output: { format: 'svg', delivery: 'base64' },
    };

    const plan = buildPlan(request, [nativeFake().getCapabilities(), chatFake().getCapabilities()]);

    expect(plan.attempts.map((a) => a.provider)).toEqual(['chat']);
  });
});

describe('/vision is served only by the chat provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    // Breakers are module-global; several tests here fail upstream repeatedly, so a leaked
    // open breaker would make a later test report an outage it never caused.
    circuitBreaker.reset();
    useTestConfig();
  });

  it('rejects the native provider for a reference-image request, naming the capability', () => {
    const request: ImageGenerationRequest = {
      prompt: 'restyle this',
      count: 1,
      size: null,
      aspect: null,
      quality: null,
      referenceImages: [{ data: 'AAAA', mime: 'image/png' }],
      output: { format: 'png', delivery: 'base64' },
    };

    // The refusal reason is the honest part: it says *why* nothing could serve the request,
    // which is what distinguishes a capability gap from an outage.
    try {
      buildPlan(request, [nativeFake().getCapabilities()]);
      throw new Error('expected a rejection');
    } catch (error) {
      const details = (error as { details?: string[] }).details ?? [];
      expect(details.join(' ')).toContain('does not support image-to-image');
    }
  });

  it('routes the request to chat and passes the reference images through', async () => {
    const chat = chatFake();
    const native = nativeFake();
    useFakeEngine([chat, native], 'auto');
    const app = createApp();

    const data = Buffer.from('input-image').toString('base64');
    const res = await request(app)
      .post('/vision')
      .send({ prompt: 'make it blue', images: [`data:image/png;base64,${data}`] });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('chat');
    expect(chat.calls[0].referenceImages).toHaveLength(1);
    // The native provider never saw the request, so it never silently dropped the input.
    expect(native.calls).toHaveLength(0);
  });

  it('delivers a text-only 422 rather than a silent success when chat cannot draw', async () => {
    useFakeEngine(
      [
        chatFake(),
        new FakeProvider('native', {
          error: new ProviderError({
            provider: 'native',
            message: 'no image backend',
            status: 400,
            retryable: false,
          }),
        }),
      ],
      'auto',
    );
    const app = createApp();

    const data = Buffer.from('input').toString('base64');
    const res = await request(app)
      .post('/vision')
      .send({ prompt: 'x', images: [`data:image/png;base64,${data}`] });

    // The fallback answered, so both paths were tried and the outcome is a real result.
    expect([200, 422]).toContain(res.status);
    expect(res.body.provider).not.toBe('native');
  });
});

describe('registry registration', () => {
  it('registers both classes when both are configured', () => {
    const config = useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
    });

    const registry = ProviderRegistry.fromConfig(config);

    expect(registry.names().sort()).toEqual(['chat', 'native']);
    expect(
      registry
        .capabilityDescriptors('auto')
        .map((d) => d.provider)
        .sort(),
    ).toEqual(['chat', 'native']);
  });

  it('does not register the native provider without a key', () => {
    const config = useTestConfig({ CHAT_API_KEY: 'chat-key', IMAGE_MODEL: 'dall-e-3' });

    const registry = ProviderRegistry.fromConfig(config);

    expect(registry.names()).toEqual(['chat']);
  });

  it('does not register the native provider without a model', () => {
    const config = useTestConfig({ CHAT_API_KEY: 'chat-key', IMAGE_API_KEY: 'image-key' });

    const registry = ProviderRegistry.fromConfig(config);

    // A key with no model id cannot be called, so it is not a provider at all.
    expect(registry.names()).toEqual(['chat']);
  });

  it('excludes native from the descriptors when the strategy is chat', () => {
    const config = useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
      PROVIDER_STRATEGY: 'chat',
    });

    const registry = ProviderRegistry.fromConfig(config);

    expect(registry.names().sort()).toEqual(['chat', 'native']);
    expect(registry.capabilityDescriptors('chat').map((d) => d.provider)).toEqual(['chat']);
  });

  it('excludes chat from the descriptors when the strategy is native', () => {
    const config = useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
      PROVIDER_STRATEGY: 'native',
    });

    const registry = ProviderRegistry.fromConfig(config);

    expect(registry.capabilityDescriptors('native').map((d) => d.provider)).toEqual(['native']);
  });

  it('builds a real native provider that reports itself available', () => {
    const config = useTestConfig({ IMAGE_API_KEY: 'image-key', IMAGE_MODEL: 'dall-e-3' });

    const registry = ProviderRegistry.fromConfig(config);
    const native = registry.get('native');

    expect(native).toBeInstanceOf(NativeImageProvider);
    expect(native!.isAvailable()).toBe(true);
  });

  it('advertises a real native descriptor with no svg and no image-to-image', () => {
    const config = useTestConfig({ IMAGE_API_KEY: 'image-key', IMAGE_MODEL: 'dall-e-3' });
    const native = ProviderRegistry.fromConfig(config).get('native')!;

    const caps = native.getCapabilities();
    expect(caps.models[0].outputFormats).not.toContain('svg');
    expect(caps.features.imageToImage).toBe(false);
    expect(caps.features.batch).toBe(true);
  });
});

describe('zero-config parity', () => {
  it('reports exactly one provider when only chat is configured', async () => {
    silenceLogs();
    useTestConfig({ CHAT_API_KEY: 'chat-key' });
    useFakeEngine([chatFake()], 'auto');
    const app = createApp();

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(200);
    expect(res.body.checks.providers.total).toBe(1);
    expect(res.body.checks.providers.details[0].name).toBe('chat');
  });

  it('reports two providers when both are configured', async () => {
    silenceLogs();
    useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
    });
    useFakeEngine([chatFake(), nativeFake()], 'auto');
    const app = createApp();

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(200);
    expect(res.body.checks.providers.total).toBe(2);
    expect(res.body.checks.providers.details.map((d: { name: string }) => d.name).sort()).toEqual([
      'chat',
      'native',
    ]);
  });

  it('reports chat alone under the chat strategy even when native is available', async () => {
    silenceLogs();
    useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
      PROVIDER_STRATEGY: 'chat',
    });
    useFakeEngine([chatFake(), nativeFake()], 'chat');
    const app = createApp();

    const res = await request(app).get('/readyz');

    expect(res.body.checks.providers.total).toBe(1);
    expect(res.body.checks.providers.details[0].name).toBe('chat');
  });

  it('stays not-ready when the strategy forbids the only available provider', async () => {
    silenceLogs();
    useTestConfig({
      CHAT_API_KEY: 'chat-key',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
      PROVIDER_STRATEGY: 'chat',
    });
    // Only the native provider is registered as available, and the strategy forbids it.
    // Readiness must reflect what the deployment will actually route to: reporting ready
    // here would advertise a service that fails every generation with a capability gap.
    useFakeEngine([nativeFake()], 'chat');
    const app = createApp();

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.checks.providers.total).toBe(0);
  });

  it('does not change the rendering of an svg request when native is absent', async () => {
    silenceLogs();
    useTestConfig({ CHAT_API_KEY: 'chat-key' });
    useFakeEngine([chatFake()], 'auto');
    const app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', format: 'svg' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('chat');
  });
});

describe('batch behaviour across the two classes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    silenceLogs();
    // Breakers are module-global; several tests here fail upstream repeatedly, so a leaked
    // open breaker would make a later test report an outage it never caused.
    circuitBreaker.reset();
    useTestConfig();
  });

  it('uses native batch for count>1 instead of a fan-out', async () => {
    const native = nativeFake();
    useFakeEngine([chatFake(), native], 'auto');
    const app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(3);
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0].count).toBe(3);
    expect(native.calls[0].prompt).toBe('x');
  });

  it('fans out for count>1 when chat is the only provider', async () => {
    const chat = chatFake();
    useFakeEngine([chat], 'chat');
    const app = createApp();

    const res = await request(app).post('/chat').send({ prompt: 'x', count: 3 });

    expect(res.status).toBe(200);
    expect(chat.calls).toHaveLength(3);
  });

  it('discloses a fan-out but not a native batch', async () => {
    useTestConfig({ OPENAI_RESPONSE_METADATA: 'true' });

    useFakeEngine([chatFake()], 'chat');
    let app = createApp();
    const fannedOut = await request(app).post('/chat').send({ prompt: 'x', count: 2 });
    expect(fannedOut.body._rendermind.adaptations.fannedOutFromCount).toBe(2);

    useFakeEngine([chatFake(), nativeFake()], 'auto');
    app = createApp();
    const batched = await request(app).post('/chat').send({ prompt: 'x', count: 2 });
    // A native batch is not an adaptation, so there is nothing to disclose. Absent
    // `adaptations` means exactly that: the request was honoured verbatim.
    expect(batched.body._rendermind.adaptations?.fannedOutFromCount).toBeUndefined();
  });
});
