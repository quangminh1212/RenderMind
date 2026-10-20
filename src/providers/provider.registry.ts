import type { ImageProvider } from './provider.interface';
import type { CapabilityDescriptor } from '../types/capability.types';
import type { AppConfig } from '../config';
import { ChatProvider } from './chat.provider';
import { NativeImageProvider } from './image.provider';
import { buildPromptPlanner } from './prompt.planner';
import { logger } from '../utils/logger';

/**
 * Provider registry.
 *
 * Owns instantiation from config and lookup by name. Kept deliberately dumb — no
 * routing decisions live here; those belong to the capability matcher.
 *
 * Two provider classes exist, and they are not interchangeable:
 *
 *   `chat`   — a chat-completions model *instructed* to answer with SVG, rasterized to a
 *              bitmap. Works against any text endpoint; produces diagrams, and is the only
 *              source of `format: 'svg'` and of reference-image handling.
 *   `native` — a real `POST {base}/images/generations` endpoint returning pixels. Better
 *              images, and unavailable unless the operator configures a key *and* a model.
 *
 * Which of them wins a request is `PROVIDER_STRATEGY`, applied here as a status filter so
 * the matcher's contract is unchanged: it sees only the providers this deployment is willing
 * to route to, and its own gates (output format, reference images) still decide the rest.
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
   * Capability descriptors for every provider that is available *and* permitted by the
   * configured routing strategy.
   *
   * Unavailable providers are excluded outright so the matcher cannot select one and then
   * fail upstream — a keyless endpoint must never be advertised as "available".
   *
   * A provider the strategy forbids is excluded the same way. That is deliberately the same
   * mechanism as unavailability rather than a change to the matcher's ranking: it keeps
   * "which providers may serve this" in one place, and it means `PROVIDER_STRATEGY=chat`
   * produces exactly the descriptor set — and therefore exactly the behaviour — of a
   * deployment that has no native provider at all.
   */
  capabilityDescriptors(strategy: ProviderStrategy = 'auto'): CapabilityDescriptor[] {
    return this.available()
      .filter((provider) => allowsProvider(strategy, provider.name))
      .map((p) => p.getCapabilities());
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
        maxTokens: config.backends.chat.maxTokens,
        visionModel: config.backends.chat.visionModel,
        visionModelConfigured: config.backends.chat.visionModelConfigured,
        visionRefinementRounds: config.backends.chat.visionRefinementRounds,
        extraModels: config.backends.chat.extraModels,
        systemPrompt: config.backends.chat.systemPrompt,
        renderMode: config.backends.chat.renderMode,
      }),
    );

    // The native provider is registered **only when it is configured**.
    //
    // Unlike chat there is no safe default to fall back to: a base URL whose model id we
    // guessed would 404 on every request. Registering a half-configured endpoint would put
    // an always-failing provider in the plan and, worse, make it the preferred one. So an
    // unconfigured native backend does not exist as a provider at all, which is what keeps
    // zero-config behaviour byte-identical to the chat-only build.
    const image = config.backends.image;
    const nativeConfigured = image.apiKey.length > 0 && image.model.length > 0;

    if (nativeConfigured) {
      // The prompt planner is constructed only when configured. `buildPromptPlanner` returns
      // `undefined` for the default (no planner), which makes the native provider skip the
      // branch entirely — that is what keeps the disabled path byte-identical rather than
      // merely equivalent.
      const planner = image.promptPlanner.enabled
        ? buildPromptPlanner({
            baseUrl: image.promptPlanner.baseUrl,
            model: image.promptPlanner.model,
            apiKey: image.promptPlanner.apiKey,
            maxTokens: image.promptPlanner.maxTokens,
          })
        : undefined;

      providers.push(
        new NativeImageProvider({
          apiKey: image.apiKey,
          baseUrl: image.baseUrl,
          model: image.model,
          extraModels: image.extraModels,
          supportsBatch: image.supportsBatch,
          planner,
        }),
      );
    }

    const registry = new ProviderRegistry(providers);
    const routable = registry.capabilityDescriptors(config.providerStrategy);

    logger.info(`Initialized ${routable.length} routeable provider(s)`, {
      providers: routable.map((p) => p.provider),
      strategy: config.providerStrategy,
      // Named explicitly when the extra rounds are on, because that setting multiplies the
      // upstream calls one client request can cost and must be visible in the boot log.
      ...(config.backends.chat.visionRefinementRounds > 0
        ? { chatVisionRefinementRounds: config.backends.chat.visionRefinementRounds }
        : {}),
      ...(nativeConfigured ? {} : { native: 'not configured (set IMAGE_API_KEY and IMAGE_MODEL)' }),
      ...(routable.length === 0
        ? { hint: 'set CHAT_API_KEY, or IMAGE_API_KEY plus IMAGE_MODEL, to enable a backend' }
        : {}),
    });

    return registry;
  }
}

/** Which provider class the configured strategy is willing to route to. */
export function allowsProvider(strategy: ProviderStrategy, providerName: string): boolean {
  if (strategy === 'auto') return true;
  if (strategy === 'chat') return providerName === 'chat';
  return providerName === 'native';
}

/** Re-exported so call sites can type the strategy without reaching into config. */
export type ProviderStrategy = AppConfig['providerStrategy'];
