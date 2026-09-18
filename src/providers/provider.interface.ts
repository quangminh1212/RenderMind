import type { ImageGenerationRequest, ImageGenerationResult } from '../types/canonical.types';
import type { CapabilityDescriptor } from '../types/capability.types';

/**
 * The contract every outbound image provider implements.
 *
 * Providers are deliberately ignorant of protocols and adapters: they receive a
 * canonical request and return a canonical result. This is what makes
 * "openclaw-images-compatible in, ComfyUI out" possible without cross-contamination.
 */
export interface ImageProvider {
  /** Stable identifier used in the client-facing `backend` field and logs. */
  readonly name: string;
  readonly displayName: string;

  /** What this provider can do. Consulted before dispatch, never guessed. */
  getCapabilities(): CapabilityDescriptor;

  /** Whether the provider has enough configuration to be called at all. */
  isAvailable(): boolean;

  /**
   * Generate images for a request the matcher has already deemed satisfiable.
   *
   * Must throw a `ProviderError` (not a bare Error) on failure so the engine can
   * classify retryable vs terminal and map to the right client-facing status.
   */
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
