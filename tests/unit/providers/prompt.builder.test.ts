import { describe, it, expect } from 'vitest';
import {
  buildImageInstruction,
  extractParts,
  foldNegativePrompt,
} from '../../../src/providers/prompt.builder';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Prompt-builder tests.
 *
 * The instruction is the entire behaviour of this engine: it is how a text-only model is
 * told to draw. These tests pin the exact string so a change to the wording — which is a
 * behaviour change, not a refactor — cannot pass unnoticed.
 */

function req(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'a red apple',
    count: 1,
    size: null,
    aspect: null,
    quality: null,
    output: { format: 'png', delivery: 'base64' },
    ...over,
  };
}

describe('buildImageInstruction', () => {
  it('asks for exactly one image by default', () => {
    const out = buildImageInstruction(req());
    expect(out).toContain('Produce exactly one image.');
    expect(out).toContain('Subject: a red apple');
  });

  it('asks for N distinct images when count > 1', () => {
    const out = buildImageInstruction(req({ count: 3 }));
    expect(out).toContain('Produce 3 distinct images');
  });

  it('folds an explicit size into the instruction', () => {
    const out = buildImageInstruction(req({ size: { width: 1024, height: 768 } }));
    expect(out).toContain('Dimensions: 1024x768 pixels.');
  });

  it('expresses the aspect ratio as a semantic label', () => {
    const out = buildImageInstruction(req({ aspect: '16:9' }));
    expect(out).toContain('Aspect ratio: 16:9 (widescreen landscape).');
  });

  it('folds the negative prompt into the instruction', () => {
    const out = buildImageInstruction(req({ negativePrompt: 'blurry, low quality' }));
    expect(out).toContain('Do not include: blurry, low quality.');
  });

  it('expands quality into something concrete', () => {
    const out = buildImageInstruction(req({ quality: 'high' }));
    expect(out).toContain('Quality: high — maximum detail and fidelity.');
  });

  it('passes the style through', () => {
    const out = buildImageInstruction(req({ style: 'oil painting' }));
    expect(out).toContain('Style: oil painting.');
  });

  it('includes the seed when pinned', () => {
    const out = buildImageInstruction(req({ seed: 42 }));
    expect(out).toContain('Use seed 42 for reproducibility.');
  });

  it('omits optional lines that were not supplied', () => {
    const out = buildImageInstruction(req());
    expect(out).not.toContain('Dimensions:');
    expect(out).not.toContain('Aspect ratio:');
    expect(out).not.toContain('Do not include:');
    expect(out).not.toContain('Style:');
    expect(out).not.toContain('Use seed');
  });

  it('ends by telling the model to answer with the image only', () => {
    expect(buildImageInstruction(req())).toContain(
      'Respond with the image only, as specified in your instructions.',
    );
  });
});

describe('extractParts', () => {
  it('normalises a size to a WxH string', () => {
    expect(extractParts(req({ size: { width: 512, height: 512 } })).size).toBe('512x512');
  });

  it('treats a missing count as at least 1', () => {
    // count is required by the type, but a defensive floor keeps a bad value from
    // producing "Produce 0 distinct images".
    expect(extractParts(req({ count: 0 })).count).toBe(1);
    expect(extractParts(req({ count: -5 })).count).toBe(1);
  });

  it('maps an unknown aspect through unchanged', () => {
    // A ratio outside the canonical union still reaches the model as text.
    const parts = extractParts(req({ aspect: '5:4' as never }));
    expect(parts.aspect).toBe('5:4');
  });

  it('leaves seed null when unset', () => {
    expect(extractParts(req()).seed).toBeNull();
  });
});

describe('foldNegativePrompt', () => {
  it('returns the prompt unchanged with no negative prompt', () => {
    expect(foldNegativePrompt('a cat')).toBe('a cat');
    expect(foldNegativePrompt('a cat', '')).toBe('a cat');
  });

  it('appends an avoid-clause when a negative prompt is given', () => {
    expect(foldNegativePrompt('a cat', 'dogs')).toBe('a cat\n\nAvoid: dogs');
  });
});
