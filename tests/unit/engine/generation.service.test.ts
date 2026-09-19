import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GenerationService, Semaphore } from '../../../src/engine/generation.service';
import { ProviderRegistry } from '../../../src/providers/provider.registry';
import { ProviderError } from '../../../src/engine/errors';
import { FakeProvider } from '../../helpers/harness';
import { circuitBreaker } from '../../../src/platform/http.client';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Generation-service tests.
 *
 * These pin the orchestration contract that the whole engine exists to provide:
 *   - `count` fans out into distinct calls, not one call repeated.
 *   - a terminal failure fails over to the next provider rather than the whole request.
 *   - a retryable failure is retried, then fails over.
 *   - a partial failure is reported, never a short-but-successful result.
 *   - "nothing configured" and "everything tripped" are distinct, honest errors.
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

function serviceFor(providers: FakeProvider[], maxConcurrency = 4): GenerationService {
  const registry = new ProviderRegistry(providers);
  return new GenerationService(registry, { maxConcurrency });
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Breakers are module-global; reset each test so state cannot leak between them.
  circuitBreaker.reset();
});

describe('GenerationService.generate', () => {
  it('returns one image for a count of one', async () => {
    const provider = new FakeProvider();
    const { result } = await serviceFor([provider]).generate(req());

    expect(result.images).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('fans a count of N out into N distinct calls', async () => {
    const provider = new FakeProvider();
    const { result, plan } = await serviceFor([provider]).generate(req({ count: 3 }));

    expect(result.images).toHaveLength(3);
    expect(provider.calls).toHaveLength(3);
    // Each sub-job is issued as a single-image request.
    expect(provider.calls.every((c) => c.count === 1)).toBe(true);
    // The fan-out is disclosed, not hidden.
    expect(plan.adaptations.fannedOutFromCount).toBe(3);
  });

  it('throws when no provider is configured', async () => {
    await expect(serviceFor([]).generate(req())).rejects.toMatchObject({
      name: 'NoProviderAvailableError',
    });
  });

  it('reports an unsupported request as a capability error', async () => {
    // A provider that only offers a model that cannot do image-to-image.
    const provider = new FakeProvider('fake', {
      descriptor: {
        features: { ...new FakeProvider().getCapabilities().features, imageToImage: false },
      },
    });

    await expect(
      serviceFor([provider]).generate(
        req({ referenceImages: [{ data: 'AA', mime: 'image/png' }] }),
      ),
    ).rejects.toMatchObject({ name: 'UnsupportedCapabilityError' });
  });

  it('fails over to the next provider on a terminal error', async () => {
    const failing = new FakeProvider('fake-a', {
      error: new ProviderError({ provider: 'fake-a', message: 'bad', status: 400 }),
    });
    const good = new FakeProvider('fake-b');

    const { result } = await serviceFor([failing, good]).generate(req());

    expect(result.provider).toBe('fake-b');
    expect(failing.calls).toHaveLength(1);
  });

  it('retries a retryable failure before failing over', async () => {
    const flaky = new FakeProvider('fake-a', {
      error: new ProviderError({ provider: 'fake-a', message: 'boom', status: 503 }),
      failOnCall: 1,
    });
    const good = new FakeProvider('fake-b');

    const { result } = await serviceFor([flaky, good]).generate(req());

    // First attempt failed on 503, retried, succeeded on the same provider.
    expect(flaky.calls).toHaveLength(2);
    expect(result.provider).toBe('fake-a');
  });

  it('reports the last error when every provider fails', async () => {
    const a = new FakeProvider('fake-a', {
      error: new ProviderError({ provider: 'fake-a', message: 'bad request', status: 400 }),
    });

    await expect(serviceFor([a]).generate(req())).rejects.toMatchObject({ status: 400 });
  });

  it('reports a partial fan-out failure rather than a short success', async () => {
    // One of two sub-jobs fails terminally; the request as a whole must fail.
    const provider = new FakeProvider('fake', {
      error: new ProviderError({ provider: 'fake', message: 'bad', status: 400 }),
      failOnCall: 2,
    });

    await expect(serviceFor([provider]).generate(req({ count: 2 }))).rejects.toBeTruthy();
  });

  it('adds a note when varying seeds for a batch', async () => {
    const { result } = await serviceFor([new FakeProvider()]).generate(req({ count: 2 }));
    expect(result.adaptations.notes?.some((n) => /distinct seed/i.test(n))).toBe(true);
  });

  it('does not add the seed note when an explicit seed is pinned', async () => {
    const { result } = await serviceFor([new FakeProvider()]).generate(req({ count: 2, seed: 5 }));
    expect(result.adaptations.notes ?? []).not.toContain(
      'each image used a distinct seed to guarantee variation',
    );
  });
});

describe('Semaphore', () => {
  it('grants permits up to its limit', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.stats.available).toBe(0);
    expect(sem.stats.queued).toBe(0);
    r1();
    r2();
    expect(sem.stats.available).toBe(2);
  });

  it('queues a waiter once permits are exhausted, then hands the permit over', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    const pending = sem.acquire();
    await Promise.resolve();
    expect(sem.stats.queued).toBe(1);

    first();
    const release = await pending;
    expect(sem.stats.queued).toBe(0);
    release();
    expect(sem.stats.available).toBe(1);
  });

  it('treats a non-positive limit as one permit', () => {
    expect(new Semaphore(0).stats.available).toBe(1);
  });
});
