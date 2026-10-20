import { z } from 'zod';

/**
 * Configuration schema — validated once at boot.
 *
 * The previous implementation read env vars ad hoc with `parseInt` and no validation:
 * `PORT=abc` yielded `NaN` straight into `app.listen`, and contradictory settings
 * (a base URL with no API key) silently produced a provider that advertised as
 * available and then failed upstream on every request.
 *
 * Validating here means a misconfiguration is a clear startup error naming the bad
 * variable, rather than a confusing runtime failure much later.
 */

/**
 * Which provider class serves a request.
 *
 * `auto` prefers the native endpoint and keeps chat as a declared failover; `chat` pins
 * the historical behaviour; `native` serves only from the native endpoint.
 */
export type ProviderStrategy = 'auto' | 'chat' | 'native';

/**
 * How the chat provider asks a text-only model to describe a picture.
 *
 * `svg` (the default) is the historical behaviour, unchanged: the model is instructed to
 * answer with one complete SVG document, and every byte of that contract still holds.
 *
 * `scene` is opt-in and additive: the model is asked instead for a compact **JSON scene** —
 * layers of typed geometry, never pixels and never raw SVG — which is compiled here through
 * the platform's own `compileTextScene` gate into the final SVG. That gate is what makes the
 * mode safe: the model's JSON is validated and normalized before a single byte is drawn, so a
 * malformed or hostile payload is refused with a stable code rather than rendered.
 *
 * The two modes converge at the *same* delivery path: whatever the compiler returns is a
 * validated SVG document, and `deliver` rasterizes it to PNG or passes it through when the
 * caller asked for `svg`. So a scene request and an SVG request produce the same kinds of
 * payload — only the instruction sent upstream and the parse that reads the reply differ.
 */
export type RenderMode = 'svg' | 'scene';

/** Coerce a string env var to a positive integer, failing loudly on garbage. */ const positiveInt =
  (label: string) =>
    z
      .string()
      .optional()
      .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
      .refine((v) => v === undefined || (Number.isInteger(v) && v > 0), {
        message: `${label} must be a positive integer`,
      });

/**
 * Coerce a string env var to a bounded non-negative integer.
 *
 * A separate schema from `positiveInt` rather than a relaxed copy of it, because the
 * meaning of `0` differs between them: for a port or a concurrency cap, zero is a
 * misconfiguration, while for an opt-in *count of extra rounds* zero is the documented
 * default and means "do not do this at all".
 *
 * The upper bound is not decoration. Each round is two further upstream calls, so an
 * unbounded value — a typo, a stray digit — turns one client request into an open-ended
 * spend on the operator's key. The ceiling makes that a startup error instead.
 */
const boundedCount = (label: string, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0), {
      message: `${label} must be an integer of 0 or greater`,
    })
    .refine((v) => v === undefined || v <= max, {
      message: `${label} must not exceed ${max}`,
    });

/** A comma-separated list; empty/absent becomes an empty array. */
const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v.toLowerCase() === 'true'));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: positiveInt('PORT').transform((v) => v ?? 3000),
  HOST: z.string().default('0.0.0.0'),

  API_KEYS: csvList,
  API_KEY_HEADER: z.string().default('x-api-key'),
  ALLOW_UNAUTHENTICATED: booleanish(false),

  CORS_ORIGINS: csvList,

  RATE_LIMIT_WINDOW_MS: positiveInt('RATE_LIMIT_WINDOW_MS').transform((v) => v ?? 60000),
  RATE_LIMIT_MAX_REQUESTS: positiveInt('RATE_LIMIT_MAX_REQUESTS').transform((v) => v ?? 60),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  CACHE_TTL: positiveInt('CACHE_TTL').transform((v) => v ?? 3600),

  // ── The chat-completions backend ─────────────────────────────
  // A model that speaks `/chat/completions` and is *instructed* to answer with an image.
  // This is the honest fallback: it needs no image-capable upstream, and it is the only
  // path that can produce vector output (`format: 'svg'`) or accept reference images.
  CHAT_API_KEY: z.string().optional().default(''),
  CHAT_BASE_URL: z.string().default('https://api.openai.com/v1'),
  CHAT_MODEL: z.string().default('gpt-4o'),
  /** Maximum completion tokens reserved for the SVG drawing turn. */
  CHAT_MAX_TOKENS: positiveInt('CHAT_MAX_TOKENS')
    .transform((v) => v ?? 8192)
    .refine((v) => v <= 16384, {
      message: 'CHAT_MAX_TOKENS must not exceed 16384',
    }),
  /** Model used when the request carries input images. Falls back to CHAT_MODEL. */
  CHAT_VISION_MODEL: z.string().optional(),
  /**
   * Extra review + revision passes for the chat path. `0` (the default) disables them.
   *
   * Opt-in on purpose: a refinement round is two more upstream calls (one vision review,
   * one revision), so a deployment that does not ask for it must keep paying for exactly
   * one call per image — which is what every existing test and every existing caller
   * assumes. Only when this is greater than zero *and* CHAT_VISION_MODEL was explicitly
   * configured does the round run at all; see `ChatProvider`.
   */
  CHAT_VISION_REFINEMENT_ROUNDS: boundedCount('CHAT_VISION_REFINEMENT_ROUNDS', 5).transform(
    (v) => v ?? 0,
  ),
  /** Extra model ids the endpoint accepts, beyond the two above. */
  CHAT_EXTRA_MODELS: csvList,
  /** Replaces the built-in "answer with an image" system instruction. */
  CHAT_SYSTEM_PROMPT: z.string().optional(),
  /**
   * How the model is asked to describe a picture.
   *
   *   svg   — the default; the model answers with one complete SVG document.
   *   scene — the model answers with a compact JSON scene that RenderMind compiles and
   *           validates itself before rendering.
   *
   * An unrecognised value is a startup error rather than a silent fallback, for the same
   * reason `PROVIDER_STRATEGY` is validated: a typo in a switch that changes what the model
   * is asked to produce must not quietly change the whole contract.
   */
  CHAT_RENDER_MODE: z.enum(['svg', 'scene']).default('svg'),

  // ── The native image backend ─────────────────────────────────
  // A real image-generation endpoint, `POST {IMAGE_BASE_URL}/images/generations`, as
  // exposed by LiteLLM or an openclaw-compatible image service. It returns actual pixels
  // rather than a drawing a language model composed, which is what makes it worth having.
  //
  // It is *optional*: with no IMAGE_API_KEY the native provider is never registered, so
  // zero-config behaviour is byte-identical to the chat-only build.
  IMAGE_API_KEY: z.string().optional().default(''),
  IMAGE_BASE_URL: z.string().default('https://api.openai.com/v1'),
  /** Model sent as `model` on every native call. Required when the provider is enabled. */
  IMAGE_MODEL: z.string().optional(),
  /** Extra model ids the endpoint accepts, beyond IMAGE_MODEL. */
  IMAGE_EXTRA_MODELS: csvList,
  /** Whether this images endpoint accepts `n > 1`; false makes RenderMind fan out safely. */
  IMAGE_SUPPORTS_BATCH: booleanish(true),

  // ── Optional: LLM prompt expansion for the native path ───────
  // A chat-completions model that rewrites a short caller prompt into a richer one before
  // the native image endpoint sees it. Off by default: with no model id (or no key) the
  // planner is not constructed at all, so zero-config behaviour is byte-identical to a build
  // without this feature — same bytes upstream, same latency, no extra call.
  //
  // It does NOT turn a text model into a diffusion model. The image is still produced by the
  // native endpoint; the planner only rewrites words. Kept a separate key from CHAT_API_KEY
  // because CHAT_API_KEY is the *drawing* fallback and conflating the two would enable the
  // planner for an operator who never asked for it.
  /** Chat model that expands the prompt. Empty (the default) disables the planner. */
  IMAGE_PROMPT_PLANNER_MODEL: z.string().optional().default(''),
  /** Endpoint for the planner model. Defaults to the native image base URL. */
  IMAGE_PROMPT_PLANNER_BASE_URL: z.string().optional().default(''),
  /** Bearer token for the planner. Empty falls back to IMAGE_API_KEY. */
  IMAGE_PROMPT_PLANNER_API_KEY: z.string().optional().default(''),
  /** Completion-token budget for one planner turn. Bounded; a planner answer is a prompt. */
  IMAGE_PROMPT_PLANNER_MAX_TOKENS: positiveInt('IMAGE_PROMPT_PLANNER_MAX_TOKENS')
    .transform((v) => v ?? 400)
    .refine((v) => v <= 4000, {
      message: 'IMAGE_PROMPT_PLANNER_MAX_TOKENS must not exceed 4000',
    }),

  /**
   * Which provider class serves a request.
   *
   *   auto   — prefer the native endpoint when it is configured, chat as failover
   *   chat   — pin the previous behaviour exactly (the chat-completions path only)
   *   native — serve from the native endpoint only
   *
   * An unrecognised value is a startup error rather than a silent fallback to `auto`:
   * a typo in a routing switch must not quietly change which upstream is billed.
   */
  PROVIDER_STRATEGY: z.enum(['auto', 'chat', 'native']).default('auto'),

  MAX_GENERATION_CONCURRENCY: positiveInt('MAX_GENERATION_CONCURRENCY').transform((v) => v ?? 10),
  /** Emit the non-standard `_rendermind` block on openclaw responses. */
  OPENAI_RESPONSE_METADATA: booleanish(false),
  HEALTH_REQUIRE_REDIS: booleanish(false),
});

export interface AppConfig {
  server: {
    port: number;
    host: string;
    nodeEnv: string;
    isProduction: boolean;
  };
  auth: {
    apiKeyHeader: string;
    apiKeys: string[];
    enabled: boolean;
    allowUnauthenticated: boolean;
  };
  cors: {
    origins: string[];
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  redis: {
    url: string;
  };
  cache: {
    ttl: number;
  };
  engine: {
    maxConcurrency: number;
  };
  backends: {
    chat: {
      apiKey: string;
      baseUrl: string;
      defaultModel: string;
      /** Completion-token budget for drawing and revision turns. */
      maxTokens: number;
      visionModel: string;
      /** True only when CHAT_VISION_MODEL was explicitly supplied. */
      visionModelConfigured: boolean;
      /**
       * Extra vision-review + revision passes for the chat path. `0` means the provider
       * makes exactly the one call it always has.
       */
      visionRefinementRounds: number;
      extraModels: string[];
      systemPrompt?: string;
      /**
       * How the model is asked to describe a picture: `svg` (the default) asks for one
       * complete SVG document; `scene` asks for a compact JSON scene that the platform
       * compiles and validates itself before rendering. Both converge on the same delivery
       * path and the same requested output format.
       */
      renderMode: RenderMode;
    };
    image: {
      /** Empty means the native provider is not registered at all. */
      apiKey: string;
      baseUrl: string;
      /** Empty means the provider has nothing to call. */
      model: string;
      extraModels: string[];
      /** False for image backends that reject the openclaw `n` field or only return one image. */
      supportsBatch: boolean;
      /**
       * Optional LLM prompt expansion for the native path.
       *
       * `enabled: false` (the default, and what an unset model id produces) means no planner
       * is constructed, so the native provider never makes the extra call. `baseUrl` and
       * `apiKey` are resolved here — falling back to the native image endpoint and its key —
       * so the registry never has to know the fallback rules.
       */
      promptPlanner: {
        enabled: boolean;
        model: string;
        baseUrl: string;
        apiKey: string;
        maxTokens: number;
      };
    };
  };
  /** Which provider class wins a request, and whether failover crosses classes. */
  providerStrategy: ProviderStrategy;
  protocols: {
    openaiResponseMetadata: boolean;
  };
  health: {
    requireRedis: boolean;
  };
}

/**
 * Load and validate configuration from the environment.
 *
 * @throws when any variable is invalid, listing every offending variable at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const report = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${report}`);
  }

  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  // The planner is enabled by a *model id*, mirroring the way the native backend itself is
  // enabled. Base URL and key fall back to the native endpoint's, so an operator pointing the
  // planner at the same gateway only has to name a model. A planner that names a model but
  // resolves to no key at all cannot be called; it is reported as disabled rather than
  // registered half-configured, the same honesty rule the native provider follows.
  const plannerModel = e.IMAGE_PROMPT_PLANNER_MODEL.trim();
  const plannerApiKey = e.IMAGE_PROMPT_PLANNER_API_KEY || e.IMAGE_API_KEY;
  const plannerBaseUrl = e.IMAGE_PROMPT_PLANNER_BASE_URL || e.IMAGE_BASE_URL;
  const plannerEnabled = plannerModel.length > 0 && plannerApiKey.length > 0;

  // Production must not silently run as an open proxy that drains upstream API keys.
  if (isProduction && e.API_KEYS.length === 0 && !e.ALLOW_UNAUTHENTICATED) {
    throw new Error(
      'Refusing to start in production without authentication. ' +
        'Set API_KEYS to a comma-separated list of keys, ' +
        'or set ALLOW_UNAUTHENTICATED=true to explicitly accept an open endpoint.',
    );
  }

  return {
    server: {
      port: e.PORT,
      host: e.HOST,
      nodeEnv: e.NODE_ENV,
      isProduction,
    },
    auth: {
      apiKeyHeader: e.API_KEY_HEADER,
      apiKeys: e.API_KEYS,
      enabled: e.API_KEYS.length > 0,
      allowUnauthenticated: e.ALLOW_UNAUTHENTICATED,
    },
    cors: {
      origins: e.CORS_ORIGINS.length > 0 ? e.CORS_ORIGINS : isProduction ? [] : ['*'],
    },
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_MS,
      maxRequests: e.RATE_LIMIT_MAX_REQUESTS,
    },
    redis: {
      url: e.REDIS_URL,
    },
    cache: {
      ttl: e.CACHE_TTL,
    },
    engine: {
      maxConcurrency: e.MAX_GENERATION_CONCURRENCY,
    },
    backends: {
      chat: {
        apiKey: e.CHAT_API_KEY,
        baseUrl: e.CHAT_BASE_URL,
        defaultModel: e.CHAT_MODEL,
        maxTokens: e.CHAT_MAX_TOKENS,
        visionModel: e.CHAT_VISION_MODEL ?? e.CHAT_MODEL,
        visionModelConfigured: Boolean(e.CHAT_VISION_MODEL?.trim()),
        visionRefinementRounds: e.CHAT_VISION_REFINEMENT_ROUNDS,
        extraModels: e.CHAT_EXTRA_MODELS,
        systemPrompt: e.CHAT_SYSTEM_PROMPT,
        renderMode: e.CHAT_RENDER_MODE,
      },
      image: {
        apiKey: e.IMAGE_API_KEY,
        baseUrl: e.IMAGE_BASE_URL,
        // No default model: a native endpoint's model ids are the vendor's, and guessing
        // one would register a provider that 404s upstream on every request. A missing
        // model is reported as an unconfigured provider instead.
        model: e.IMAGE_MODEL ?? '',
        extraModels: e.IMAGE_EXTRA_MODELS,
        supportsBatch: e.IMAGE_SUPPORTS_BATCH,
        promptPlanner: {
          enabled: plannerEnabled,
          model: plannerModel,
          baseUrl: plannerBaseUrl,
          apiKey: plannerApiKey,
          maxTokens: e.IMAGE_PROMPT_PLANNER_MAX_TOKENS,
        },
      },
    },
    providerStrategy: e.PROVIDER_STRATEGY,
    protocols: {
      openaiResponseMetadata: e.OPENAI_RESPONSE_METADATA,
    },
    health: {
      requireRedis: e.HEALTH_REQUIRE_REDIS,
    },
  };
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

export function setConfig(config: AppConfig): void {
  _config = config;
}

export function resetConfig(): void {
  _config = null;
}
