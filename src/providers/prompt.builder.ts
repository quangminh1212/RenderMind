import type { ImageGenerationRequest } from '../types/canonical.types';

/**
 * Prompt construction for text-only chat models.
 *
 * Kept pure (no I/O, no clock) so the exact instruction sent upstream — which is the
 * whole behaviour of this engine — is unit-testable as a string.
 *
 * Design rule: the instruction must be *explicit about the delivery format*, because a
 * chat model defaults to prose. Every field the canonical request carries that the model
 * cannot honour natively (negative prompt, size, seed) is folded into the instruction
 * text rather than being dropped silently — the matcher already discloses which of them
 * the provider cannot honour natively.
 */

/** The directives the instruction can carry, in the order they are emitted. */
export interface ImageInstructionParts {
  prompt: string;
  size: string | null;
  aspect: string | null;
  negative: string | null;
  count: number;
  quality: string | null;
  style: string | null;
  seed: number | null;
}

/**
 * Build the user-turn instruction.
 *
 * The requested aspect ratio is expressed in words as well as numbers ("16:9 (widescreen)")
 * because models honour the semantic label more reliably than a bare ratio.
 */
export function buildImageInstruction(request: ImageGenerationRequest): string {
  const parts = extractParts(request);
  const lines: string[] = [];

  lines.push('Generate an image with the following specification.');

  if (parts.count > 1) {
    lines.push(
      `Produce ${parts.count} distinct images. Return each one as a separate markdown image.`,
    );
  } else {
    lines.push('Produce exactly one image.');
  }

  lines.push('');
  lines.push(`Subject: ${parts.prompt}`);

  if (parts.size) lines.push(`Dimensions: ${parts.size} pixels.`);
  if (parts.aspect) lines.push(`Aspect ratio: ${parts.aspect}.`);
  if (parts.quality) lines.push(`Quality: ${parts.quality}.`);
  if (parts.style) lines.push(`Style: ${parts.style}.`);
  if (parts.negative) lines.push(`Do not include: ${parts.negative}.`);
  if (parts.seed !== null) lines.push(`Use seed ${parts.seed} for reproducibility.`);

  lines.push('');
  lines.push('Respond with the image only, as specified in your instructions.');

  return lines.join('\n');
}

/** Extract the instruction parts, including the aspect label. */
export function extractParts(request: ImageGenerationRequest): ImageInstructionParts {
  return {
    prompt: request.prompt,
    size: request.size ? `${request.size.width}x${request.size.height}` : null,
    aspect: request.aspect ? describeAspect(request.aspect) : null,
    negative: request.negativePrompt ?? null,
    count: Math.max(1, request.count),
    quality: request.quality ? QUALITY_WORDS[request.quality] : null,
    style: request.style ?? null,
    seed: request.seed ?? null,
  };
}

/** Human-readable labels, because a model honours "widescreen" more reliably than "16:9". */
const ASPECT_WORDS: Record<string, string> = {
  '1:1': '1:1 (square)',
  '16:9': '16:9 (widescreen landscape)',
  '9:16': '9:16 (vertical portrait)',
  '3:2': '3:2 (landscape photograph)',
  '2:3': '2:3 (portrait photograph)',
  '4:3': '4:3 (standard landscape)',
  '3:4': '3:4 (standard portrait)',
};

function describeAspect(aspect: string): string {
  return ASPECT_WORDS[aspect] ?? aspect;
}

/** Coarse quality intent, expanded so the model has something concrete to act on. */
const QUALITY_WORDS: Record<string, string> = {
  draft: 'draft — fast, lower detail',
  standard: 'standard — balanced detail',
  high: 'high — maximum detail and fidelity',
};

/** Fold a negative prompt into the main prompt, for providers with no native field. */
export function foldNegativePrompt(prompt: string, negativePrompt?: string): string {
  if (!negativePrompt) return prompt;
  return `${prompt}\n\nAvoid: ${negativePrompt}`;
}
