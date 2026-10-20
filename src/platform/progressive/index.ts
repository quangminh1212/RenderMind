/**
 * Progressive rendering — public surface.
 *
 * The pipeline has four stages, and each one is a separate file because each one answers a
 * different question:
 *
 *   1. `scene`     — is this untrusted payload a scene, and is it safe to draw?
 *   2. `serialize` — how does typed geometry become a document?
 *   3. `frames`    — what does the sequence look like, and how is it wrapped for a transport?
 *   4. `index`     — this file, which only re-exports.
 *
 * A consumer should normally need nothing but `renderSceneFrames` and the types: validate,
 * assemble and wrap in one call. The individual stages are exported because a caller that
 * wants to assemble lazily - one frame per request, which is how an SSE handler will actually
 * want to work - needs `normalizeScene` once and `buildFrame` in a loop, without re-validating
 * per frame.
 *
 * Nothing here rasterizes, and nothing here talks to a network. Rasterizing a finished frame
 * is `platform/svg`'s job, and delivering a stream is the transport's.
 */
export {
  normalizeScene,
  sceneStatistics,
  sceneCanvas,
  looksLikeScene,
  type SceneRejectionCode,
  type SceneRejected,
  type SceneAccepted,
  type SceneValidation,
} from './scene';

export {
  serializeSceneToSvg,
  serializeFrameSvg,
  escapeXmlText,
  type SerializeOptions,
} from './serialize';

export {
  FRAME_EVENT_NAME,
  assembleFrames,
  buildFrame,
  buildFrameZero,
  renderSceneFrames,
  toFrameEvent,
} from './frames';

export {
  MAX_CANVAS_EDGE,
  MAX_COORDINATE,
  MAX_GRADIENT_STOPS,
  MAX_GRADIENTS,
  MAX_LAYERS,
  MAX_NAME_LENGTH,
  MAX_OPACITY,
  MAX_SCENE_ID_LENGTH,
  MAX_SHAPES_PER_LAYER,
  PROGRESSIVE_MIME,
  PROGRESSIVE_PROTOCOL_VERSION,
  PROGRESSIVE_SVG_NAMESPACE,
  SCENE_BLEND_MODES,
  SCENE_SHAPE_KINDS,
  type NormalizedScene,
  type ProgressiveFrame,
  type ProgressiveFrameEvent,
  type ProgressiveFrameZero,
  type SceneBlendMode,
  type SceneCanvas,
  type SceneDocument,
  type SceneGradient,
  type SceneGradientStop,
  type SceneLayer,
  type ScenePoint,
  type SceneShape,
  type SceneShapeKind,
  type SceneStatistics,
  type SceneStyle,
} from '../../types/progressive.types';
