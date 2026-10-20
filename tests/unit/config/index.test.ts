import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, getConfig, setConfig, resetConfig } from '../../../src/config/index';

/**
 * Configuration tests.
 *
 * Verifies:
 *   1. loadConfig validates PORT, rejects non-positive integers.
 *   2. Production requires API_KEYS unless ALLOW_UNAUTHENTICATED is set.
 *   3. Defaults are correct for every section.
 *   4. getConfig/setConfig/resetConfig form a proper singleton pattern.
 */

beforeEach(() => {
  resetConfig();
});

describe('loadConfig', () => {
  it('returns correct defaults for test environment', () => {
    const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.nodeEnv).toBe('test');
    expect(config.server.isProduction).toBe(false);

    expect(config.auth.apiKeys).toEqual([]);
    expect(config.auth.enabled).toBe(false);
    expect(config.auth.apiKeyHeader).toBe('x-api-key');

    expect(config.rateLimit.windowMs).toBe(60000);
    expect(config.rateLimit.maxRequests).toBe(60);

    expect(config.cache.ttl).toBe(3600);
    expect(config.engine.maxConcurrency).toBe(10);

    expect(config.backends.chat.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.backends.chat.defaultModel).toBe('gpt-4o');
    expect(config.backends.chat.visionModel).toBe('gpt-4o');
    expect(config.backends.chat.visionModelConfigured).toBe(false);
    // The refinement pass is opt-in, so the default must be "do nothing extra".
    expect(config.backends.chat.visionRefinementRounds).toBe(0);

    // The native backend is opt-in, so an unconfigured deployment must have nothing to
    // register: no key, and no model id to guess.
    expect(config.backends.image.apiKey).toBe('');
    expect(config.backends.image.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.backends.image.model).toBe('');
    expect(config.backends.image.extraModels).toEqual([]);
    expect(config.backends.image.supportsBatch).toBe(true);
    expect(config.providerStrategy).toBe('auto');
  });

  it('defaults IMAGE_MODEL to empty rather than guessing a vendor model', () => {
    // A default model id would be a vendor's, and guessing one registers a provider that
    // 404s upstream on every request. Absence must survive to the registry.
    const config = loadConfig({ NODE_ENV: 'test', IMAGE_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(config.backends.image.model).toBe('');
  });

  it('parses every PROVIDER_STRATEGY value', () => {
    for (const strategy of ['auto', 'chat', 'native'] as const) {
      const config = loadConfig({
        NODE_ENV: 'test',
        PROVIDER_STRATEGY: strategy,
      } as NodeJS.ProcessEnv);
      expect(config.providerStrategy).toBe(strategy);
    }
  });

  // ── Chat render mode ───────────────────────────────────────

  it('defaults CHAT_RENDER_MODE to svg', () => {
    const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    // The default must be the historical behaviour: a build without this variable asked for
    // an SVG document, and it still does.
    expect(config.backends.chat.renderMode).toBe('svg');
  });

  it('parses CHAT_RENDER_MODE=scene', () => {
    const config = loadConfig({ NODE_ENV: 'test', CHAT_RENDER_MODE: 'scene' } as NodeJS.ProcessEnv);
    expect(config.backends.chat.renderMode).toBe('scene');
  });

  it('rejects an unrecognised CHAT_RENDER_MODE rather than falling back', () => {
    // A typo in a switch that changes what the model is asked for must be a startup error,
    // not a silent fallback to a different contract.
    expect(() =>
      loadConfig({ NODE_ENV: 'test', CHAT_RENDER_MODE: 'pixels' } as NodeJS.ProcessEnv),
    ).toThrow(/CHAT_RENDER_MODE/);
  });

  // ── Native prompt planner ──────────────────────────────────

  it('defaults the prompt planner to disabled', () => {
    const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

    // Off by default is the whole contract: an unconfigured deployment must make no extra
    // upstream call and send byte-identical prompts.
    expect(config.backends.image.promptPlanner.enabled).toBe(false);
    expect(config.backends.image.promptPlanner.model).toBe('');
    expect(config.backends.image.promptPlanner.maxTokens).toBe(400);
  });

  it('enables the planner only when a model and a key are resolvable', () => {
    const enabled = loadConfig({
      NODE_ENV: 'test',
      IMAGE_API_KEY: 'image-key',
      IMAGE_MODEL: 'dall-e-3',
      IMAGE_PROMPT_PLANNER_MODEL: 'planner-model',
    } as NodeJS.ProcessEnv);

    expect(enabled.backends.image.promptPlanner.enabled).toBe(true);
    expect(enabled.backends.image.promptPlanner.model).toBe('planner-model');
    // Base URL and key fall back to the native endpoint's, so naming a model is enough.
    expect(enabled.backends.image.promptPlanner.baseUrl).toBe('https://api.openai.com/v1');
    expect(enabled.backends.image.promptPlanner.apiKey).toBe('image-key');
  });

  it('keeps the planner disabled when a model is named but no key exists', () => {
    // A half-configured planner cannot be called; it is reported as disabled rather than
    // registered half-configured, the same honesty rule the native provider follows.
    const config = loadConfig({
      NODE_ENV: 'test',
      IMAGE_PROMPT_PLANNER_MODEL: 'planner-model',
    } as NodeJS.ProcessEnv);

    expect(config.backends.image.promptPlanner.enabled).toBe(false);
  });

  it('honours an explicit planner base URL and key over the native fallbacks', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      IMAGE_API_KEY: 'image-key',
      IMAGE_BASE_URL: 'https://images.example.com/v1',
      IMAGE_PROMPT_PLANNER_MODEL: 'planner-model',
      IMAGE_PROMPT_PLANNER_BASE_URL: 'https://chat.example.com/v1',
      IMAGE_PROMPT_PLANNER_API_KEY: 'planner-key',
    } as NodeJS.ProcessEnv);

    expect(config.backends.image.promptPlanner.enabled).toBe(true);
    expect(config.backends.image.promptPlanner.baseUrl).toBe('https://chat.example.com/v1');
    expect(config.backends.image.promptPlanner.apiKey).toBe('planner-key');
  });

  it('rejects a planner token budget above the ceiling', () => {
    // A planner answer is a prompt; a huge budget is a huge bill for no benefit.
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        IMAGE_PROMPT_PLANNER_MAX_TOKENS: '5000',
      } as NodeJS.ProcessEnv),
    ).toThrow('IMAGE_PROMPT_PLANNER_MAX_TOKENS');
  });

  it('rejects a non-integer planner token budget', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        IMAGE_PROMPT_PLANNER_MAX_TOKENS: 'lots',
      } as NodeJS.ProcessEnv),
    ).toThrow('Invalid configuration');
  });

  // ── Chat vision refinement ─────────────────────────────────

  it('parses CHAT_VISION_REFINEMENT_ROUNDS as a bounded non-negative integer', () => {
    expect(
      loadConfig({ NODE_ENV: 'test', CHAT_VISION_REFINEMENT_ROUNDS: '2' } as NodeJS.ProcessEnv)
        .backends.chat.visionRefinementRounds,
    ).toBe(2);

    // Explicit zero is the same as unset: the pass is off.
    expect(
      loadConfig({ NODE_ENV: 'test', CHAT_VISION_REFINEMENT_ROUNDS: '0' } as NodeJS.ProcessEnv)
        .backends.chat.visionRefinementRounds,
    ).toBe(0);
  });

  it('rejects a refinement round count that is not a non-negative integer', () => {
    for (const value of ['-1', '1.5', 'lots']) {
      expect(() =>
        loadConfig({
          NODE_ENV: 'test',
          CHAT_VISION_REFINEMENT_ROUNDS: value,
        } as NodeJS.ProcessEnv),
      ).toThrow('Invalid configuration');
    }
  });

  it('rejects a refinement round count above the ceiling', () => {
    // Each round is two extra upstream calls. An unbounded value — a typo, a stray digit —
    // would turn one client request into an open-ended spend on the operator's key, so the
    // ceiling is a startup error rather than a clamp applied silently at runtime.
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        CHAT_VISION_REFINEMENT_ROUNDS: '6',
      } as NodeJS.ProcessEnv),
    ).toThrow('CHAT_VISION_REFINEMENT_ROUNDS');
  });

  it('rejects an unknown PROVIDER_STRATEGY at startup', () => {
    // A typo in a routing switch must not silently fall back to `auto`: that would change
    // which upstream is billed without anyone being told.
    expect(() =>
      loadConfig({ NODE_ENV: 'test', PROVIDER_STRATEGY: 'nativ' } as NodeJS.ProcessEnv),
    ).toThrow('Invalid configuration');
  });

  it('throws on invalid PORT (non-numeric)', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(
      'Invalid configuration',
    );
  });

  it('throws on invalid PORT (negative)', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: '-1' } as NodeJS.ProcessEnv)).toThrow(
      'Invalid configuration',
    );
  });

  it('throws on invalid PORT (zero)', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: '0' } as NodeJS.ProcessEnv)).toThrow(
      'Invalid configuration',
    );
  });

  it('uses configured PORT', () => {
    const config = loadConfig({ NODE_ENV: 'test', PORT: '8080' } as NodeJS.ProcessEnv);
    expect(config.server.port).toBe(8080);
  });

  it('production requires API_KEYS when not allowing unauthenticated', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      'Refusing to start in production without authentication',
    );
  });

  it('production allows empty API_KEYS when ALLOW_UNAUTHENTICATED=true', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        ALLOW_UNAUTHENTICATED: 'true',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('production accepts API_KEYS', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      API_KEYS: 'key1,key2',
    } as NodeJS.ProcessEnv);

    expect(config.auth.apiKeys).toEqual(['key1', 'key2']);
    expect(config.auth.enabled).toBe(true);
    expect(config.server.isProduction).toBe(true);
  });

  it('parses comma-separated API_KEYS', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      API_KEYS: 'k1, k2 ,k3',
    } as NodeJS.ProcessEnv);

    expect(config.auth.apiKeys).toEqual(['k1', 'k2', 'k3']);
  });

  it('parses comma-separated CORS_ORIGINS', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CORS_ORIGINS: 'https://a.com, https://b.com',
    } as NodeJS.ProcessEnv);

    expect(config.cors.origins).toEqual(['https://a.com', 'https://b.com']);
  });

  it('defaults CORS_ORIGINS to * in non-production', () => {
    const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(config.cors.origins).toEqual(['*']);
  });

  it('defaults CORS_ORIGINS to [] in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      API_KEYS: 'k',
    } as NodeJS.ProcessEnv);
    expect(config.cors.origins).toEqual([]);
  });

  it('handles all config fields', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      PORT: '4000',
      HOST: '127.0.0.1',
      API_KEYS: 'mykey',
      API_KEY_HEADER: 'x-my-key',
      ALLOW_UNAUTHENTICATED: 'true',
      RATE_LIMIT_WINDOW_MS: '120000',
      RATE_LIMIT_MAX_REQUESTS: '200',
      REDIS_URL: 'redis://custom:6379',
      CACHE_TTL: '7200',
      CHAT_API_KEY: 'chat-key',
      CHAT_BASE_URL: 'https://custom.api/v1',
      CHAT_MODEL: 'custom-model',
      CHAT_VISION_MODEL: 'vision-model',
      CHAT_VISION_REFINEMENT_ROUNDS: '2',
      CHAT_EXTRA_MODELS: 'extra1,extra2',
      CHAT_SYSTEM_PROMPT: 'Custom prompt',
      IMAGE_API_KEY: 'image-key',
      IMAGE_BASE_URL: 'https://litellm.internal/v1',
      IMAGE_MODEL: 'dall-e-3',
      IMAGE_EXTRA_MODELS: 'flux-1,sdxl',
      IMAGE_SUPPORTS_BATCH: 'false',
      PROVIDER_STRATEGY: 'native',
      MAX_GENERATION_CONCURRENCY: '20',
      OPENAI_RESPONSE_METADATA: 'true',
      HEALTH_REQUIRE_REDIS: 'true',
    } as NodeJS.ProcessEnv);

    expect(config.server.port).toBe(4000);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.auth.apiKeyHeader).toBe('x-my-key');
    expect(config.auth.allowUnauthenticated).toBe(true);
    expect(config.rateLimit.windowMs).toBe(120000);
    expect(config.rateLimit.maxRequests).toBe(200);
    expect(config.redis.url).toBe('redis://custom:6379');
    expect(config.cache.ttl).toBe(7200);
    expect(config.backends.chat.apiKey).toBe('chat-key');
    expect(config.backends.chat.baseUrl).toBe('https://custom.api/v1');
    expect(config.backends.chat.defaultModel).toBe('custom-model');
    expect(config.backends.chat.visionModel).toBe('vision-model');
    expect(config.backends.chat.visionModelConfigured).toBe(true);
    expect(config.backends.chat.visionRefinementRounds).toBe(2);
    expect(config.backends.chat.extraModels).toEqual(['extra1', 'extra2']);
    expect(config.backends.chat.systemPrompt).toBe('Custom prompt');
    expect(config.backends.image.apiKey).toBe('image-key');
    expect(config.backends.image.baseUrl).toBe('https://litellm.internal/v1');
    expect(config.backends.image.model).toBe('dall-e-3');
    expect(config.backends.image.extraModels).toEqual(['flux-1', 'sdxl']);
    expect(config.backends.image.supportsBatch).toBe(false);
    expect(config.providerStrategy).toBe('native');
    expect(config.engine.maxConcurrency).toBe(20);
    expect(config.protocols.openaiResponseMetadata).toBe(true);
    expect(config.health.requireRedis).toBe(true);
  });
});

describe('getConfig / setConfig / resetConfig', () => {
  it('getConfig returns cached config after first call', () => {
    const config1 = getConfig();
    const config2 = getConfig();
    expect(config1).toBe(config2); // same reference
  });

  it('setConfig replaces the cached config', () => {
    const original = getConfig();
    const custom = { ...original, server: { ...original.server, port: 9999 } };
    setConfig(custom);

    expect(getConfig().server.port).toBe(9999);
    expect(getConfig()).toBe(custom);
  });

  it('resetConfig clears the cache so next getConfig reloads', () => {
    const config1 = getConfig();
    resetConfig();
    const config2 = getConfig();
    // After reset, a fresh config is loaded from process.env
    expect(config2).not.toBe(config1);
  });
});
