import { ProviderRegistry } from '../providers/provider.registry';
import { GenerationService } from './generation.service';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

/**
 * Engine composition root.
 *
 * Keeps construction in one place so adapters depend on a service, not on config
 * plumbing. Initialised once at startup; tests may override with `setEngine`.
 */
export interface Engine {
  registry: ProviderRegistry;
  generation: GenerationService;
}

let engine: Engine | null = null;

/** Build the engine from validated config. Idempotent. */
export function initEngine(): Engine {
  if (engine) return engine;

  const config = getConfig();
  const registry = ProviderRegistry.fromConfig(config);

  engine = {
    registry,
    generation: new GenerationService(registry, {
      maxConcurrency: config.engine.maxConcurrency,
    }),
  };

  logger.info('Engine initialised', {
    providers: registry.available().map((p) => p.name),
    maxConcurrency: config.engine.maxConcurrency,
  });

  return engine;
}

/**
 * Access the engine, initialising on first use.
 *
 * Lazy init keeps test setup simple: a test that substitutes its own engine never
 * triggers provider construction from the real environment.
 */
export function getEngine(): Engine {
  if (!engine) return initEngine();
  return engine;
}

/** Replace the engine. Used by tests and by integration harnesses. */
export function setEngine(next: Engine | null): void {
  engine = next;
}
