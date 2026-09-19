import { z } from 'zod';
import type {
  AspectRatio,
  ImageGenerationRequest,
  ReferenceImage,
} from '../../types/canonical.types';

/**
 * Inbound schema and translation for the two public image endpoints.
 *
 * `/chat`  — text prompt in, image out.
 * `/vision` — text prompt plus one or more input images in, image out.
 *
 * The two share a body shape deliberately: `/vision` simply requires `images`, which
 * keeps one translation path and one set of error semantics. A caller who sends
 * `images` to `/chat` is told to use `/vision` rather than having them ignored.
 */

/** Guard against an oversized inline payload reaching the upstream model. */
const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

/**
 * One input image, accepted in any of the spellings a caller might send: a bare
 * base64 payload or data URI as a string, or an object carrying `data`, `url` and a
 * `mime` hint. Modelled as an explicit union member rather than `z.union([...])` so the
 * inferred type is a concrete union instead of `{}`.
 */
const ImageInputSchema = z.union([
  z.string().min(1),
  z
    .object({
      data: z.string().min(1).optional(),
      url: z.string().url().optional(),
      mime: z.string().optional(),
    })
    .refine((value) => Boolean(value.data ?? value.url), {
      message: 'image must carry data or url',
    }),
]);

/** A normalised image input, as the translation layer consumes it. */
export type ImageInput = z.infer<typeof ImageInputSchema>;

export const ChatRequestSchema = z
  .object({
    prompt: z.string().min(1, 'prompt is required').max(32000),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    size: z
      .string()
      .regex(/^\d{2,5}x\d{2,5}$/, 'size must be formatted as "WIDTHxHEIGHT", e.g. "1024x1024"')
      .optional(),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
    aspect_ratio: z.string().optional(),
    quality: z.enum(['draft', 'standard', 'high']).optional(),
    style: z.string().max(200).optional(),
    negative_prompt: z.string().max(4000).optional(),
    seed: z.number().int().min(0).optional(),
    count: z.number().int().min(1).max(10).optional(),
    format: z.enum(['png', 'jpeg', 'webp']).optional(),
    /** Delivery: `base64` inlines the bytes, `url` returns a URL (or a data URI). */
    response_format: z.enum(['b64_json', 'url']).optional(),
  })
  .passthrough();

export const VisionRequestSchema = ChatRequestSchema.extend({
  images: z
    .array(ImageInputSchema)
    .min(1, 'images must contain at least one image')
    .max(4, 'at most 4 input images are supported'),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type VisionRequest = z.infer<typeof VisionRequestSchema>;

export interface ChatTranslation {
  ok: true;
  request: ImageGenerationRequest;
}
export interface ChatTranslationFailure {
  ok: false;
  param: string | null;
  message: string;
}

/** Supported aspect ratios, mirroring the canonical union. */
const ASPECT_VALUES: Record<string, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
};

/**
 * Translate a `/chat` or `/vision` body into a canonical request.
 *
 * `withImages` decides whether `images` is required: `/chat` rejects a body carrying
 * them (the caller wanted `/vision`), `/vision` requires at least one.
 */
export function translateChatRequest(
  body: ChatRequest | VisionRequest,
  options: { withImages: boolean },
): ChatTranslation | ChatTranslationFailure {
  // `'images' in body` widens to `{}` under the passthrough union, so narrow with a
  // typeof check the compiler can follow.
  const images: ImageInput[] | undefined =
    'images' in body && Array.isArray(body.images) ? body.images : undefined;

  if (!options.withImages && images && images.length > 0) {
    return {
      ok: false,
      param: 'images',
      message: 'This endpoint takes a text prompt only. POST to /vision to supply input images.',
    };
  }

  const sizeResult = resolveSize(body);
  if (!sizeResult.ok) return sizeResult;

  const aspect = body.aspect_ratio ? normalizeAspect(body.aspect_ratio) : null;
  if (body.aspect_ratio && aspect === null) {
    return {
      ok: false,
      param: 'aspect_ratio',
      message: `Unsupported aspect_ratio "${body.aspect_ratio}". Accepted: ${Object.keys(
        ASPECT_VALUES,
      ).join(', ')}.`,
    };
  }

  let referenceImages: ReferenceImage[] | undefined;
  if (options.withImages) {
    const parsed = parseImages(images ?? []);
    if (!parsed.ok) return parsed;
    referenceImages = parsed.images;
  }

  const request: ImageGenerationRequest = {
    prompt: body.prompt,
    negativePrompt: body.negative_prompt,
    count: body.count ?? 1,
    size: sizeResult.size,
    aspect,
    quality: body.quality ?? null,
    seed: body.seed,
    model: body.model,
    provider: body.provider,
    style: body.style,
    referenceImages,
    output: {
      format: body.format ?? 'png',
      delivery: body.response_format === 'url' ? 'url' : 'base64',
    },
    metadata: { source: options.withImages ? 'vision' : 'chat' },
  };

  return { ok: true, request };
}

/** Resolve `size` / `width`+`height` into an explicit size, or null to let the model decide. */
function resolveSize(
  body: ChatRequest,
): { ok: true; size: { width: number; height: number } | null } | ChatTranslationFailure {
  if (body.size) {
    const [w, h] = body.size.split('x').map(Number);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 64 || h < 64) {
      return { ok: false, param: 'size', message: 'size must be between 64x64 and 4096x4096' };
    }
    return { ok: true, size: { width: w, height: h } };
  }

  if (body.width !== undefined || body.height !== undefined) {
    return { ok: true, size: { width: body.width ?? 1024, height: body.height ?? 1024 } };
  }

  return { ok: true, size: null };
}

/**
 * Normalise the accepted image input spellings into `ReferenceImage` records.
 *
 * A plain string may be either a data URI or an http(s) URL. A URL is fetched here, at
 * validation time, so a bad URL is a clear 400 rather than an upstream failure inside
 * the model call — and so the model receives bytes, not a reference it cannot resolve.
 */
function parseImages(
  inputs: ImageInput[],
): { ok: true; images: ReferenceImage[] } | ChatTranslationFailure {
  const images: ReferenceImage[] = [];

  for (const [index, input] of inputs.entries()) {
    const asString = typeof input === 'string' ? input : (input.data ?? input.url ?? '');
    if (!asString) {
      return { ok: false, param: `images[${index}]`, message: 'image must carry data or url' };
    }

    if (asString.startsWith('data:')) {
      const parsed = parseDataUri(asString);
      if (!parsed) {
        return {
          ok: false,
          param: `images[${index}]`,
          message: 'data URI must be of the form data:image/<type>;base64,<payload>',
        };
      }
      images.push(parsed);
      continue;
    }

    if (/^https?:\/\//i.test(asString)) {
      return {
        ok: false,
        param: `images[${index}]`,
        message: 'Remote image URLs are not fetched inline. Send the image as a base64 data URI.',
      };
    }

    // A bare base64 payload.
    if (asString.length > MAX_IMAGE_BASE64_CHARS) {
      return {
        ok: false,
        param: `images[${index}]`,
        message: `image exceeds the ${MAX_IMAGE_BASE64_CHARS} character limit`,
      };
    }

    images.push({
      data: asString,
      mime: typeof input === 'object' && input.mime ? input.mime : 'image/png',
    });
  }

  return { ok: true, images };
}

function parseDataUri(uri: string): ReferenceImage | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(uri);
  if (!match) return null;
  return { data: match[2], mime: match[1].toLowerCase() };
}

/** Accept "16:9" as well as the common "16x9" spelling. */
export function normalizeAspect(value: string): AspectRatio | null {
  const normalized = value.replace('x', ':').replace(/\s/g, '');
  const [w, h] = normalized.split(':').map(Number);
  if (!w || !h) return null;

  const ratio = w / h;
  let best: AspectRatio | null = null;
  let bestDelta = Infinity;

  for (const [aspect, target] of Object.entries(ASPECT_VALUES)) {
    const delta = Math.abs(ratio - target) / target;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = aspect as AspectRatio;
    }
  }

  return bestDelta <= 0.02 ? best : null;
}
