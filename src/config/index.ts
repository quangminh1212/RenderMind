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

/** Coerce a string env var to a positive integer, failing loudly on garbage. */
const positiveInt = (label: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isInteger(v) && v > 0), {
      message: `${label} must be a positive integer`,
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
  QUEUE_CONCURRENCY: positiveInt('QUEUE_CONCURRENCY').transform((v) => v ?? 5),

  // ── The chat-completions backend ─────────────────────────────
  // RenderMind has exactly one class of upstream: a model that speaks
  // `/chat/completions` and is *instructed* to answer with an image. There is no native
  // image provider any more, so these four variables are the whole upstream configuration.
  CHAT_API_KEY: z.string().optional().default(''),
  CHAT_BASE_URL: z.string().default('https://api.openai.com/v1'),
  CHAT_MODEL: z.string().default('gpt-4o'),
  /** Model used when the request carries input images. Falls back to CHAT_MODEL. */
  CHAT_VISION_MODEL: z.string().optional(),
  /** Extra model ids the endpoint accepts, beyond the two above. */
  CHAT_EXTRA_MODELS: csvList,
  /** Replaces the built-in "answer with an image" system instruction. */
  CHAT_SYSTEM_PROMPT: z.string().optional(),

  WEBHOOK_SECRET: z.string().optional(),

  MAX_GENERATION_CONCURRENCY: positiveInt('MAX_GENERATION_CONCURRENCY').transform((v) => v ?? 10),
  ANTHROPIC_IMAGE_BLOCK_MODE: z.enum(['extension', 'off']).default('off'),
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
  queue: {
    concurrency: number;
  };
  engine: {
    maxConcurrency: number;
  };
  backends: {
    chat: {
      apiKey: string;
      baseUrl: string;
      defaultModel: string;
      visionModel: string;
      extraModels: string[];
      systemPrompt?: string;
    };
  };
  protocols: {
    anthropicImageBlockMode: 'extension' | 'off';
    openaiResponseMetadata: boolean;
  };
  webhook: {
    secret?: string;
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
    queue: {
      concurrency: e.QUEUE_CONCURRENCY,
    },
    engine: {
      maxConcurrency: e.MAX_GENERATION_CONCURRENCY,
    },
    backends: {
      chat: {
        apiKey: e.CHAT_API_KEY,
        baseUrl: e.CHAT_BASE_URL,
        defaultModel: e.CHAT_MODEL,
        visionModel: e.CHAT_VISION_MODEL ?? e.CHAT_MODEL,
        extraModels: e.CHAT_EXTRA_MODELS,
        systemPrompt: e.CHAT_SYSTEM_PROMPT,
      },
    },
    protocols: {
      anthropicImageBlockMode: e.ANTHROPIC_IMAGE_BLOCK_MODE,
      openaiResponseMetadata: e.OPENAI_RESPONSE_METADATA,
    },
    webhook: {
      secret: e.WEBHOOK_SECRET,
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
