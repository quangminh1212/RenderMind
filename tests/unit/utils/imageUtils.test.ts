import { describe, it, expect } from 'vitest';
import { buildCacheKey, sanitizeFilename } from '../../../src/utils/imageUtils';

describe('buildCacheKey', () => {
  it('should generate a cache key from prompt parameters', () => {
    const key = buildCacheKey('a beautiful sunset', 1024, 1024, 'auto');
    expect(key).toMatch(/^img:/);
    expect(typeof key).toBe('string');
  });

  it('should include seed in key when provided', () => {
    const keyWithSeed = buildCacheKey('test', 512, 512, 'stability', 42);
    const keyWithoutSeed = buildCacheKey('test', 512, 512, 'stability');
    expect(keyWithSeed).not.toBe(keyWithoutSeed);
  });

  it('should generate different keys for different prompts', () => {
    const key1 = buildCacheKey('cat', 512, 512, 'auto');
    const key2 = buildCacheKey('dog', 512, 512, 'auto');
    expect(key1).not.toBe(key2);
  });
});

describe('sanitizeFilename', () => {
  it('should replace special characters', () => {
    expect(sanitizeFilename('hello world!')).toBe('hello_world_');
  });

  it('should truncate long names', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeFilename(long)).toHaveLength(100);
  });

  it('should allow alphanumeric, underscore, and dash', () => {
    expect(sanitizeFilename('test_file-123')).toBe('test_file-123');
  });
});
