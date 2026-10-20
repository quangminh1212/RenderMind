import type {
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../types/canonical.types';
import type { CapabilityDescriptor, ModelDescriptor } from '../types/capability.types';
import type { ImageProvider } from './provider.interface';
import { ProviderError } from '../engine/errors';
import { buildNativePrompt } from './prompt.builder';
import type { PromptPlanner } from './prompt.planner';
import { logger } from '../utils/logger';

/**
 * Provider for a **native** image-generation endpoint that returns real pixels.
 *
 * This is the honest counterpart to the chat-completions fallback. That provider asks a
 * language model to *author* SVG because a text model cannot emit pixels it has not seen;
 * this one calls an endpoint that was built to produce images, and receives an actual
 * raster in return.
 *
 * The wire shape is `POST {baseUrl}/images/generations` — the openclaw images API as
 * proxied by LiteLLM, which normalizes DALL·E, gpt-image-1, Vertex/Imagen, Bedrock,
 * Stability, Together, Fireworks and Black Forest Labs behind one route. Two response
 * shapes matter and both are accepted:
 *
 *   `{ data: [{ b64_json }] }` — pixels inline. Preferred.
 *   `{ data: [{ url }] }`      — a link the artifact store fetches and inlines when the
 *                                caller asked for base64.
 *
 * Three things are deliberately *not* claimed:
 *
 *   1. **No SVG.** This endpoint has no vector mode, so `outputFormats` excludes it. The
 *      capability matcher gates on that, which is what keeps `format: 'svg'` routed to the
 *      chat path without any special case in the router.
 *   2. **No image-to-image.** The images API has no image-input parameter in this schema.
 *      Declaring `imageToImage: false` makes the matcher reject a `/vision` request rather
 *      than sending reference images into a field the endpoint will ignore — which would
 *      produce a plausible-looking success that silently discarded the caller's input.
 *   3. **No seed, steps or guidance scale.** There is no field for them, so the matcher
 *      records them as dropped hints instead of this provider pretending to honour them.
 */

/** Mime type assigned to a base64 payload whose format the request did not pin. */
const DEFAULT_MIME = 'image/png';

const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Sizes offered when the operator has not narrowed them.
 *
 * Square, landscape and portrait at the two resolutions essentially every images API
 * accepts. The concrete set matters less than its *shape*: declaring discrete sizes (rather
 * than the chat provider's open range) is what makes `resolveSize` nearest-match an
 * unsupported size and disclose the substitution in `AppliedAdaptations`.
 */
const DEFAULT_SIZES: Array<{ width: number; height: number }> = [
  { width: 512, height: 512 },
  { width: 768, height: 768 },
  { width: 1024, height: 1024 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 1024, height: 1536 },
  { width: 1536, height: 1024 },
];

/**
 * Widest aspect ratio difference tolerated when matching a requested aspect to a size.
 *
 * Two percent, matching `normalizeAspect` at the boundary, so a request that was accepted
 * as "16:9" is not then refused by the provider that receives it.
 */
const ASPECT_TOLERANCE = 0.02;

/** Numeric value of each canonical aspect ratio. */
const ASPECT_VALUES: Record<string, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
};

export interface NativeImageProviderConfig {
  apiKey: string;
  baseUrl: string;
  /** Model id sent upstream. An empty value makes the provider unavailable. */
  model: string;
  /** Additional model ids this endpoint accepts. */
  extraModels?: string[];
  /**
   * Sizes this deployment's endpoint accepts. Omitted means {@link DEFAULT_SIZES}.
   *
   * Not an env var: a wrong size set is a vendor fact, and getting it from the operator's
   * own deployment is the only way to avoid advertising a size that 400s upstream.
   */
  sizes?: Array<{ width: number; height: number }>;
  /** In-flight calls this provider tolerates before queueing. */
  concurrency?: number;
  /** Whether the upstream accepts `n > 1`; false makes the engine fan out one call per image. */
  supportsBatch?: boolean;
  /**
   * Optional LLM prompt expansion, applied to a single-image request before dispatch.
   *
   * `undefined` — the default — disables it entirely: no extra upstream call is made and the
   * bytes sent are exactly what a build without this feature sent. Supplied only when the
   * operator configured `IMAGE_PROMPT_PLANNER_*`; see {@link PromptPlanner}.
   *
   * Not used for a fan-out (`count > 1`), where the engine has already prefixed the prompt
   * with its own per-variant direction. Two rewriters on one prompt would fight, and an
   * image model handed a planner's prose wrapped around "Variant 2 of 3…" tends to draw the
   * words.
   */
  planner?: PromptPlanner;
}

export class NativeImageProvider implements ImageProvider {
  readonly name = 'native';
  readonly displayName = 'Native images endpoint';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly extraModels: string[];
  private readonly sizes: Array<{ width: number; height: number }>;
  private readonly concurrency: number;
  private readonly supportsBatch: boolean;
  private readonly planner?: PromptPlanner;

  constructor(config: NativeImageProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
    this.extraModels = config.extraModels ?? [];
    this.sizes = config.sizes ?? DEFAULT_SIZES;
    this.concurrency = config.concurrency ?? 8;
    this.supportsBatch = config.supportsBatch ?? true;
    this.planner = config.planner;
  }

  isAvailable(): boolean {
    // Both halves are required. A key with no model id would send `model: undefined` and
    // collect a 400 on every request; a model with no key would 401. Either way the
    // provider must report unavailable *before* the matcher can select it, so a
    // half-configured endpoint is never advertised as callable.
    return this.apiKey.length > 0 && this.model.length > 0;
  }

  getCapabilities(): CapabilityDescriptor {
    const modelIds = new Set<string>([this.model, ...this.extraModels].filter(Boolean));

    const models: ModelDescriptor[] = [...modelIds].map((id) => ({
      id,
      aspectRatios: [],
      sizes: { kind: 'discrete' as const, sizes: this.sizes },
      // The images API accepts a `quality` field on some vendors and not others, and the
      // ones that accept it do not report their vocabulary. Declaring the levels we are
      // willing to forward lets the matcher nearest-match and disclose.
      qualityLevels: ['draft', 'standard', 'high'],
      outputFormats: ['png', 'jpeg', 'webp'] as const,
      // No cost figure is declared. `buildPlan` ranks by cost first, and inventing a number
      // here would let this provider win by accident of a constant; the strategy switch is
      // what decides the preference, explicitly.
    }));

    return {
      provider: this.name,
      displayName: this.displayName,
      models,
      features: {
        negativePrompt: false,
        seed: false,
        steps: false,
        guidanceScale: false,
        quality: true,
        style: false,
        batch: this.supportsBatch,
        // The images API in this schema has no image input. Declared honestly so the
        // matcher rejects a reference-image request instead of dropping the references.
        imageToImage: false,
        inpainting: false,
        // Some vendors rewrite the prompt; the response echoing one is surfaced when present.
        revisedPrompt: true,
        nativeBase64: true,
        nativeUrl: true,
      },
      limits: {
        maxBatch: this.supportsBatch ? 10 : 1,
        maxPromptChars: 32000,
        maxReferenceImages: 0,
        timeoutMs: 120000,
      },
      concurrency: this.concurrency,
      p50LatencyMs: 8000,
      status: this.isAvailable() ? 'available' : 'unavailable',
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const started = Date.now();
    const model = request.model ?? this.model;

    // ── Delivery materialization ────────────────────────────
    // Always ask for base64.
    //
    // The caller's `response_format` is a RenderMind contract, not an upstream one, and the
    // engine's artifact store already inlines a URL when base64 is required. Asking upstream
    // for `url` instead would push the choice onto the vendor — and several (Vertex,
    // Bedrock, and gpt-image-1, which ignores `response_format` entirely) either refuse or
    // return base64 anyway. Requesting base64 is therefore the only spelling that is
    // correct on every deployment, and a provider that answers with a URL regardless is
    // handled by the store, which is exactly where URL handling already lives.
    const prompt = await this.resolvePrompt(request);

    const payload: Record<string, unknown> = {
      model,
      prompt,
      n: Math.max(1, request.count),
      response_format: 'b64_json',
    };

    if (request.size) payload.size = `${request.size.width}x${request.size.height}`;
    if (request.quality) payload.quality = request.quality;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.getCapabilities().limits.timeoutMs),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new ProviderError({
        provider: this.name,
        message: `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    if (!response.ok) throw await this.toProviderError(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ProviderError({
        provider: this.name,
        message: 'Upstream returned a body that is not valid JSON',
        code: 'unsupported_output',
        retryable: false,
        cause: error,
      });
    }

    const images = extractImages(body, request);

    if (images.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message:
          `Endpoint "${model}" returned no image data. The response carried no ` +
          'b64_json and no url, so there is nothing to deliver.',
        code: 'unsupported_output',
        retryable: false,
      });
    }

    logger.info('Native provider received images', {
      provider: this.name,
      model,
      received: images.length,
      requested: request.count,
      elapsedMs: Date.now() - started,
    });

    return {
      images,
      provider: this.name,
      model,
      timings: { queueMs: 0, providerMs: Date.now() - started, totalMs: Date.now() - started },
      cached: false,
      adaptations: {},
    };
  }

  /**
   * The prompt to send upstream: the planner's expansion when one is configured and usable,
   * otherwise exactly `buildNativePrompt(request)`.
   *
   * The disabled path is a literal pass-through, which is what keeps a zero-config
   * deployment's bytes — and therefore its snapshots, its cache keys and its tests —
   * unchanged. Three conditions guard the planner call, and each has a reason:
   *
   *   - **no planner configured** → the branch is never entered; no call, no latency, no log.
   *   - **`count > 1`** → skipped. Above one image the engine has already varied the prompt
   *     per variant (see `GenerationService.varyPrompt`); planning each variant again would
   *     rewrite the variation direction into prose and waste one planner call per image.
   *   - **planner returns `null`** → fall back. {@link planPrompt} already swallows its own
   *     failures, so `null` here means "unavailable or unusable", never "throw".
   *
   * A planner that throws despite that contract is still not allowed to fail the generation:
   * the catch is the last line of defence for the invariant that a quality-of-life feature
   * cannot turn a working request into a broken one.
   */
  private async resolvePrompt(request: ImageGenerationRequest): Promise<string> {
    const fallback = buildNativePrompt(request);
    if (!this.planner || request.count > 1) return fallback;

    try {
      return (await this.planner(request)) ?? fallback;
    } catch (error) {
      logger.warn('Prompt planner threw; using the original prompt', {
        provider: this.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  /**
   * Map an upstream failure onto a typed `ProviderError`.
   *
   * The status is preserved so the engine can classify retryable versus terminal, and so a
   * content-policy rejection reaches the caller as a 4xx naming the upstream code rather
   * than as a generic 502 that invites a pointless retry.
   */
  private async toProviderError(response: Response): Promise<ProviderError> {
    const raw = await response.text().catch(() => '');

    let code: string | undefined;
    let message = `Upstream error (${response.status})`;

    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; code?: string; type?: string };
      };
      if (parsed.error) {
        code = parsed.error.code ?? parsed.error.type;
        if (parsed.error.message) message = parsed.error.message;
      }
    } catch {
      // Non-JSON body: keep the generic message rather than leaking raw upstream text.
    }

    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds =
      retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;

    return new ProviderError({
      provider: this.name,
      message,
      status: response.status,
      code,
      retryAfterSeconds,
      upstreamBody: raw.slice(0, 500),
    });
  }
}

/**
 * Extract images from an images-API response body.
 *
 * Deliberately strict about the payload and forgiving about its spelling. `data[]` is the
 * documented shape; `images[]` and a bare array are accepted because proxies differ, and a
 * provider that answers correctly in a slightly different envelope should not be reported
 * as a failure. A record carrying *neither* `b64_json` nor `url` is skipped rather than
 * yielding an empty image: an entry with no payload would otherwise reach the artifact store
 * and fail there with a confusing `artifact_missing_payload` instead of being reported as
 * the upstream's problem.
 */
export function extractImages(body: unknown, request: ImageGenerationRequest): GeneratedImage[] {
  const records = readDataRecords(body);

  const images: GeneratedImage[] = [];
  for (const record of records) {
    const base64 = readFirstString(record, ['b64_json', 'image_base64', 'base64']);
    if (base64) {
      images.push({
        base64: stripDataUriPrefix(base64),
        mime: readMime(record) ?? MIME_BY_FORMAT[request.output.format] ?? DEFAULT_MIME,
      });
      continue;
    }

    const url = readFirstString(record, ['url', 'image_url']);
    if (url) {
      images.push({ url, mime: readMime(record) ?? guessMime(url) });
    }
  }

  return images;
}

/** Locate the array of per-image records in a response body. */
function readDataRecords(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter(isRecord);

  if (!isRecord(body)) return [];

  for (const key of ['data', 'images', 'artifacts']) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }

  // A single image returned unwrapped, which some gateways do for n=1.
  if ('b64_json' in body || 'url' in body) return [body];

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First non-empty string among `keys`. */
function readFirstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** An explicit mime on the record, if the endpoint provided one. */
function readMime(record: Record<string, unknown>): string | null {
  for (const key of ['mime', 'mime_type', 'content_type']) {
    const value = record[key];
    if (typeof value === 'string' && value.startsWith('image/')) return value;
  }
  return null;
}

function stripDataUriPrefix(value: string): string {
  const match = /^data:[^;]+;base64,(.*)$/s.exec(value);
  return match ? match[1] : value;
}

function guessMime(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
  if (lower.includes('.webp')) return 'image/webp';
  return DEFAULT_MIME;
}

/**
 * Choose a supported size for a requested aspect ratio.
 *
 * Exported because it is the one piece of non-obvious arithmetic here — matching a ratio to
 * the nearest discrete size — and it is cheap to test on its own.
 */
export function sizeForAspect(
  aspect: string,
  sizes: Array<{ width: number; height: number }>,
): { width: number; height: number } | null {
  const target = ASPECT_VALUES[aspect];
  if (!target || sizes.length === 0) return null;

  let best: { width: number; height: number } | null = null;
  let bestDelta = Infinity;

  for (const size of sizes) {
    const delta = Math.abs(size.width / size.height - target) / target;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = size;
    }
  }

  return bestDelta <= ASPECT_TOLERANCE ? best : null;
}
