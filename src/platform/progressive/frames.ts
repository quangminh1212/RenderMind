/**
 * Frame assembly — turning a scene into a progressive sequence.
 *
 * A scene of N layers becomes N+1 frames: frame 0 is the bare canvas, and frame N is the
 * finished picture. The extra leading frame exists so a client never has to infer a canvas
 * size from the geometry of the first layer that happens to arrive - it is told the shape of
 * the page before anything is painted on it, which is what lets it reserve layout immediately
 * instead of reflowing when the first layer lands.
 *
 * Frame assembly is a pure function of (scene, index): no clock, no randomness, no I/O, and
 * no accumulator carried between frames. That last point is the one worth stating, because
 * the obvious implementation - hold a frame and append the next layer to it - would be
 * cheaper and wrong. Rebuilding each frame from the scene prefix means frame K is derived
 * from the same inputs every time, so a frame can be recomputed, cached, or replayed out of
 * order without any hidden state having to be replayed with it.
 *
 * The cost of that choice is that assembly is O(N^2) in layers rather than O(N). For the
 * layer counts this protocol allows that is nothing - 64 layers of a few hundred bytes is
 * tens of kilobytes of redundant string building - and it buys the guarantee that a stream is
 * a *function*, not a session.
 */
import { normalizeScene, type SceneValidation } from './scene';
import { serializeFrameSvg, serializeSceneToSvg } from './serialize';
import {
  PROGRESSIVE_MIME,
  PROGRESSIVE_PROTOCOL_VERSION,
  type NormalizedScene,
  type ProgressiveFrame,
  type ProgressiveFrameEvent,
  type ProgressiveFrameZero,
} from '../../types/progressive.types';

/** The event name every frame carries. A constant so a client matches on one value. */
export const FRAME_EVENT_NAME = 'frame';

/**
 * Build the canvas-only placeholder frame.
 *
 * `layerId` is `null` rather than an empty string so a client can distinguish "this frame
 * introduced no layer" from "this frame introduced a layer whose id is empty", and the id
 * pattern in `scene.ts` makes the latter impossible anyway.
 */
export function buildFrameZero(scene: NormalizedScene): ProgressiveFrameZero {
  const svg = serializeSceneToSvg(scene, { layers: [] });
  return {
    index: 0,
    total: scene.layers.length,
    progress: 0,
    layerId: null,
    layerName: 'canvas',
    width: scene.width,
    height: scene.height,
    svg,
    shapeCount: 0,
    byteLength: Buffer.byteLength(svg, 'utf8'),
  };
}

/**
 * Build every frame of a scene, in order.
 *
 * Returns frames `1..N`; `buildFrame` at index 0 produces the placeholder, which is kept
 * separate so its type can say `layerId: null` and `shapeCount: 0` rather than widening the
 * `ProgressiveFrame` type to admit a state that only ever occurs once.
 */
export function assembleFrames(scene: NormalizedScene): ProgressiveFrame[] {
  const frames: ProgressiveFrame[] = [];
  for (let index = 0; index < scene.layers.length; index += 1) {
    frames.push(buildFrame(scene, index));
  }
  return frames;
}

/**
 * Build the frame that adds layer `index`.
 *
 * Throws on an out-of-range index rather than clamping. Clamping would turn a caller's
 * arithmetic error into a silently-repeated final frame, and a stream that emits the same
 * picture twice looks to a client like a stall rather than a bug.
 */
export function buildFrame(scene: NormalizedScene, index: number): ProgressiveFrame {
  if (!Number.isInteger(index) || index < 0 || index >= scene.layers.length) {
    throw new RangeError(
      `Frame index ${index} is out of range for a scene with ${scene.layers.length} layer(s)`,
    );
  }

  const layer = scene.layers[index];
  const layers = scene.layers.slice(0, index + 1);
  const svg = serializeFrameSvg(scene, index);

  const shapeCount = layers.reduce((total, item) => total + item.shapes.length, 0);

  return {
    index,
    total: scene.layers.length,
    // Guards against a divide-by-zero for a one-layer scene: with a single layer, frame 1 is
    // the finished picture and reports 1, not 1/0.
    progress: scene.layers.length <= 1 ? 1 : index / (scene.layers.length - 1),
    layerId: layer.id,
    layerName: layer.name,
    width: scene.width,
    height: scene.height,
    svg,
    shapeCount,
    byteLength: Buffer.byteLength(svg, 'utf8'),
  };
}

/**
 * Wrap a frame as a transport payload.
 *
 * `dataUri` is included alongside the inline `svg` because the two suit different clients
 * and both are already in memory - the base64 costs one encode of bytes we had to build
 * anyway, and it saves a client from having to escape or blob-wrap markup in order to put it
 * in an `<img>`. A client that wants to keep the document for later editing uses `svg`.
 */
export function toFrameEvent(
  scene: NormalizedScene,
  frame: ProgressiveFrame | ProgressiveFrameZero,
): ProgressiveFrameEvent {
  return {
    event: FRAME_EVENT_NAME,
    id: `${scene.sceneId}:${frame.index}`,
    sceneId: scene.sceneId,
    protocolVersion: PROGRESSIVE_PROTOCOL_VERSION,
    index: frame.index,
    total: frame.total,
    progress: frame.progress,
    layerId: frame.layerId,
    layerName: frame.layerName,
    mime: PROGRESSIVE_MIME,
    dataUri: `data:${PROGRESSIVE_MIME};base64,${Buffer.from(frame.svg, 'utf8').toString('base64')}`,
    svg: frame.svg,
    width: frame.width,
    height: frame.height,
    diffusion: false,
  };
}

/**
 * Render an untrusted payload all the way to a frame sequence.
 *
 * The convenience path, and the one an HTTP handler should use: validate, assemble, wrap. It
 * exists so the three stages cannot be composed in the wrong order at a call site - calling
 * `assembleFrames` on a raw payload would not compile, because it takes a `NormalizedScene`.
 *
 * Frame 0 is included, so the returned array is a complete stream rather than a stream with
 * an implied head.
 */
export function renderSceneFrames(
  raw: unknown,
  sceneId: string,
): SceneValidation & { frames?: Array<ProgressiveFrameZero | ProgressiveFrame> } {
  const validation = normalizeScene(raw, sceneId);
  if (!validation.ok) return validation;
  return {
    ok: true,
    scene: validation.scene,
    frames: [buildFrameZero(validation.scene), ...assembleFrames(validation.scene)],
  };
}
