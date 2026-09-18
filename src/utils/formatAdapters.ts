import type { GeneratedImage, ImageGenerationResult } from '../types/canonical.types';

/**
 * Response builders translating canonical results into each client protocol's shape.
 *
 * Kept pure (no I/O, no clock) so the exact bytes each protocol emits are unit-testable.
 */

// ─── openclaw images ─────────────────────────────────────────

export type OpenAIImageFormat = 'b64_json' | 'url';

export interface OpenAIImageDatum {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

export interface OpenAIImagesResponse {
  created: number;
  data: OpenAIImageDatum[];
  usage?: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
  };
  /** Non-standard; only present when explicitly enabled. */
  _rendermind?: {
    id: string;
    provider?: string;
    model?: string;
    generation_time_ms?: number;
    cached?: boolean;
    adaptations?: Record<string, unknown>;
  };
}

export interface OpenAIImagesResponseOptions {
  format: OpenAIImageFormat;
  /** One timestamp for the whole response, not one per image. */
  created: number;
  generationId: string;
  includeMetadata: boolean;
}

/**
 * Build an openclaw `/v1/images/generations` response body.
 *
 * Strictness matters here: a caller who asked for `b64_json` and sends the result
 * straight to `Buffer.from(data[0].b64_json, 'base64')` must never be handed a `url`
 * instead. If we cannot produce the requested format, we omit the payload rather than
 * substituting a different one — the route layer reports the failure.
 */
export function toOpenAIImagesResponse(
  result: ImageGenerationResult,
  options: OpenAIImagesResponseOptions,
): OpenAIImagesResponse {
  const data: OpenAIImageDatum[] = result.images.map((image) => {
    const datum: OpenAIImageDatum = {};

    if (image.revisedPrompt) datum.revised_prompt = image.revisedPrompt;

    if (options.format === 'url') {
      // A base64-only provider still yields a usable URL via a data URI, which keeps
      // this field a URL in shape while never silently switching formats.
      if (image.url) datum.url = image.url;
      else if (image.base64) datum.url = `data:${image.mime};base64,${image.base64}`;
    } else if (image.base64) {
      datum.b64_json = image.base64;
    }

    return datum;
  });

  const response: OpenAIImagesResponse = { created: options.created, data };

  if (options.includeMetadata) {
    response._rendermind = {
      id: options.generationId,
      provider: result.provider,
      model: result.model,
      generation_time_ms: result.timings.providerMs,
      cached: result.cached,
      ...(Object.keys(result.adaptations).length > 0
        ? { adaptations: result.adaptations as Record<string, unknown> }
        : {}),
    };
  }

  return response;
}

/** Whether every requested image could be delivered in the requested format. */
export function satisfiesFormat(
  result: ImageGenerationResult,
  format: OpenAIImageFormat,
  count: number,
): boolean {
  if (result.images.length < count) return false;
  return result.images.every((image) =>
    format === 'b64_json' ? Boolean(image.base64) : Boolean(image.url ?? image.base64),
  );
}

// ─── Anthropic messages ──────────────────────────────────────

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
/**
 * An `image` block is NOT a member of the Anthropic *response* ContentBlock union, so
 * emitting one is only valid as a documented extension (ANTHROPIC_IMAGE_BLOCK_MODE).
 */
export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type AnthropicContentBlock =
  AnthropicTextBlock | AnthropicToolUseBlock | AnthropicImageBlock;

export interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** The tool the bridge uses to hand an image back to a coding agent. */
export const IMAGE_TOOL_NAME = 'generate_image';

export interface AnthropicResponseOptions {
  model: string;
  prompt: string;
  generationId: string;
  /** Emit an `image` content block (non-spec extension) instead of a tool_use block. */
  imageBlockMode: 'extension' | 'off';
}

/**
 * Estimate token counts.
 *
 * The previous adapter hardcoded `{input_tokens: 0, output_tokens: 1}`, which billing and
 * telemetry clients read literally. We estimate instead: ~4 characters per token is the
 * conventional English approximation. This is documented as an estimate, not a metered
 * count (see docs/protocols/anthropic-messages.md).
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Build an Anthropic `/v1/messages` response.
 *
 * Default shape is a `tool_use` block, which is spec-valid: the Anthropic response
 * ContentBlock union has no `image` member, so the previous image-block response was
 * rejected by strict clients.
 */
export function toAnthropicMessagesResponse(
  result: ImageGenerationResult,
  options: AnthropicResponseOptions,
): AnthropicMessagesResponse {
  const content: AnthropicContentBlock[] = [];
  const count = result.images.length;

  content.push({
    type: 'text',
    text: `Generated ${count} image${count === 1 ? '' : 's'} for: ${truncate(options.prompt, 200)}`,
  });

  if (options.imageBlockMode === 'extension') {
    for (const image of result.images) {
      if (image.base64) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mime, data: image.base64 },
        });
      }
    }
  } else {
    content.push({
      type: 'tool_use',
      id: `toolu_${options.generationId.replace(/^gen_/, '')}`,
      name: IMAGE_TOOL_NAME,
      input: {
        prompt: options.prompt,
        image_count: count,
        images: result.images.map((image, index) => ({
          index,
          url: image.url,
          mime: image.mime,
          ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
        })),
        provider: result.provider,
        model: result.model,
        ...(Object.keys(result.adaptations).length > 0
          ? { adaptations: result.adaptations as Record<string, unknown> }
          : {}),
      },
    });
  }

  const outputText = JSON.stringify(content);

  return {
    id:
      result.cached && options.generationId.startsWith('msg_')
        ? options.generationId
        : `msg_${options.generationId.replace(/^gen_/, '')}`,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content,
    stop_reason: options.imageBlockMode === 'extension' ? 'end_turn' : 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(options.prompt),
      output_tokens: estimateTokens(outputText),
    },
  };
}

/** The `generate_image` tool declaration, so callers can pass it in `tools[]`. */
export function imageToolDeclaration(): Record<string, unknown> {
  return {
    name: IMAGE_TOOL_NAME,
    description:
      'Generate one or more images from a text prompt. Returns the generated images as URLs.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'A detailed description of the image to generate.',
        },
        size: {
          type: 'string',
          description: 'Requested size, e.g. "1024x1024". Defaults to the provider default.',
        },
        count: {
          type: 'integer',
          description: 'How many images to generate (1-10). Defaults to 1.',
          minimum: 1,
          maximum: 10,
        },
        seed: {
          type: 'integer',
          description: 'Seed for reproducible output, when the provider supports it.',
        },
      },
      required: ['prompt'],
    },
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ─── Error envelopes ─────────────────────────────────────────

/**
 * Anthropic error taxonomy.
 *
 * Anthropic has no 403; an invalid key is a 401. `529 overloaded_error` is
 * Anthropic-specific and must not be reported as a generic 503.
 */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'billing_error'
  | 'conflict_error'
  | 'timeout_error'
  | 'api_error'
  | 'overloaded_error';

export interface AnthropicErrorBody {
  type: 'error';
  error: { type: AnthropicErrorType; message: string };
  request_id?: string;
}

export function toAnthropicError(
  message: string,
  status: number,
  requestId?: string,
): AnthropicErrorBody {
  const body: AnthropicErrorBody = {
    type: 'error',
    error: { type: anthropicErrorTypeFor(status), message },
  };
  if (requestId) body.request_id = requestId;
  return body;
}

/**
 * Map an HTTP status onto Anthropic's error taxonomy.
 *
 * Deliberately explicit rather than a range check, because the audit found the old
 * implementation collapsing everything >= 500 into `api_error` and having no way to
 * express 529 at all.
 */
export function anthropicErrorTypeFor(status: number): AnthropicErrorType {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 402:
      return 'billing_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 409:
      return 'conflict_error';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_error';
    case 504:
      return 'timeout_error';
    case 529:
      return 'overloaded_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

export type openclawErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error';

export interface openclawErrorBody {
  error: {
    message: string;
    type: openclawErrorType;
    param: string | null;
    code: string | null;
  };
}

export function toOpenAIError(
  message: string,
  status: number,
  param: string | null = null,
  code?: string,
): openclawErrorBody {
  const type: openclawErrorType =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'server_error'
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

/** Map a canonical image result onto a plain image description. */
export function describeImage(image: GeneratedImage): string {
  if (image.url) return image.url;
  if (image.base64) return `<base64 ${image.mime}, ${image.base64.length} chars>`;
  return '<empty>';
}
