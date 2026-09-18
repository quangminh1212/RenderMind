import { describe, it, expect } from 'vitest';
import { buildPlan } from '../../../src/engine/capability.matcher';
import { UnsupportedCapabilityError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';
import type { CapabilityDescriptor, SizeSpec } from '../../../src/types/capability.types';

/**
 * Table-driven tests for capability negotiation.
 *
 * The matcher is pure and synchronous by design, so every negotiation decision is
 * expressible as a (request × descriptors) → plan case rather than an integration test
 * against a live provider.
 */

const DISCRETE_DALLE3: SizeSpec = {
  kind: 'discrete',
  sizes: [
    { width: 1024, height: 1024 },
    { width: 1024, height: 1792 },
    { width: 1792, height: 1024 },
  ],
};

const RANGE_SDXL: SizeSpec = { kind: 'range', min: 64, max: 2048, multiple: 64 };

function descriptor(over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    provider: 'test',
    displayName: 'Test',
    models: [
      {
        id: 'test-model',
        aspectRatios: [],
        sizes: RANGE_SDXL,
        qualityLevels: ['standard'],
        outputFormats: ['png'],
      },
    ],
    features: {
      negativePrompt: true,
      seed: true,
      steps: true,
      guidanceScale: true,
      quality: false,
      style: false,
      batch: false,
      imageToImage: false,
      inpainting: false,
      revisedPrompt: false,
      nativeBase64: true,
      nativeUrl: false,
    },
    limits: {
      maxBatch: 1,
      maxPromptChars: 4000,
      maxReferenceImages: 0,
      timeoutMs: 60000,
    },
    concurrency: 4,
    status: 'available',
    ...over,
  };
}

function request(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'a red apple',
    count: 1,
    size: { width: 1024, height: 1024 },
    aspect: null,
    quality: null,
    output: { format: 'png', delivery: 'base64' },
    ...over,
  };
}

describe('buildPlan — candidate filtering', () => {
  it('throws UnsupportedCapabilityError when nothing is configured', () => {
    expect(() => buildPlan(request(), [])).toThrow(UnsupportedCapabilityError);
  });

  it('skips providers reporting unavailable', () => {
    expect(() => buildPlan(request(), [descriptor({ status: 'unavailable' })])).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('still uses a degraded provider, but ranks it below an available one', () => {
    const degraded = descriptor({ provider: 'degraded-one', status: 'degraded' });
    const healthy = descriptor({ provider: 'healthy-one', status: 'available' });

    const plan = buildPlan(request(), [degraded, healthy]);
    expect(plan.attempts[0].provider).toBe('healthy-one');
    expect(plan.attempts.map((a) => a.provider)).toContain('degraded-one');
  });

  it('rejects a provider that cannot honour a negative prompt', () => {
    const noNegative = descriptor({
      provider: 'p',
      features: { ...descriptor().features, negativePrompt: false },
    });
    expect(() => buildPlan(request({ negativePrompt: 'blurry' }), [noNegative])).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('rejects image-to-image against a text-only provider', () => {
    expect(() =>
      buildPlan(request({ referenceImages: [{ data: 'QUJD', mime: 'image/png' }] }), [
        descriptor(),
      ]),
    ).toThrow(UnsupportedCapabilityError);
  });

  it('rejects a mask against a provider without inpainting', () => {
    const withImg2Img = descriptor({
      features: { ...descriptor().features, imageToImage: true, inpainting: false },
    });
    expect(() =>
      buildPlan(
        request({
          referenceImages: [{ data: 'QUJD', mime: 'image/png' }],
          mask: { data: 'QUJD', mime: 'image/png' },
        }),
        [withImg2Img],
      ),
    ).toThrow(UnsupportedCapabilityError);
  });

  it('rejects an explicitly requested model the provider does not offer', () => {
    expect(() => buildPlan(request({ model: 'nonexistent-model' }), [descriptor()])).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('records a rejection reason for every eliminated provider', () => {
    try {
      buildPlan(request({ model: 'nope' }), [descriptor({ provider: 'p1' })]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedCapabilityError);
      expect((error as UnsupportedCapabilityError).details[0]).toContain('nope');
    }
  });
});

describe('buildPlan — size negotiation', () => {
  it('passes through an exactly supported discrete size unchanged', () => {
    const plan = buildPlan(request({ size: { width: 1024, height: 1024 } }), [
      descriptor({
        models: [
          {
            id: 'dall-e-3',
            aspectRatios: [],
            sizes: DISCRETE_DALLE3,
            qualityLevels: ['standard'],
            outputFormats: ['png'],
          },
        ],
      }),
    ]);

    // No disclosure means no adaptation happened.
    expect(plan.adaptations.sizeAdjustedFrom).toBeUndefined();
  });

  it('snaps an unsupported size to the nearest and DISCLOSES it', () => {
    const plan = buildPlan(request({ size: { width: 1500, height: 1500 } }), [
      descriptor({
        models: [
          {
            id: 'dall-e-3',
            aspectRatios: [],
            sizes: DISCRETE_DALLE3,
            qualityLevels: ['standard'],
            outputFormats: ['png'],
          },
        ],
      }),
    ]);

    // The caller's requested size must be recoverable from the result.
    expect(plan.adaptations.sizeAdjustedFrom).toEqual({ width: 1500, height: 1500 });
    expect(plan.adaptations.notes?.join(' ')).toMatch(/adjusted/i);
  });

  it('prefers matching aspect over matching pixel count', () => {
    // 1600x1000 is a wide (16:10) request; 1792x1024 (7:4) is closer in aspect than
    // 1024x1024 (1:1), even though the square is closer in raw resolution.
    const plan = buildPlan(request({ size: { width: 1600, height: 1000 } }), [
      descriptor({
        models: [
          {
            id: 'dall-e-3',
            aspectRatios: [],
            sizes: DISCRETE_DALLE3,
            qualityLevels: ['standard'],
            outputFormats: ['png'],
          },
        ],
      }),
    ]);

    // We cannot read the chosen size directly from the plan, so assert the adaptation
    // note names the landscape target rather than the square one.
    expect(plan.adaptations.notes?.join(' ')).toContain('1792x1024');
  });

  it('rejects a size outside a range provider bounds', () => {
    expect(() => buildPlan(request({ size: { width: 100, height: 100 } }), [descriptor()])).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('rejects a size that is not a multiple of the required step', () => {
    expect(() =>
      buildPlan(request({ size: { width: 1000, height: 1024 } }), [descriptor()]),
    ).toThrow(UnsupportedCapabilityError);
  });

  it('accepts a size at the exact lower boundary', () => {
    const plan = buildPlan(request({ size: { width: 64, height: 64 } }), [descriptor()]);
    expect(plan.attempts).toHaveLength(1);
  });

  it('resolves an aspect-ratio request onto a discrete size', () => {
    const plan = buildPlan(request({ size: null, aspect: '16:9' }), [
      descriptor({
        models: [
          {
            id: 'dall-e-3',
            aspectRatios: ['16:9'],
            sizes: DISCRETE_DALLE3,
            qualityLevels: ['standard'],
            outputFormats: ['png'],
          },
        ],
      }),
    ]);
    expect(plan.attempts).toHaveLength(1);
  });
});

describe('buildPlan — batching and hints', () => {
  it('discloses fan-out for count>1 against a non-batching provider', () => {
    const plan = buildPlan(request({ count: 4 }), [descriptor()]);
    expect(plan.adaptations.fannedOutFromCount).toBe(4);
  });

  it('does not disclose fan-out when the provider batches natively', () => {
    const batching = descriptor({
      features: { ...descriptor().features, batch: true },
      limits: { ...descriptor().limits, maxBatch: 10 },
    });
    const plan = buildPlan(request({ count: 4 }), [batching]);
    expect(plan.adaptations.fannedOutFromCount).toBeUndefined();
  });

  it('discloses a dropped seed hint rather than silently ignoring it', () => {
    const noSeed = descriptor({
      features: { ...descriptor().features, seed: false },
    });
    const plan = buildPlan(request({ seed: 42 }), [noSeed]);
    expect(plan.adaptations.droppedHints).toContain('seed');
  });

  it('snaps an unsupported quality onto the nearest supported level', () => {
    const withQuality = descriptor({
      features: { ...descriptor().features, quality: true },
      models: [
        {
          id: 'm',
          aspectRatios: [],
          sizes: RANGE_SDXL,
          qualityLevels: ['draft', 'high'],
          outputFormats: ['png'],
        },
      ],
    });
    const plan = buildPlan(request({ quality: 'standard' }), [withQuality]);
    expect(plan.attempts).toHaveLength(1);
  });

  it('drops quality entirely when the provider has no quality concept', () => {
    const plan = buildPlan(request({ quality: 'high' }), [descriptor()]);
    expect(plan.adaptations.droppedHints).toContain('quality');
  });
});

describe('buildPlan — ranking and failover', () => {
  it('ranks a cheaper model first', () => {
    const cheap = descriptor({
      provider: 'cheap',
      models: [
        {
          id: 'cheap-model',
          aspectRatios: [],
          sizes: RANGE_SDXL,
          qualityLevels: ['standard'],
          outputFormats: ['png'],
          costPerImageUsd: 0.002,
        },
      ],
    });
    const pricey = descriptor({
      provider: 'pricey',
      models: [
        {
          id: 'pricey-model',
          aspectRatios: [],
          sizes: RANGE_SDXL,
          qualityLevels: ['standard'],
          outputFormats: ['png'],
          costPerImageUsd: 0.08,
        },
      ],
    });

    const plan = buildPlan(request(), [pricey, cheap]);
    expect(plan.attempts[0].provider).toBe('cheap');
  });

  it('breaks a cost tie on observed latency', () => {
    const fast = descriptor({ provider: 'fast', p50LatencyMs: 900 });
    const slow = descriptor({ provider: 'slow', p50LatencyMs: 9000 });
    expect(buildPlan(request(), [slow, fast]).attempts[0].provider).toBe('fast');
  });

  it('produces an ordered failover list, not a single provider', () => {
    const plan = buildPlan(request(), [
      descriptor({ provider: 'a', p50LatencyMs: 100 }),
      descriptor({ provider: 'b', p50LatencyMs: 200 }),
      descriptor({ provider: 'c', p50LatencyMs: 300 }),
    ]);

    expect(plan.attempts.map((a) => a.provider)).toEqual(['a', 'b', 'c']);
  });

  it('caps the plan at three attempts', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((p, i) =>
      descriptor({ provider: p, p50LatencyMs: 100 + i }),
    );
    expect(buildPlan(request(), many).attempts).toHaveLength(3);
  });

  it('carries each provider timeout into its attempt', () => {
    const slowTimeout = descriptor({
      limits: { ...descriptor().limits, timeoutMs: 123456 },
    });
    expect(buildPlan(request(), [slowTimeout]).attempts[0].timeoutMs).toBe(123456);
  });

  it('is pure — same inputs yield the same plan', () => {
    const descriptors = [descriptor({ provider: 'a' }), descriptor({ provider: 'b' })];
    const a = buildPlan(request(), descriptors);
    const b = buildPlan(request(), descriptors);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
