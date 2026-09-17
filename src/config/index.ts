export interface AppConfig {
  server: {
    port: number;
    host: string;
    nodeEnv: string;
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
  backends: {
    stability: {
      apiKey: string;
      apiHost: string;
      enabled: boolean;
    };
    openclaw: {
      apiKey: string;
      enabled: boolean;
    };
    replicate: {
      apiToken: string;
      enabled: boolean;
    };
  };
  webhook: {
    secret?: string;
  };
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

export function loadConfig(): AppConfig {
  return {
    server: {
      port: getEnvNumber('PORT', 3000),
      host: getEnv('HOST', '0.0.0.0'),
      nodeEnv: getEnv('NODE_ENV', 'development'),
    },
    rateLimit: {
      windowMs: getEnvNumber('RATE_LIMIT_WINDOW_MS', 60000),
      maxRequests: getEnvNumber('RATE_LIMIT_MAX_REQUESTS', 60),
    },
    redis: {
      url: getEnv('REDIS_URL', 'redis://localhost:6379'),
    },
    cache: {
      ttl: getEnvNumber('CACHE_TTL', 3600),
    },
    queue: {
      concurrency: getEnvNumber('QUEUE_CONCURRENCY', 5),
    },
    backends: {
      stability: {
        apiKey: getEnv('STABILITY_API_KEY', ''),
        apiHost: getEnv('STABILITY_API_HOST', 'https://api.stability.ai'),
        enabled: !!process.env.STABILITY_API_KEY,
      },
      openclaw: {
        apiKey: getEnv('OPENAI_API_KEY', ''),
        enabled: !!process.env.OPENAI_API_KEY,
      },
      replicate: {
        apiToken: getEnv('REPLICATE_API_TOKEN', ''),
        enabled: !!process.env.REPLICATE_API_TOKEN,
      },
    },
    webhook: {
      secret: process.env.WEBHOOK_SECRET,
    },
  };
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
