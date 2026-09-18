import { z } from 'zod';
import type {
  AspectRatio,
  ImageFormat,
  ImageGenerationRequest,
  QualityLevel,
} from '../../types/canonical.types';

/**
 * Inbound schema and translation for the openclaw `/v1/images/generations` protocol.
 *
 * Validation is strict where the previous implementation was permissive in ways that
 * hurt: `size` was parsed with an unvalidated `parseInt` (so `"1024"` became `NaN`), and
 * `quality`/`style` were free-form strings that were validated, never forwarded, and
 * silently dropped.
 */

/** Sizes openclaw's own models accept. Used only for validation hints, not enforced. */
export const ASPECT_VALUES: Record<AspectRatio, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
};

/** `quality` values openclaw accepts, mapped onto canonical intent. */
const QUALITY_MAP: Record<string, QualityLevel> = {
  standard: 'standard',
  hd: 'high',
  high: 'high',
  medium: 'standard',
  low: 'draft',
  draft: 'draft',
  auto: 'standard',
};

export const OpenAIImagesRequestSchema = z
  .object({
    prompt: z.string().min(1, 'prompt is required').max(32000),
    model: z.string().min(1).optional(),
    size: z
      .string()
      .regex(/^\d{2,5}x\d{2,5}$/, 'size must be formatted as "WIDTHxHEIGHT", e.g. "1024x1024"')
      .optional(),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
    n: z.number().int().min(1).max(10, 'n must be between 1 and 10').optional(),
    response_format: z.enum(['b64_json', 'url']).optional(),
    quality: z.string().optional(),
    style: z.string().optional(),
    output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
    negative_prompt: z.string().max(4000).optional(),
    seed: z.number().int().min(0).optional(),
    user: z.string().max(512).optional(),

    // RenderMind extensions beyond the openclaw surface.
    backend: z.string().optional(),
    steps: z.number().int().min(1).max(150).optional(),
    cfg_scale: z.number().min(1).max(30).optional(),
    webhook_url: z.string().url().optional(),
    aspect_ratio: z.string().optional(),
  })
  .passthrough();

export type OpenAIImagesRequest = z.infer<typeof OpenAIImagesRequestSchema>;

export interface TranslationResult {
  ok: true;
  request: ImageGenerationRequest;
}
export interface TranslationFailure {
  ok: false;
  /** Field that caused the failure, for the protocol error envelope's `param`. */
  param: string | null;
  message: string;
}

/**
 * Validate protocol-specific constraints and translate into a canonical request.
 *
 * Some rules cannot be expressed in the schema alone because they depend on which model
 * is requested — e.g. DALL·E 3 accepts only `n: 1` and three discrete sizes.
 */
export function translateOpenAIImagesRequest(
  body: OpenAIImagesRequest,
): TranslationResult | TranslationFailure {
  const model = body.model ?? '';

  // Model-dependent constraint, enforced here rather than silently ignored.
  if (/^dall-e-3/i.test(model) && body.n !== undefined && body.n > 1) {
    return {
      ok: false,
      param: 'n',
      message: 'dall-e-3 supports only n=1. Request multiple images without specifying a model.',
    };
  }

  const size = resolveSize(body);
  if (!size.ok) return size;

  const quality = body.quality ? (QUALITY_MAP[body.quality.toLowerCase()] ?? null) : null;
  if (body.quality && quality === null) {
    return {
      ok: false,
      param: 'quality',
      message: `Unsupported quality "${body.quality}". Accepted values: ${Object.keys(QUALITY_MAP).join(', ')}.`,
    };
  }

  const aspect = body.aspect_ratio ? normalizeAspect(body.aspect_ratio) : null;
  if (body.aspect_ratio && aspect === null) {
    return {
      ok: false,
      param: 'aspect_ratio',
      message: `Unsupported aspect_ratio "${body.aspect_ratio}". Accepted: ${Object.keys(ASPECT_VALUES).join(', ')}.`,
    };
  }

  const request: ImageGenerationRequest = {
    prompt: body.prompt,
    negativePrompt: body.negative_prompt,
    count: body.n ?? 1,
    size: size.size,
    aspect,
    quality,
    steps: body.steps,
    guidanceScale: body.cfg_scale,
    seed: body.seed,
    model: body.model,
    provider: body.backend,
    style: body.style,
    output: {
      format: (body.output_format as ImageFormat) ?? 'png',
      delivery: body.response_format === 'url' ? 'url' : 'base64',
    },
    callbackUrl: body.webhook_url,
    metadata: body.user ? { userId: body.user } : undefined,
  };

  return { ok: true, request };
}

/** Resolve `size` / `width`+`height` into an explicit size, or null for auto. */
function resolveSize(
  body: OpenAIImagesRequest,
): { ok: true; size: { width: number; height: number } | null } | TranslationFailure {
  if (body.size) {
    const [w, h] = body.size.split('x').map(Number);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 64 || h < 64) {
      return {
        ok: false,
        param: 'size',
        message: 'size must be between 64x64 and 4096x4096',
      };
    }
    return { ok: true, size: { width: w, height: h } };
  }

  if (body.width !== undefined || body.height !== undefined) {
    return { ok: true, size: { width: body.width ?? 1024, height: body.height ?? 1024 } };
  }

  return { ok: true, size: null };
}

/** Accept "16:9" as well as the common "16x9" spelling. */
export function normalizeAspect(value: string): AspectRatio | null {
  const normalized = value.replace('x', ':').replace(/\s/g, '');
  const [w, h] = normalized.split(':').map(Number);
  if (!w || !h) return null;

  const ratio = w / h;
  let best: AspectRatio | null = null;
  let bestDelta = Infinity;

  for (const [aspect, target] of Object.entries(ASPECT_VALUES) as Array<[AspectRatio, number]>) {
    const delta = Math.abs(ratio - target) / target;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = aspect;
    }
  }

  // Reject anything not a close match to a supported ratio.
  return bestDelta <= 0.02 ? best : null;
}
