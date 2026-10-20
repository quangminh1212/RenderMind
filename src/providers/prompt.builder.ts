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
  lines.push(
    'Visual finish: make it polished and richly detailed, with a clear composition, layered depth, ' +
      'natural lighting, texture, and a purposeful background; avoid a generic icon or empty canvas.',
  );
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

/**
 * Build the prompt for a **native** image endpoint.
 *
 * Deliberately not `buildImageInstruction`. That builder exists to *talk a language model
 * into* drawing, so it spells out the container, the dimensions, the aspect ratio, the
 * quality level and the seed in prose — none of which a native endpoint needs, because it
 * receives all of them as API fields. Reusing it here would send the same intent twice in
 * two vocabularies, and an image model given "Respond with the image only, as specified in
 * your instructions" tends to draw the instruction.
 *
 * So this builder emits the subject, and nothing that the request already carries in a
 * field. A negative prompt is the one exception: the images API has no field for it
 * (unlike the chat path, where the instruction carries it), so folding it into the subject
 * is the only way to honour the caller's intent at all — and `foldNegativePrompt` is the
 * established spelling for exactly that.
 *
 * The subject is prefixed with the requested dimensions only when the caller asked for an
 * explicit size. It is a hint the endpoint may already be honouring via `size`, but unlike
 * aspect/quality it is the kind of thing an image model acts on well, and the alternative —
 * dropping it — would silently discard part of the request.
 */
export function buildNativePrompt(request: ImageGenerationRequest): string {
  const base = foldNegativePrompt(request.prompt, request.negativePrompt);
  if (!request.size) return base;
  return `${base}\n\n${request.size.width}x${request.size.height} pixels.`;
}

/**
 * Scene-mode instruction — ask a text-only model for a compact JSON *scene*, not markup.
 *
 * This is the `scene` half of `CHAT_RENDER_MODE`. The contract it states is deliberately
 * narrow, because everything it permits is something the platform's `compileTextScene` gate
 * has a rule for and everything it omits is not:
 *
 *   - **Data, never markup.** The model returns one JSON object describing layers of typed
 *     shapes. It must not return SVG, base64, pixels or a `data:` URL — a scene the compiler
 *     accepts is turned into a document by *our* serializer, which is the only thing that
 *     ever writes markup. This is the whole safety argument for the mode: there is no path
 *     by which model-authored text becomes an element, an attribute or an event handler.
 *   - **A hard budget.** At most {@link SCENE_LAYER_BUDGET} layers and
 *     {@link SCENE_SHAPE_BUDGET} shapes in total, with short path data. The compiler enforces
 *     its own ceilings, but a model told the budget up front produces something that fits
 *     rather than something refused for exceeding `MAX_LAYERS`.
 *   - **The schema, spelled out.** Shape kinds, coordinate space and colours are named
 *     explicitly so the common failure — a plausible-looking object with the wrong keys — is
 *     avoided, and so a repair turn has a single reference to repeat.
 *
 * The ids the compiler needs (`sceneId`) are assigned by the caller and are deliberately not
 * something the model is asked for; a model that could name its own stream could make an
 * unparseable stream unaddressable.
 */
export const SCENE_LAYER_BUDGET = 16;
export const SCENE_SHAPE_BUDGET = 64;

/**
 * The standing system instruction for scene mode.
 *
 * Exported so a test can assert the *contract* — that a scene is asked for and pixels and
 * SVG are forbidden — without pinning the exact prose, which is expected to be tuned.
 */
export const SCENE_SYSTEM_INSTRUCTION = [
  'You are an image generation backend that describes pictures as structured JSON scenes.',
  'You cannot emit pixels or SVG; you emit a compact JSON object that a deterministic',
  'renderer turns into a picture. The object is data that is validated before anything is',
  'drawn, so a value that breaks the rules below is refused rather than rendered.',
  'Reply with exactly one JSON object and no other text, no markdown fence and no prose.',
  'Shape of the object:',
  '{"title":"<short title>","canvas":{"width":W,"height":H,"background":"#rrggbb"},',
  '"layers":[{"id":"<unique-id>","name":"<label>","shapes":[<shape>, ...]}]}',
  'A shape is exactly one of these objects, with these keys:',
  '{"kind":"rect","x":N,"y":N,"width":N,"height":N,"fill":"#rrggbb"}',
  '{"kind":"circle","cx":N,"cy":N,"r":N,"fill":"#rrggbb"}',
  '{"kind":"ellipse","cx":N,"cy":N,"rx":N,"ry":N,"fill":"#rrggbb"}',
  '{"kind":"line","x1":N,"y1":N,"x2":N,"y2":N,"stroke":"#rrggbb","strokeWidth":N}',
  '{"kind":"polygon","points":[{"x":N,"y":N}, ...],"fill":"#rrggbb"}',
  '{"kind":"path","d":"<svg path data>","fill":"#rrggbb"}',
  'Rules: every coordinate and size is a number in the canvas coordinate space; every layer',
  'has a unique "id" and a non-empty "shapes" array; colours are "#rrggbb" or "none".',
  `Draw in back-to-front paint order and use at most ${SCENE_LAYER_BUDGET} layers and at most ` +
    `${SCENE_SHAPE_BUDGET} shapes in total, with short path data so the object always fits in ` +
    'one reply. Never output SVG markup, base64, image bytes, data: URLs, script, or any key',
  'not shown above. Build a real composition (background, subject, foreground) with varied',
  'shapes, scale and colour rather than a single rectangle or an empty canvas.',
].join(' ');

/**
 * Build the user-turn instruction for scene mode.
 *
 * Mirrors {@link buildImageInstruction}: the caller's specification is folded into the turn
 * as prose, because a JSON scene has no field for a negative prompt, a quality level or a
 * seed — the same reason the SVG instruction carries them. The scene *envelope* stays a
 * JSON object (see {@link SCENE_SYSTEM_INSTRUCTION}); this turn carries only the subject and
 * the numeric hints a model can act on.
 */
export function buildSceneInstruction(request: ImageGenerationRequest): string {
  const parts = extractParts(request);
  const lines: string[] = [];

  lines.push('Describe an image as a single JSON scene object, as specified in your instructions.');

  if (parts.count > 1) {
    lines.push(
      `Produce ${parts.count} distinct scenes, each a separate JSON object on its own line.`,
    );
  } else {
    lines.push('Produce exactly one scene object.');
  }

  lines.push('');
  lines.push(`Subject: ${parts.prompt}`);

  if (parts.size) {
    lines.push(`Preferred canvas dimensions: ${parts.size} pixels.`);
    lines.push(`Set the canvas width and height, keeping every coordinate inside that box.`);
  }
  if (parts.aspect) lines.push(`Aspect ratio: ${parts.aspect}; match it with the canvas.`);
  if (parts.quality) lines.push(`Quality: ${parts.quality}.`);
  if (parts.style) lines.push(`Style: ${parts.style}.`);
  if (parts.negative) lines.push(`Do not include: ${parts.negative}.`);
  if (parts.seed !== null) lines.push(`Use seed ${parts.seed} for reproducibility.`);

  lines.push('');
  lines.push(
    'Respond with the JSON object only, as specified in your system instructions: no SVG, ' +
      'no code fence, no explanation, and no text outside the object.',
  );

  return lines.join('\n');
}
