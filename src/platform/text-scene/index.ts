/**
 * Text-scene compilation — public surface.
 *
 * Two files, each answering one question:
 *
 *   1. `extract` — is there a JSON object in this model reply, and what shape was the reply?
 *   2. `compile` — this module's namesake: run the object through the scene gate and assemble
 *      the frame sequence, or refuse it with a stable reason.
 *
 * The split is a trust boundary, not a filing convention. `extractSceneCandidate` is the only
 * thing here that touches the raw reply, and it is total but *not* trusting: its output type is
 * `Record<string, unknown>`, which does not compile as an argument to `serializeSceneToSvg` or
 * `assembleFrames`. The only way from a reply to a frame is `compileTextScene`, which cannot
 * skip `normalizeScene` — the same brand-based argument `types/progressive.types.ts` makes for
 * `NormalizedScene`, applied one stage further out.
 *
 * A caller who wants the intermediate stages individually — to log what was extracted before
 * deciding to draw it, or to test extraction as a table — imports `extract` directly. A caller
 * who wants a picture imports `compileTextScene` and nothing else.
 *
 * Nothing here rasterizes and nothing here talks to a network.
 */
export {
  extractSceneCandidate,
  isUsableSceneId,
  MAX_SCENE_TEXT_LENGTH,
  type SceneExtraction,
  type SceneExtractionCode,
  type SceneExtractionFailure,
  type SceneExtractionSource,
  type SceneExtractionSuccess,
} from './extract';

export {
  compileTextScene,
  isValidationFailure,
  type TextSceneFailure,
  type TextSceneFailureCode,
  type TextSceneFailureStage,
  type TextSceneResult,
  type TextSceneSuccess,
} from './compile';
