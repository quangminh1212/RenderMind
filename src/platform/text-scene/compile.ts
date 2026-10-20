/**
 * Text-scene compiler — a text-only chat response becomes a renderable scene.
 *
 * This module is the join between the two halves of the progressive track. `extract.ts` reads a
 * model's reply and finds a JSON object in it; `platform/progressive` validates that object and
 * assembles it into frames. Each half is total on its own, and neither knows about the other.
 * This file is the one place they meet, and its only job is to compose them in the right order
 * without ever letting an unvalidated payload past the gate.
 *
 * ## The shape of a successful result
 *
 * A caller gets four things, and the redundancy is deliberate:
 *
 *   1. `scene` — the normalized scene. The thing you keep if you want to re-render later.
 *   2. `svg` — the **final** frame, a complete standalone document. The thing you hand to a
 *      rasterizer or to a client that only wants the finished picture.
 *   3. `finalFrame` — the scene's last *layer* frame (`index === layers.length - 1`), so a caller
 *      does not have to count bytes or walk the array to report progress.
 *   4. `frames` — every `ProgressiveFrameEvent`, placeholder first, ready to write to a
 *      transport. The thing you stream.
 *
 * Why all four rather than one? Because the three consumers are genuinely different and each
 * would otherwise re-derive what this function already had in hand. A non-streaming caller
 * wants `svg` and would have to assemble the whole sequence to get it. A streaming caller wants
 * `frames` and would have to know that the placeholder frame exists and that the *events* are
 * wrapped rather than the raw frames. A caching layer wants `scene`. Returning one and making the
 * others re-run the pipeline is how the three paths drift apart — one of them eventually forgets
 * to validate, and the drift is invisible until it is exploitable.
 *
 * ## The frame sequence's index shape (read this before consuming `frames`)
 *
 * `frames` is passed through from `renderSceneFrames` unchanged, and that function's sequence has
 * a deliberate shape worth stating because it is not what a cursory read suggests. A scene of N
 * layers yields **N + 1** frames:
 *
 *   - `frames[0]` is the placeholder: `index: 0`, `layerId: null`, `shapeCount: 0`.
 *   - `frames[1..N]` are the layer frames, with `index: 0 .. N-1`, `total: N`.
 *
 * So `index` is **not** unique across the sequence — the placeholder and the first layer both
 * report `index: 0` — and `total` counts layers, not frames. That is upstream's wire contract and
 * this module does not rewrite it: renumbering here would make a compiled stream disagree with
 * one built by calling `renderSceneFrames` directly, which is exactly the drift the previous
 * paragraph warns about. A client disambiguates the placeholder by `layerId === null`; the
 * `id` field (`"<sceneId>:<index>"`) inherits the same non-uniqueness at index 0.
 *
 * `finalFrame` is therefore `frames[N]`, the frame that introduced the last layer — *not*
 * "index N", which does not exist for an N-layer scene.
 *
 * ## Why the SVG is complete, and why this is not rasterization
 *
 * `svg` is the *last* frame, which is a complete document containing every layer — not a
 * fragment, and not an accumulated diff. That matters because the caller is expected to
 * rasterize exactly this string: PNG and JPEG have no progressive story, so a caller producing
 * a bitmap wants the finished picture, not the stream. Rasterizing it here would be wrong twice
 * over — it would put a native dependency in the platform layer's reach, and it would force
 * every streaming caller to pay for a render it will never use. The provider rasterizes; this
 * module only guarantees that what it hands over is a document the engine's own gate accepts.
 *
 * ## Two failure families, and why they are kept apart
 *
 * The result is a union of three outcomes rather than two, because "the model did not produce a
 * scene" is not one condition:
 *
 *   - **Extraction failed** (`stage: 'extract'`) — no JSON object in the reply. Prose, a
 *     truncated token stream, an oversized payload, or an image-only content-part list.
 *   - **Validation failed** (`stage: 'validate'`) — a JSON object was found, and it is not a
 *     drawable, safe scene. Bad geometry, an undeclared gradient, a canvas over the edge limit,
 *     a `data:` URL smuggled into a paint field.
 *   - **Accepted** — both stages passed.
 *
 * A single `ok: false` with a merged code would be simpler and worse. The two families imply
 * different caller behaviour: extraction failure means *nothing scene-shaped was attempted*, so
 * retrying the same way reproduces it; validation failure means a scene was attempted and its
 * geometry was refused, which is frequently a prompt-size or coordinate-scaling problem that a
 * different request can fix. Collapsing them would force every caller to pattern-match on code
 * strings to recover a distinction this module already knew.
 *
 * ## Totality
 *
 * `compileTextScene` never throws. Every input — `null`, a Buffer, a 40 MB string, a nested
 * object — produces a stable failure. That is the same contract `normalizeScene` and
 * `validateSvg` are held to, and for the same reason: a compiler that throws on hostile input
 * forces a `try`/`catch` at a layer that has no business reasoning about JSON, and the
 * exception it produces is not stable enough to branch on.
 */
import {
  renderSceneFrames,
  sceneStatistics,
  toFrameEvent,
  type SceneRejectionCode,
  type SceneValidation,
} from '../progressive';
import type {
  NormalizedScene,
  ProgressiveFrame,
  ProgressiveFrameEvent,
  ProgressiveFrameZero,
  SceneStatistics,
} from '../../types/progressive.types';
import {
  extractSceneCandidate,
  isUsableSceneId,
  type SceneExtractionCode,
  type SceneExtractionSource,
} from './extract';

/** The stable, client-visible codes a compile can fail with. */
export type TextSceneFailureCode = SceneExtractionCode | SceneRejectionCode | 'scene_id_invalid';

/**
 * Which stage refused the payload.
 *
 * `'input'` covers the checks this module makes about its *own* arguments — a scene id is not
 * a model's output, and reporting it as an extraction failure would blame the model for a
 * caller's mistake.
 */
export type TextSceneFailureStage = 'input' | 'extract' | 'validate';

export interface TextSceneFailure {
  ok: false;
  stage: TextSceneFailureStage;
  code: TextSceneFailureCode;
  /** Human-readable and safe to return to a caller: names the defect, never the payload. */
  reason: string;
  /**
   * How the reply was spelled, when extraction got far enough to know.
   *
   * Present so an operator can see that, say, every failure in an hour came from
   * `content_part` — a transport bug rather than a model one.
   */
  source?: SceneExtractionSource;
  /** The length of text that was read, when extraction got that far. Never the text itself. */
  extractedLength?: number;
}

export interface TextSceneSuccess {
  ok: true;
  /** The validated scene. The only value here that can be re-rendered later. */
  scene: NormalizedScene;
  /**
   * The final frame's SVG: a complete, standalone document containing every layer.
   *
   * Guaranteed to satisfy `validateSvg` — the tests assert this by running each compiled
   * document back through the engine's own gate, so this is a checked promise rather than a
   * claim in a comment.
   */
  svg: string;
  /**
   * The final frame, as a `ProgressiveFrame`.
   *
   * This is `frames[layers.length]` — the frame that introduced the last layer. It is *not* a
   * frame whose `index` equals the layer count (no such frame exists) and *not* a frame whose
   * `index` equals `layers.length - 1` where the sequence is concerned, since the placeholder
   * occupies `frames[0]`. The type says `ProgressiveFrame` rather than the union so a caller does
   * not have to narrow away the placeholder, which by construction is always `frames[0]`.
   */
  finalFrame: ProgressiveFrame;
  /**
   * Every frame in the sequence, placeholder first, wrapped as transport payloads.
   *
   * Length is `layers + 1`. `frames[0]` is the canvas placeholder (`layerId: null`); the rest are
   * layer frames numbered `0 .. layers - 1`, so `index` is not unique across the sequence — see
   * the module header. `frames[frames.length - 1].svg` is byte-identical to `svg` above, which
   * the tests assert, because a final frame that disagreed with the stream would be a bug
   * nothing else in the pipeline catches.
   */
  frames: ProgressiveFrameEvent[];
  /** Which spelling the scene was found in. */
  source: SceneExtractionSource;
  /** Counts for the scene, so a caller can log size without walking it. */
  statistics: SceneStatistics;
}

export type TextSceneResult = TextSceneSuccess | TextSceneFailure;

/**
 * Compile a chat model's reply into a renderable scene and its frame sequence.
 *
 * @param input The model's reply: a JSON string, a fenced JSON block, or a chat content-part
 *   array. Anything else is refused without throwing.
 * @param sceneId Caller-assigned stream handle. Taken from the caller and *never* from the
 *   payload: a model that produced an unparseable scene must not also be able to make the
 *   stream unaddressable, which is the same rule `normalizeScene` states for its own argument.
 */
export function compileTextScene(input: unknown, sceneId: string): TextSceneResult {
  if (!isUsableSceneId(sceneId)) {
    return {
      ok: false,
      stage: 'input',
      code: 'scene_id_invalid',
      reason:
        'Scene id must be a non-empty string of at most 128 characters. It identifies the ' +
        'stream and is assigned by the caller, never read from the model reply.',
    };
  }

  // Stage 1 — find a candidate object. Bounded before the parser sees anything.
  const extraction = extractSceneCandidate(input);
  if (!extraction.ok) {
    return {
      ok: false,
      stage: 'extract',
      code: extraction.code,
      reason: extraction.reason,
      ...(extraction.source ? { source: extraction.source } : {}),
    };
  }

  // Stage 2 — validate and assemble. `renderSceneFrames` is the composition point, and it is
  // used rather than `normalizeScene` + `assembleFrames` so the validate-then-assemble order
  // cannot be got wrong here: assembling a raw payload does not compile.
  const rendered = renderSceneFrames(extraction.candidate, sceneId);
  if (!rendered.ok) {
    return validationFailure(rendered, extraction.source, extraction.extractedLength);
  }

  const frames = rendered.frames ?? [];
  const last = frames[frames.length - 1];
  if (last === undefined) {
    // Unreachable: an accepted scene has at least one layer, so `renderSceneFrames` always
    // returns frame 0 plus at least one frame. Kept as a totality guard so a future change
    // that let an empty sequence through fails here, loudly and in one place, rather than
    // producing an `undefined` final frame at every call site.
    return {
      ok: false,
      stage: 'validate',
      code: 'scene_no_layers',
      reason: 'Scene validated but produced no frames, which means it had no layers to draw',
      source: extraction.source,
    };
  }

  return {
    ok: true,
    scene: rendered.scene,
    svg: last.svg,
    // Sound because `last` is the highest index, and index 0 is the only frame that can be a
    // `ProgressiveFrameZero` (its `layerId` is `null` and its `index` is the literal `0`).
    finalFrame: last as ProgressiveFrame,
    frames: frames.map((frame) => wrapFrame(rendered.scene, frame)),
    source: extraction.source,
    statistics: sceneStatistics(rendered.scene),
  };
}

/** Shape a validation rejection into the compiler's failure type. */
function validationFailure(
  rejected: Extract<SceneValidation, { ok: false }>,
  source: SceneExtractionSource,
  extractedLength: number,
): TextSceneFailure {
  return {
    ok: false,
    stage: 'validate',
    code: rejected.code,
    reason: rejected.reason,
    source,
    extractedLength,
  };
}

/**
 * Wrap one assembled frame as a transport payload.
 *
 * Thin, and deliberately so: `toFrameEvent` owns the wire shape, and anything added here would
 * be a second definition of it that could drift. This exists as a named function only because
 * the frame union has to be widened at the call site in `compileTextScene`, where the sequence
 * is known to be homogeneous but the array type is not.
 */
function wrapFrame(
  scene: NormalizedScene,
  frame: ProgressiveFrameZero | ProgressiveFrame,
): ProgressiveFrameEvent {
  return toFrameEvent(scene, frame);
}

/**
 * Whether a result is a failure, narrowing for callers that branch.
 *
 * Exported because TypeScript's discriminated union already does this via `result.ok` and a
 * named predicate adds nothing at the type level — but this one also handles the case a caller
 * writes most often and gets subtly wrong: `if (!result.ok && result.stage === 'validate')`.
 * Keeping that as a function means the stage constants live in one place.
 */
export function isValidationFailure(
  result: TextSceneResult,
): result is TextSceneFailure & { stage: 'validate' } {
  return !result.ok && result.stage === 'validate';
}
