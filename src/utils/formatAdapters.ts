import { createHash } from 'crypto';
import type { GeneratedImage, ImageGenerationResult } from '../types/canonical.types';

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
      else if (image.base64) datum.url = `data:${image.mime};base64,${image.base64}`;
    } else if (image.base64) {
      datum.base64 = image.base64;
    }

    if (image.revisedPrompt) datum.revised_prompt = image.revisedPrompt;
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

/** Whether every requested image carries a payload in the requested delivery mode. */
export function satisfiesDelivery(
  result: ImageGenerationResult,
  delivery: 'base64' | 'url',
  count: number,
): boolean {
  if (result.images.length < count) return false;
  return result.images.every((image) =>
    delivery === 'base64' ? Boolean(image.base64) : Boolean(image.url ?? image.base64),
  );
}

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
