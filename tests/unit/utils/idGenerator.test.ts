import { describe, it, expect } from 'vitest';
import { generateId } from '../../../src/utils/idGenerator';

describe('generateId', () => {
  it('should generate an id with default prefix', () => {
    const id = generateId();
    expect(id).toMatch(/^gen_[a-f0-9]{16}$/);
  });

  it('should generate an id with custom prefix', () => {
    const id = generateId('batch');
    expect(id).toMatch(/^batch_[a-f0-9]{16}$/);
  });

  it('should generate unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});
