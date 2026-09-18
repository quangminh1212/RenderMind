/**
 * Canonical generation model — the protocol-agnostic core of the engine.
 *
 * Every inbound adapter (openclaw-images, Anthropic, native) translates its wire
 * format into these types, and every outbound provider translates them into its own
 * API. Nothing in this file may reference a protocol or a vendor.
 *
 * Design rule: the canonical request carries **intent** (what the caller wants), not
 * provider mechanics. Fields like `steps` and `guidanceScale` are *hints* — a provider
 * that cannot honour them must declare so via its CapabilityDescriptor, and the engine
 * records the outcome in `AppliedAdaptations` rather than silently dropping it.
 *
 * This inversion is what fixes the class of bug where DALL·E 3's discrete sizes forced
 * a silent `getValidSize()` rewrite of the caller's request.
 */

/** Output encodings understood by the engine. */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** How the caller wants the finished image delivered. */
export type DeliveryMode = 'base64' | 'url';

/**
 * A requested aspect ratio. `null` means "derive from size, or let the provider decide".
 */
export type AspectRatio = '1:1' | '16:9' | '9:16' | '3:2' | '2:3' | '4:3' | '3:4';

/**
 * Coarse quality intent. Maps onto each provider's own vocabulary
 * (e.g. DALL·E 3's `standard`/`hd`, Stability's step count).
 */
export type QualityLevel = 'draft' | 'standard' | 'high';

export interface ReferenceImage {
  /** Raw base64 payload, no data-URI prefix. */
  data: string;
  mime: string;
}

export interface OutputSpec {
  format: ImageFormat;
  delivery: DeliveryMode;
}

/**
 * The canonical generation request.
 *
 * `id` and `idempotencyKey` are assigned by the engine, not the adapter, so that a
 * request is traceable across retries and failovers.
 */
export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;

  /** Number of images requested. Replaces the protocol-specific `n`. */
  count: number;

  /** Explicit pixel size, or null to let `aspect` / the provider decide. */
  size: { width: number; height: number } | null;

  /** Requested aspect ratio, or null when an explicit size is given. */
  aspect: AspectRatio | null;

  quality: QualityLevel | null;

  /** Provider-specific hint — providers declare support via capabilities. */
  steps?: number;
  /** Provider-specific hint — providers declare support via capabilities. */
  guidanceScale?: number;
  seed?: number;

  /** Preferred model, or undefined to let capability matching choose. */
  model?: string;
  /** Preferred provider name, or 'auto' to let capability matching choose. */
  provider?: string;

  /** Input images for image-to-image / edits. */
  referenceImages?: ReferenceImage[];
  /** Mask for inpainting. Requires `referenceImages`. */
  mask?: ReferenceImage;

  style?: string;

  output: OutputSpec;
  callbackUrl?: string;

  metadata?: {
    userId?: string;
    traceId?: string;
    [key: string]: unknown;
  };
}

/** One produced image, as returned by a provider. */
export interface GeneratedImage {
  /** Base64 payload without a data-URI prefix, when the provider returned one. */
  base64?: string;
  /** URL, when the provider returned one. */
  url?: string;
  mime: string;
  width?: number;
  height?: number;
  /**
   * The prompt the provider actually used, when it differs from the request
   * (e.g. DALL·E 3 rewrites prompts). Surfacing this is how we avoid the
   * silent-substitution class of bug.
   */
  revisedPrompt?: string;
}

/**
 * A record of every place the engine altered the caller's request to make it
 * satisfiable. Empty means the request was honoured verbatim.
 *
 * This exists so adaptation is *disclosed* rather than silent: the audit found the
 * previous implementation rewrote DALL·E 3 sizes with no way for the caller to know.
 */
export interface AppliedAdaptations {
  /** Set when the requested size was replaced with the nearest supported one. */
  sizeAdjustedFrom?: { width: number; height: number };
  /** Hint fields the chosen provider cannot honour, and so were not sent. */
  droppedHints?: string[];
  /** Set when `count` was satisfied by several calls instead of a native batch. */
  fannedOutFromCount?: number;
  /** Human-readable notes for anything else worth disclosing. */
  notes?: string[];
}

export interface GenerationTimings {
  queueMs: number;
  providerMs: number;
  totalMs: number;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  provider: string;
  model: string;
  seedUsed?: number;
  timings: GenerationTimings;
  cached: boolean;
  adaptations: AppliedAdaptations;
}
