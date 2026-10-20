import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setConfig, loadConfig } from '../../../src/config';
import { createRateLimiter } from '../../../src/middleware/rateLimiter';

/**
 * Rate limiter tests.
 *
 * Verifies the rate limiter is configured from app settings, skips health paths,
 * and emits the chat error envelope with Retry-After on 429.
 *
 * express-rate-limit is mocked so we can inspect the options passed to it
 * without mounting a real Express middleware.
 */

const capturedOptions: Record<string, unknown> = {};

vi.mock('express-rate-limit', () => {
  return {
    default: vi.fn((opts: Record<string, unknown>) => {
      Object.assign(capturedOptions, opts);
      return vi.fn((_req: unknown, _res: unknown, next: unknown) => (next as () => void)());
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset captured options
  for (const key of Object.keys(capturedOptions)) {
    delete capturedOptions[key];
  }
});

describe('createRateLimiter', () => {
  beforeEach(() => {
    setConfig(
      loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 'key',
        RATE_LIMIT_WINDOW_MS: '60000',
        RATE_LIMIT_MAX_REQUESTS: '100',
      } as NodeJS.ProcessEnv),
    );
  });

  it('creates a rate limiter with config values', () => {
    createRateLimiter();

    expect(capturedOptions.windowMs).toBe(60000);
    expect(capturedOptions.max).toBe(100);
    expect(capturedOptions.standardHeaders).toBe(true);
    expect(capturedOptions.legacyHeaders).toBe(false);
  });

  it('skips health and docs paths', () => {
    createRateLimiter();
    const skipFn = capturedOptions.skip as (req: { path: string }) => boolean;

    expect(skipFn({ path: '/health' })).toBe(true);
    expect(skipFn({ path: '/healthz' })).toBe(true);
    expect(skipFn({ path: '/readyz' })).toBe(true);
    expect(skipFn({ path: '/docs' })).toBe(true);
    expect(skipFn({ path: '/docs/openapi.json' })).toBe(true);
    expect(skipFn({ path: '/chat' })).toBe(false);
    expect(skipFn({ path: '/api/v1/images' })).toBe(false);
  });

  it('uses rateLimitBucket when available, falls back to ip', () => {
    createRateLimiter();
    const keyGen = capturedOptions.keyGenerator as (req: {
      rateLimitBucket?: string;
      ip?: string;
    }) => string;

    expect(keyGen({ rateLimitBucket: 'key:abc123' })).toBe('key:abc123');
    expect(keyGen({ ip: '192.168.1.1' })).toBe('192.168.1.1');
    expect(keyGen({})).toBe('unknown');
  });

  it('handler returns 429 with Retry-After header', () => {
    createRateLimiter();

    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    const handler = capturedOptions.handler as (req: unknown, res: typeof res) => void;
    handler({}, res);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(res.status).toHaveBeenCalledWith(429);

    const body = res.json.mock.calls[0][0];
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.code).toBe('rate_limit_exceeded');
  });
});
