import { describe, it, expect } from 'vitest';
import { buildCacheKey } from '../../../src/utils/imageUtils';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Regression tests for the cache-key collision bug.
 *
 * The original `buildCacheKey(prompt, width, height, backend, seed, model)` omitted
 * `negative_prompt`, `steps` and `cfg_scale`. Two requests differing only in those
 * fields produced the SAME key, so the second request was served the first's image.
 *
 * These tests pin the corrected behaviour: the key is derived from the whole normalized
 * request, so any difference that can change the output changes the key.
 */
describe('buildCacheKey — collision safety', () => {
  const base = (over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest => ({
    prompt: 'a red apple',
    count: 1,
    size: { width: 1024, height: 1024 },
    aspect: null,
    quality: null,
    output: { format: 'png', delivery: 'base64' },
    ...over,
  });

  it('is stable for identical requests', () => {
    expect(buildCacheKey(base())).toBe(buildCacheKey(base()));
  });

  it('differs when negative_prompt differs', () => {
    const a = buildCacheKey(base({ negativePrompt: 'blurry' }));
    const b = buildCacheKey(base({ negativePrompt: 'ugly' }));
    expect(a).not.toBe(b);
  });

  it('differs when steps differ', () => {
    expect(buildCacheKey(base({ steps: 20 }))).not.toBe(buildCacheKey(base({ steps: 50 })));
  });

  it('differs when guidanceScale differs', () => {
    expect(buildCacheKey(base({ guidanceScale: 7.5 }))).not.toBe(
      buildCacheKey(base({ guidanceScale: 12 })),
    );
  });

  it('differs when model differs', () => {
    expect(buildCacheKey(base({ model: 'dall-e-3' }))).not.toBe(
      buildCacheKey(base({ model: 'gpt-image-1' })),
    );
  });

  it('differs when seed differs', () => {
    expect(buildCacheKey(base({ seed: 1 }))).not.toBe(buildCacheKey(base({ seed: 2 })));
  });

  it('differs when count differs', () => {
    expect(buildCacheKey(base({ count: 1 }))).not.toBe(buildCacheKey(base({ count: 4 })));
  });

  it('differs when size differs', () => {
    expect(buildCacheKey(base({ size: { width: 512, height: 512 } }))).not.toBe(
      buildCacheKey(base({ size: { width: 1024, height: 1024 } })),
    );
  });

  it('treats an explicit negative_prompt as distinct from an absent one', () => {
    expect(buildCacheKey(base())).not.toBe(buildCacheKey(base({ negativePrompt: 'blurry' })));
  });

  it('is independent of field insertion order', () => {
    const a = buildCacheKey({
      prompt: 'x',
      negativePrompt: 'n',
      count: 1,
      size: { width: 512, height: 512 },
      aspect: null,
      quality: 'high',
      output: { format: 'png', delivery: 'base64' },
      steps: 30,
    });
    const b = buildCacheKey({
      steps: 30,
      output: { format: 'png', delivery: 'base64' },
      quality: 'high',
      aspect: null,
      size: { width: 512, height: 512 },
      count: 1,
      negativePrompt: 'n',
      prompt: 'x',
    });
    expect(a).toBe(b);
  });

  it('is prefixed so stale pre-fix keys cannot be read', () => {
    expect(buildCacheKey(base())).toMatch(/^v2:img:/);
  });

  it('does not collide on prompt/size boundary ambiguity', () => {
    // A naive `parts.join('|')` scheme lets a crafted prompt impersonate another field.
    // Hashing a canonical JSON envelope removes the class of bug entirely.
    const a = buildCacheKey(base({ prompt: 'a|1024|1024' }));
    const b = buildCacheKey(base({ prompt: 'a' }));
    expect(a).not.toBe(b);
  });
});
