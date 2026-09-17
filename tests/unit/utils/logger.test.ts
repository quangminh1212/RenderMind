import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger, LogLevel } from '../../../src/utils/logger';

describe('Logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should log info messages', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('test message');
    expect(spy).toHaveBeenCalled();
  });

  it('should log error messages', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('error message');
    expect(spy).toHaveBeenCalled();
  });

  it('should include meta in log output', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('test', { key: 'value' });
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('key');
    expect(output).toContain('value');
  });
});
