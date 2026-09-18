import type { ImageProvider } from './provider.interface';
import type { CapabilityDescriptor } from '../types/capability.types';
import type { AppConfig } from '../config';
import { OpenclawProvider } from './openclaw.provider';
import { StabilityProvider } from './stability.provider';
import { ReplicateProvider } from './replicate.provider';
import { CustomProvider } from './custom.provider';
import { logger } from '../utils/logger';

/**
 * Provider registry.
 *
 * Owns instantiation from config and lookup by name. Kept deliberately dumb — no
 * routing decisions live here; those belong to the capability matcher.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ImageProvider>();

  constructor(providers: ImageProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ImageProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ImageProvider | undefined {
    return this.providers.get(name);
  }

  all(): ImageProvider[] {
    return [...this.providers.values()];
  }

  /** Only providers that are actually configured and callable. */
  available(): ImageProvider[] {
    return this.all().filter((p) => p.isAvailable());
  }

  names(): string[] {
    return this.all().map((p) => p.name);
  }

  /**
   * Capability descriptors for every available provider.
   *
   * Unavailable providers are excluded outright so the matcher cannot select one and
   * then fail upstream — the audit found the old code advertising a keyless endpoint
   * as "available" and then 401ing on every request.
   */
  capabilityDescriptors(): CapabilityDescriptor[] {
    return this.available().map((p) => p.getCapabilities());
  }

  /** Build the registry from application config. */
  static fromConfig(config: AppConfig): ProviderRegistry {
    const providers: ImageProvider[] = [];

    if (config.backends.openclaw.apiKey) {
      providers.push(
        new OpenclawProvider({
          apiKey: config.backends.openclaw.apiKey,
          baseUrl: config.backends.openclaw.baseUrl,
          defaultModel: config.backends.openclaw.defaultModel,
          extraModels: config.backends.openclaw.extraModels,
        }),
      );
    }

    if (config.backends.stability.apiKey) {
      providers.push(
        new StabilityProvider({
          apiKey: config.backends.stability.apiKey,
          apiHost: config.backends.stability.apiHost,
        }),
      );
    }

    if (config.backends.replicate.apiToken) {
      providers.push(new ReplicateProvider({ apiToken: config.backends.replicate.apiToken }));
    }

    // Custom HTTP backends were previously implemented but never instantiated.
    for (const custom of config.backends.custom) {
      providers.push(
        new CustomProvider({
          name: custom.name,
          url: custom.url,
          apiKey: custom.api_key,
          headers: custom.headers,
          models: custom.models,
          bodyTemplate: custom.body_template,
        }),
      );
    }

    const registry = new ProviderRegistry(providers);

    logger.info(`Initialized ${providers.length} image provider(s)`, {
      providers: registry.available().map((p) => p.name),
    });

    return registry;
  }
}
