import pino from 'pino';
import { getConfig } from '../config';

/**
 * Structured logger.
 *
 * Replaces the previous `console` wrapper, which emitted no level field, no service
 * name, and never carried the request id — so logs could not be correlated to a request
 * in any aggregator.
 *
 * Redaction is configured at the logger level rather than trusted to call sites: the
 * audit found upstream error bodies (which may echo an Authorization header) being
 * interpolated into log strings.
 */

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'apiKey',
  'api_key',
  'apiToken',
  'api_token',
  'password',
  'secret',
  'token',
  '*.apiKey',
  '*.api_key',
  '*.apiToken',
  '*.secret',
];

function buildLogger(): pino.Logger {
  let level = 'info';
  let pretty = false;

  try {
    const config = getConfig();
    level = process.env.LOG_LEVEL ?? (config.server.isProduction ? 'info' : 'debug');
    pretty = !config.server.isProduction;
  } catch {
    // Config may be unavailable during early bootstrap; fall back to defaults.
    level = process.env.LOG_LEVEL ?? 'info';
  }

  const options: pino.LoggerOptions = {
    level,
    base: { service: 'rendermind' },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (pretty) {
    // pino resolves the transport target by name at runtime, so there is nothing to
    // import here. If pino-pretty is absent the process exits with a clear error, which
    // is why it is a declared dependency rather than an optional one.
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
    });
  }

  return pino(options);
}

export const pinoLogger = buildLogger();

/**
 * Logger with an ergonomic `(message, context)` argument order.
 *
 * pino's native signature is `(mergingObject, message)`. Wrapping it here keeps call
 * sites readable and — more importantly — makes the *message* the stable, searchable
 * field, with structured context attached as fields rather than concatenated into the
 * message text (which is what the previous console wrapper did, and why logs could not
 * be queried).
 */
interface LogContext {
  [key: string]: unknown;
}

function withContext(level: 'debug' | 'info' | 'warn' | 'error') {
  return (message: string, context: LogContext = {}): void => {
    pinoLogger[level](context, message);
  };
}

export const logger = {
  debug: withContext('debug'),
  info: withContext('info'),
  warn: withContext('warn'),
  error: withContext('error'),
  /** Escape hatch for pino-specific features such as child loggers. */
  raw: pinoLogger,
};

/**
 * Truncate a value for logging.
 *
 * Base64 image payloads are megabytes; logging one would swamp the output and leak
 * user content. Only prefixes are ever logged.
 */
export function truncateForLog(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… (${value.length} chars)`;
}

/** Strip anything that looks like an API key from a free-text string. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
}
