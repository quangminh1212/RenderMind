/**
 * Capability descriptors — how a provider declares what it can honour.
 *
 * The engine's capability matcher reads these to decide, *before* dispatching, whether
 * a request can be served, whether it must be adapted, and which provider should win.
 * Providers never see a request they cannot satisfy, and the caller is always told
 * when adaptation happened (see AppliedAdaptations).
 */
import type { AspectRatio, ImageFormat, QualityLevel } from './canonical.types';

/** How a provider accepts sizes. */
export type SizeSpec =
  | { kind: 'discrete'; sizes: Array<{ width: number; height: number }> }
  | { kind: 'range'; min: number; max: number; multiple: number };

export interface ProviderFeatures {
  negativePrompt: boolean;
  seed: boolean;
  steps: boolean;
  guidanceScale: boolean;
  quality: boolean;
  style: boolean;
  /** Native n>1 in a single upstream call. */
  batch: boolean;
  imageToImage: boolean;
  inpainting: boolean;
  /** Provider returns its own rewritten prompt. */
  revisedPrompt: boolean;
  nativeBase64: boolean;
  /** Provider can emit a URL for the finished image. */
  nativeUrl: boolean;
}

export interface ProviderLimits {
  maxBatch: number;
  maxPromptChars: number;
  maxNegativePromptChars?: number;
  maxReferenceImages: number;
  /** Wall-clock ceiling for a single upstream call. */
  timeoutMs: number;
}

export interface ModelDescriptor {
  id: string;
  /** Aspect ratios this model supports; empty means "any". */
  aspectRatios: AspectRatio[];
  sizes: SizeSpec;
  qualityLevels: QualityLevel[];
  outputFormats: ImageFormat[];
  /** Relative cost signal used for ranking. Lower is cheaper. */
  costPerImageUsd?: number;
}

export interface CapabilityDescriptor {
  provider: string;
  displayName: string;
  models: ModelDescriptor[];
  features: ProviderFeatures;
  limits: ProviderLimits;
  /** In-flight calls this provider tolerates before queueing. */
  concurrency: number;
  /** Observed p50 latency, used for ranking. */
  p50LatencyMs?: number;
  status: ProviderStatus;
}

export type ProviderStatus = 'available' | 'degraded' | 'unavailable';

/** Why a candidate provider was rejected during matching. */
export interface RejectionReason {
  provider: string;
  model?: string;
  reason: string;
}

/** One dispatch attempt in a generation plan. */
export interface Attempt {
  provider: string;
  model: string;
  /** The request as adapted for this specific provider. */
  timeoutMs: number;
}

/**
 * The resolved execution plan. Making this explicit — rather than picking a provider
 * and looping retries against it — is what makes failover testable.
 */
export interface GenerationPlan {
  attempts: Attempt[];
  adaptations: import('./canonical.types').AppliedAdaptations;
  rejections: RejectionReason[];
}
