import { describe, it, expect } from 'vitest';
import {
  toChatResponse,
  toChatError,
  satisfiesDelivery,
  imageFingerprint,
  describeImage,
} from '../../../src/utils/formatAdapters';
import type { ImageGenerationResult } from '../../../src/types/canonical.types';

/**
 * Response-builder tests.
 *
 * The contract these pin: the requested delivery format is honoured strictly, the error
 * envelope classifies causes correctly, and nothing is silently substituted.
 *
 * (The earlier suite covered the openclaw and Anthropic builders; those were removed with
 * the protocol bridges they served.)
 */

function result(over: Partial<ImageGenerationResult> = {}): ImageGenerationResult {
  return {
    images: [{ base64: 'AAAA', mime: 'image/png' }],
    provider: 'chat',
    model: 'gpt-4o',
    timings: { queueMs: 0, providerMs: 12, totalMs: 15 },
    cached: false,
    adaptations: {},
    ...over,
  };
}

const options = {
  delivery: 'base64' as const,
  created: 1000,
  generationId: 'gen_abc',
  includeMetadata: false,
};

describe('toChatResponse', () => {
  it('emits base64 when base64 delivery is requested', () => {
    const out = toChatResponse(result(), options);
    expect(out.object).toBe('image.generation');
    expect(out.images[0].base64).toBe('AAAA');
    expect(out.images[0].url).toBeUndefined();
    expect(out.timings.total_ms).toBe(15);
  });

  it('inlines a base64-only image as a data URI when url delivery is requested', () => {
    const out = toChatResponse(result(), { ...options, delivery: 'url' });
    expect(out.images[0].url).toBe('data:image/png;base64,AAAA');
    expect(out.images[0].base64).toBeUndefined();
  });

  it('passes through a provider URL unchanged', () => {
    const out = toChatResponse(
      result({ images: [{ url: 'https://cdn/x.png', mime: 'image/png' }] }),
      { ...options, delivery: 'url' },
    );
    expect(out.images[0].url).toBe('https://cdn/x.png');
  });

  it('never substitutes a URL when base64 was requested and only a URL exists', () => {
    const out = toChatResponse(
      result({ images: [{ url: 'https://cdn/x.png', mime: 'image/png' }] }),
      options,
    );
    // The payload the caller asked for is absent rather than replaced.
    expect(out.images[0].base64).toBeUndefined();
    expect(out.images[0].url).toBeUndefined();
  });

  it('carries revised_prompt through', () => {
    const out = toChatResponse(
      result({ images: [{ base64: 'AAAA', mime: 'image/png', revisedPrompt: 'a red apple' }] }),
      options,
    );
    expect(out.images[0].revised_prompt).toBe('a red apple');
  });

  it('omits _rendermind by default', () => {
    expect(toChatResponse(result(), options)._rendermind).toBeUndefined();
  });

  it('includes _rendermind when enabled', () => {
    const out = toChatResponse(result({ cached: true }), { ...options, includeMetadata: true });
    expect(out._rendermind).toMatchObject({ cached: true });
  });

  it('surfaces adaptations in _rendermind when present', () => {
    const out = toChatResponse(result({ adaptations: { fannedOutFromCount: 3 } }), {
      ...options,
      includeMetadata: true,
    });
    expect(out._rendermind?.adaptations).toMatchObject({ fannedOutFromCount: 3 });
  });
});

describe('toChatError', () => {
  it('classifies a 4xx as invalid_request_error', () => {
    expect(toChatError('bad', 400).error.type).toBe('invalid_request_error');
  });

  it('classifies a 429 as rate_limit_error', () => {
    expect(toChatError('slow down', 429).error.type).toBe('rate_limit_error');
  });

  it('classifies a 5xx as server_error', () => {
    expect(toChatError('boom', 502).error.type).toBe('server_error');
  });

  it('maps unsupported_output onto unsupported_capability', () => {
    const body = toChatError('no image', 422, null, 'unsupported_output');
    expect(body.error.type).toBe('unsupported_capability');
    expect(body.error.code).toBe('unsupported_output');
  });
});

describe('satisfiesDelivery', () => {
  it('is true when every image carries the requested payload', () => {
    expect(satisfiesDelivery(result(), 'base64', 1)).toBe(true);
  });

  it('is false when fewer images were produced than requested', () => {
    expect(satisfiesDelivery(result(), 'base64', 2)).toBe(false);
  });

  it('is false when a requested base64 payload is missing', () => {
    const r = result({ images: [{ url: 'https://cdn/x.png', mime: 'image/png' }] });
    expect(satisfiesDelivery(r, 'base64', 1)).toBe(false);
  });
});

describe('imageFingerprint', () => {
  it('is stable for the same content', () => {
    const a = imageFingerprint({ base64: 'AAAA', mime: 'image/png' });
    const b = imageFingerprint({ base64: 'AAAA', mime: 'image/png' });
    expect(a).toBe(b);
  });

  it('differs for different content', () => {
    const a = imageFingerprint({ base64: 'AAAA', mime: 'image/png' });
    const b = imageFingerprint({ base64: 'BBBB', mime: 'image/png' });
    expect(a).not.toBe(b);
  });
});

describe('describeImage', () => {
  it('describes a URL image', () => {
    expect(describeImage({ url: 'https://cdn/x.png', mime: 'image/png' })).toBe(
      'https://cdn/x.png',
    );
  });

  it('describes a base64 image without leaking the payload', () => {
    expect(describeImage({ base64: 'AAAA', mime: 'image/png' })).toMatch(
      /<base64 image\/png, 4 chars>/,
    );
  });
});
