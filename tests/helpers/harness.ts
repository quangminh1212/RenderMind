import { vi } from 'vitest';
import express from 'express';
import { setEngine, type Engine } from '../../src/engine';
import { GenerationService } from '../../src/engine/generation.service';
import { ProviderRegistry } from '../../src/providers/provider.registry';
import type { ImageProvider } from '../../src/providers/provider.interface';
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../../src/types/canonical.types';
import type { CapabilityDescriptor } from '../../src/types/capability.types';
import { loadConfig, setConfig } from '../../src/config';

/**
 * Shared test harness.
 *
 * The engine is a module-level singleton whose real construction depends on environment
 * variables. Tests replace it with a deterministic fake so that route behaviour — which
 * is what these suites are about — is exercised without touching a network or a paid API.
 */

/** Environment used unless a test overrides a specific field. */
export function testEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379',
    ...over,
  } as NodeJS.ProcessEnv;
}

/** Install a validated config built from `env`. */
export function useTestConfig(env: Record<string, string | undefined> = {}) {
  const config = loadConfig(testEnv(env));
  setConfig(config);
  return config;
}

/** A capability descriptor for a fully-featured fake provider. */
export function fakeDescriptor(over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    provider: 'fake',
    displayName: 'Fake Provider',
    models: [
      {
        id: 'fake-model',
        aspectRatios: [],
        sizes: { kind: 'range', min: 64, max: 4096, multiple: 8 },
        qualityLevels: ['draft', 'standard', 'high'],
        outputFormats: ['png'],
        costPerImageUsd: 0.001,
      },
    ],
    features: {
      negativePrompt: true,
      seed: true,
      steps: true,
      guidanceScale: true,
      quality: true,
      style: true,
      batch: false,
      imageToImage: true,
      inpainting: true,
      revisedPrompt: true,
      nativeBase64: true,
      nativeUrl: true,
    },
    limits: {
      maxBatch: 10,
      maxPromptChars: 4000,
      maxReferenceImages: 4,
      timeoutMs: 30000,
    },
    concurrency: 8,
    p50LatencyMs: 100,
    status: 'available',
    ...over,
  };
}

/** A provider that returns a deterministic image without any I/O. */
export class FakeProvider implements ImageProvider {
  readonly name: string;
  readonly displayName = 'Fake Provider';
  readonly calls: ImageGenerationRequest[] = [];

  constructor(
    name = 'fake',
    private readonly behaviour: {
      descriptor?: Partial<CapabilityDescriptor>;
      result?: Partial<ImageGenerationResult>;
      error?: Error;
      delayMs?: number;
      /** Throw only on the Nth call (1-indexed). */
      failOnCall?: number;
    } = {},
  ) {
    this.name = name;
  }

  isAvailable(): boolean {
    return true;
  }

  getCapabilities(): CapabilityDescriptor {
    return fakeDescriptor({ provider: this.name, ...this.behaviour.descriptor });
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    this.calls.push(request);

    if (this.behaviour.delayMs) {
      await new Promise((r) => setTimeout(r, this.behaviour.delayMs));
    }

    if (
      this.behaviour.failOnCall !== undefined &&
      this.calls.length === this.behaviour.failOnCall
    ) {
      throw this.behaviour.error ?? new Error('fake failure');
    }
    if (this.behaviour.error && this.behaviour.failOnCall === undefined) {
      throw this.behaviour.error;
    }

    const count = request.count;
    return {
      images: Array.from({ length: count }, (_, i) => ({
        base64: Buffer.from(`image-${i}-${request.prompt}`).toString('base64'),
        mime: 'image/png',
      })),
      provider: this.name,
      model: request.model ?? 'fake-model',
      timings: { queueMs: 0, providerMs: 1, totalMs: 2 },
      cached: false,
      adaptations: {},
      ...this.behaviour.result,
    };
  }
}

/** Install an engine backed by the supplied providers. */
export function useFakeEngine(providers: ImageProvider[]): Engine {
  const registry = new ProviderRegistry(providers);
  const engine: Engine = {
    registry,
    generation: new GenerationService(registry, { maxConcurrency: 4 }),
  };
  setEngine(engine);
  return engine;
}

/** Build a bare Express app with JSON parsing and the supplied router mounted. */
export function mountRouter(path: string, router: express.Router): express.Application {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

/** Silence expected error logs so a passing suite does not look alarming. */
export function silenceLogs(): void {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}
