import { createHash } from 'crypto';
import type { GeneratedImage, ImageFormat, ImageGenerationResult } from '../types/canonical.types';

/**
 * Response builders translating canonical results into the client-facing shape.
 *
 * Kept pure (no I/O, no clock) so the exact bytes emitted are unit-testable.
 *
 * There is one response shape, because there is one public surface (`/chat`,
 * `/vision`). The earlier build had per-protocol builders (openclaw images,
 * Anthropic messages) because it served three protocols; those went away with the
 * native image providers they translated to.
 */

// ─── /chat and /vision ───────────────────────────────────────

export interface ChatImageDatum {
  /** Present when the caller asked for base64 delivery. */
  base64?: string;
  /** Present when the caller asked for URL delivery; a data URI when only base64 exists. */
  url?: string;
  mime: string;
  revised_prompt?: string;
  /**
   * The source vector document, when the image was drawn as SVG.
   *
   * Present only when the caller explicitly asked for `format: 'svg'`. It is emitted
   * alongside — never instead of — the base64 payload, so a client written against the old
   * shape keeps working while one that wants editable artwork can have it.
   *
   * This field is the reason the format is opt-in: it is a document, not a bitmap, and a
   * client that renders `base64` blindly would otherwise be handed something executable.
   */
  svg?: string;
}

export interface ChatResponse {
  id: string;
  object: 'image.generation';
  created: number;
  model: string;
  provider: string;
  images: ChatImageDatum[];
  /** Relative cost/latency facts for the caller to observe. */
  timings: { total_ms: number };
  /** Non-standard; only present when explicitly enabled. */
  _rendermind?: {
    cached: boolean;
    adaptations?: Record<string, unknown>;
  };
}

export interface ChatResponseOptions {
  delivery: 'base64' | 'url';
  /** One timestamp for the whole response, not one per image. */
  created: number;
  generationId: string;
  includeMetadata: boolean;
  /**
   * The container the caller asked for.
   *
   * Needed because `mime` alone cannot express intent: a rasterized image is always
   * `image/png` whether or not the caller wanted it, whereas the vector source is only
   * theirs to receive if they asked for `svg`.
   */
  format?: ImageFormat;
}

/**
 * Build the `/chat` and `/vision` response body.
 *
 * A caller who asked for base64 must receive base64. A URL-only image is inlined by the
 * engine before reaching here, so a missing payload means the engine could not honour the
 * request — this builder never substitutes one format for another.
 */
export function toChatResponse(
  result: ImageGenerationResult,
  options: ChatResponseOptions,
): ChatResponse {
  const images: ChatImageDatum[] = result.images.map((image) => {
    const datum: ChatImageDatum = { mime: image.mime };

    if (options.delivery === 'url') {
      if (image.url) datum.url = image.url;
      // A vector image may arrive with only its document, because the provider delivered
      // the markup rather than a raster. Encoding it here is what lets url delivery work
      // for the svg format at all — without this arm the response would be a datum with a
      // mime and no payload, which reads to a client as an empty image.
      else if (image.base64) datum.url = `data:${image.mime};base64,${image.base64}`;
      else if (image.svg) {
        datum.url = `data:${image.mime};base64,${Buffer.from(image.svg, 'utf8').toString('base64')}`;
      }
    } else if (image.base64) {
      datum.base64 = image.base64;
    }

    if (image.revisedPrompt) datum.revised_prompt = image.revisedPrompt;
    // The vector source travels only with an explicit svg request. It is already validated
    // by the time it reaches this builder; passing it through unvalidated would put an
    // executable document in front of a browser.
    if (image.svg && options.format === 'svg') datum.svg = image.svg;
    return datum;
  });

  const response: ChatResponse = {
    id: options.generationId,
    object: 'image.generation',
    created: options.created,
    model: result.model,
    provider: result.provider,
    images,
    timings: { total_ms: result.timings.totalMs },
  };

  if (options.includeMetadata) {
    response._rendermind = {
      cached: result.cached,
      ...(Object.keys(result.adaptations).length > 0
        ? { adaptations: result.adaptations as Record<string, unknown> }
        : {}),
    };
  }

  return response;
}

export interface ChatErrorBody {
  error: {
    message: string;
    type: 'invalid_request_error' | 'unsupported_capability' | 'rate_limit_error' | 'server_error';
    param: string | null;
    code: string | null;
  };
}

/**
 * Build the error envelope for `/chat` and `/vision`.
 *
 * One shape for the whole surface, so a client cannot be handed an envelope it cannot
 * parse.
 */
export function toChatError(
  message: string,
  status: number,
  param: string | null = null,
  code?: string,
): ChatErrorBody {
  const type: ChatErrorBody['error']['type'] =
    status === 429
      ? 'rate_limit_error'
      : status >= 500
        ? 'server_error'
        : code === 'unsupported_capability' || code === 'unsupported_output'
          ? 'unsupported_capability'
          : 'invalid_request_error';

  return {
    error: {
      message,
      type,
      param,
      code: code ?? (type === 'server_error' ? 'server_error' : type),
    },
  };
}

/**
 * Whether every requested image carries a payload in the requested delivery mode.
 *
 * Presence alone is not enough: an image whose `mime` contradicts the container the caller
 * asked for is a substitution, not a delivery. That check used to be missing, so a caller
 * who requested PNG and received something else was reported as satisfied.
 */
export function satisfiesDelivery(
  result: ImageGenerationResult,
  delivery: 'base64' | 'url',
  count: number,
  format?: ImageFormat,
): boolean {
  if (result.images.length < count) return false;

  return result.images.every((image) => {
    // A validated vector document is a payload in its own right: the provider delivers the
    // markup instead of a raster when `format: 'svg'` was asked for, so counting only
    // base64/url would report a correct delivery as missing.
    const carries =
      Boolean(image.svg) ||
      (delivery === 'base64' ? Boolean(image.base64) : Boolean(image.url ?? image.base64));
    if (!carries) return false;
    // Only the raster/vector distinction is enforced. A model that returned a JPEG for a
    // PNG request is not a contract violation worth failing on — same kind of artifact —
    // whereas a document delivered under a bitmap request is.
    if (!format) return true;
    return format === 'svg' ? image.mime === VECTOR_MIME : image.mime !== VECTOR_MIME;
  });
}

/** The media type each requested format should arrive as, at the type level. */
const VECTOR_MIME = 'image/svg+xml';

/** A stable content hash for an image, used when a caller wants to dedupe results. */
export function imageFingerprint(image: GeneratedImage): string {
  const material = image.base64 ?? image.url ?? '';
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Map a canonical image result onto a plain image description. */
export function describeImage(image: GeneratedImage): string {
  if (image.url) return image.url;
  if (image.base64) return `<base64 ${image.mime}, ${image.base64.length} chars>`;
  return '<empty>';
}
