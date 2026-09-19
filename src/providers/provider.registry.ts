import type { ImageProvider } from './provider.interface';
import type { CapabilityDescriptor } from '../types/capability.types';
import type { AppConfig } from '../config';
import { ChatProvider } from './chat.provider';
import { logger } from '../utils/logger';

/**
 * Provider registry.
 *
 * Owns instantiation from config and lookup by name. Kept deliberately dumb — no
 * routing decisions live here; those belong to the capability matcher.
 *
 * There is exactly one provider class now: a chat-completions model that is instructed
 * to answer with an image. Native image providers (Stability, Replicate, an images
 * endpoint) were removed when the engine was retargeted at text-only models. The
 * registry stays generic so a second class can be added without touching routing.
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
   * then fail upstream — a keyless endpoint must never be advertised as "available".
   */
  capabilityDescriptors(): CapabilityDescriptor[] {
    return this.available().map((p) => p.getCapabilities());
  }

  /** Build the registry from application config. */
  static fromConfig(config: AppConfig): ProviderRegistry {
    const providers: ImageProvider[] = [];

    // Register the provider even without a key: it reports itself unavailable, which
    // gives /api/v1/backends an honest row and makes the startup log name what is
    // missing, rather than showing an empty list with no explanation.
    providers.push(
      new ChatProvider({
        apiKey: config.backends.chat.apiKey,
        baseUrl: config.backends.chat.baseUrl,
        defaultModel: config.backends.chat.defaultModel,
        visionModel: config.backends.chat.visionModel,
        extraModels: config.backends.chat.extraModels,
        systemPrompt: config.backends.chat.systemPrompt,
      }),
    );

    const registry = new ProviderRegistry(providers);

    logger.info(`Initialized ${registry.available().length} provider(s)`, {
      providers: registry.available().map((p) => p.name),
      ...(registry.available().length === 0
        ? { hint: 'set CHAT_API_KEY to enable the chat-completions backend' }
        : {}),
    });

    return registry;
  }
}
