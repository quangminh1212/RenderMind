import { describe, it, expect } from 'vitest';
import { logger, truncateForLog, redactSecrets, pinoLogger } from '../../../src/utils/logger';

/**
 * Logger tests.
 *
 * The previous wrapper logged to the console with string concatenation, so it had no
 * level field, no service name and no request correlation — a log line could not be
 * joined to a request in any aggregator. These tests assert the structured contract.
 */

describe('logger', () => {
  it('exposes the standard level methods', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(typeof logger[level]).toBe('function');
    }
  });

  it('is a real pino instance underneath', () => {
    expect(typeof pinoLogger.child).toBe('function');
    expect(pinoLogger.level).toBeDefined();
  });

  it('accepts a message and structured context without throwing', () => {
    expect(() => logger.info('test message')).not.toThrow();
    expect(() => logger.info('with context', { key: 'value' })).not.toThrow();
    expect(() => logger.error('failure', { requestId: 'req_1', code: 'bad' })).not.toThrow();
  });
});

describe('truncateForLog', () => {
  it('leaves short values intact', () => {
    expect(truncateForLog('short')).toBe('short');
  });

  it('truncates long values and reports the original length', () => {
    // Base64 image payloads are megabytes; logging one would swamp the output
    // and leak user content.
    const long = 'a'.repeat(5000);
    const out = truncateForLog(long, 100);
    expect(out.length).toBeLessThan(140);
    expect(out).toContain('5000 chars');
  });
});

describe('redactSecrets', () => {
  it('masks API-key-shaped strings', () => {
    expect(redactSecrets('key is sk-abcdefghijklmnop')).toContain('[redacted]');
    expect(redactSecrets('key is sk-abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('masks bearer tokens', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('a red apple on a table')).toBe('a red apple on a table');
  });
});
