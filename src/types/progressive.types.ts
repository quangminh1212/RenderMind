/**
 * Progressive rendering protocol — the declarative scene model.
 *
 * Why this exists: a chat model cannot emit pixels, and asking it to emit a *rendered*
 * document in one shot makes the failure mode unresolvable. A long SVG streamed token by
 * token is either an incomplete document (nothing to draw) or a document that only becomes
 * correct at the very last byte. A client therefore has no honest intermediate state: it
 * either shows nothing or shows something wrong.
 *
 * So the unit of production is not a document, it is a **layer**. Layers arrive one at a
 * time in back-to-front paint order, each one independently complete and independently
 * drawable. Frame N is `layers[0..N]`, which means every intermediate frame a client
 * receives is a real, self-consistent picture with fewer details painted — the classic
 * progressive-render experience — rather than a partly-parsed file.
 *
 * Three design rules carry the whole protocol:
 *
 *   1. **Declarative, never executable.** A scene is data. There is no expression language,
 *      no scripting hook, no way for model-authored text to be evaluated. Everything a
 *      layer can do is a named field with a bounded value. This is what makes it safe to
 *      stream untrusted model output to a browser: the worst a hostile scene can do is
 *      draw something ugly, never run something.
 *
 *   2. **Typed geometry, not markup strings.** A layer carries shapes, not SVG fragments.
 *      If layers carried markup, validation would have to be re-run on every frame (the
 *      assembly is a new document each time), and a layer could close the root element or
 *      open a `<script>`. With typed geometry there is no markup to be well- or ill-formed:
 *      serialization is *total* and structurally incapable of emitting an unsafe document,
 *      because the serializer only ever writes elements it named itself.
 *
 *   3. **Determinism as a correctness property.** Assembly is a pure function of
 *      (scene, frame index). No clock, no randomness, no I/O. Two calls with the same scene
 *      produce byte-identical frames, which is what lets a later worker cache a frame,
 *      replay a stream, or diff two scenes. A `seed` field exists for visual jitter, but it
 *      is *data the scene carries* and is turned into geometry during normalization — it is
 *      never consulted at assembly time. This is the opposite of diffusion, where sampling
 *      noise makes the same seed a request for statistical similarity rather than identity.
 *
 * The security boundary is enforced upstream of this file: `platform/progressive/scene`
 * validates and normalizes raw payloads into a `NormalizedScene`. Everything past that
 * point — sequencing, assembly, serialization — may assume a scene is already safe and
 * well-formed, and does not re-check. That keeps the expensive checks in one testable place
 * instead of spread across the pipeline.
 */

/** SVG media type, and the only format this protocol serializes to. */
export const PROGRESSIVE_MIME = 'image/svg+xml';

/** The root namespace every serialized frame carries. */
export const PROGRESSIVE_SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Protocol version, incremented when the scene shape changes incompatibly.
 *
 * Carried on every frame's metadata so a client that speaks an older version can refuse a
 * stream it would otherwise misread, instead of silently ignoring fields it does not know.
 */
export const PROGRESSIVE_PROTOCOL_VERSION = 1;

// ─── Bounds ──────────────────────────────────────────────────
//
// Every loop and every array in the protocol has an explicit ceiling. A scene is
// model-authored, so "how many" is a number a model chose and a model can choose an
// enormous one; unbounded counts turn a single prompt into an out-of-memory. The bounds are
// generous enough that legitimate artwork never meets them — a hand-composed illustration
// has tens of layers and tens of shapes per layer, not thousands.

/** Maximum layers in one scene, i.e. the maximum number of frames. */
export const MAX_LAYERS = 64;

/** Maximum shapes in one layer. */
export const MAX_SHAPES_PER_LAYER = 256;

/** Maximum gradients in one scene. */
export const MAX_GRADIENTS = 32;

/** Maximum stops in one gradient. */
export const MAX_GRADIENT_STOPS = 16;

/** Maximum coordinate magnitude. Chosen so the largest canvas is expressible. */
export const MAX_COORDINATE = 100_000;

/** Maximum canvas edge, in user units. */
export const MAX_CANVAS_EDGE = 8192;

/** Maximum opacity value. `1` is fully opaque. */
export const MAX_OPACITY = 1;

/** Maximum layer name length, in characters. */
export const MAX_NAME_LENGTH = 64;

/** Maximum scene id length, in characters. */
export const MAX_SCENE_ID_LENGTH = 128;

// ─── Geometry ────────────────────────────────────────────────

/** A 2-D point in user units. */
export interface ScenePoint {
  x: number;
  y: number;
}

/** How a shape's outline is painted. */
export interface SceneStyle {
  /** Solid paint: `#rgb`, `#rrggbb`, or `none` to leave the shape unpainted. */
  fill?: string;
  /** Stroke paint, same spelling rules as `fill`. */
  stroke?: string;
  /** Stroke width in user units. */
  strokeWidth?: number;
  /** Paint opacity, `0`–`1`. `0` makes the shape invisible, which is allowed but wasteful. */
  opacity?: number;
  /** Paint order within the layer. Lower paints first. */
  z?: number;
}

/**
 * One drawable primitive.
 *
 * The `kind` discriminant is the whole safety story in miniature: there are exactly six
 * things a layer can draw, each with a fixed set of numeric fields. There is deliberately
 * no `raw` variant and no free-form attribute bag, because either one would reopen the
 * markup-injection path that typed geometry exists to close.
 */
export type SceneShape =
  | ({
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
    } & SceneStyle)
  | ({ kind: 'circle'; cx: number; cy: number; r: number } & SceneStyle)
  | ({ kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number } & SceneStyle)
  | ({ kind: 'line'; x1: number; y1: number; x2: number; y2: number } & SceneStyle)
  | ({ kind: 'polygon'; points: ScenePoint[] } & SceneStyle)
  | ({ kind: 'path'; d: string } & SceneStyle);

/** The `kind` values a shape may carry. Exported so callers can iterate the repertoire. */
export const SCENE_SHAPE_KINDS = ['rect', 'circle', 'ellipse', 'line', 'polygon', 'path'] as const;

export type SceneShapeKind = (typeof SCENE_SHAPE_KINDS)[number];

/** How a layer's shapes are composited against what is already painted. */
export type SceneBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

export const SCENE_BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay'] as const;

/**
 * A layer — one independently complete step of the picture.
 *
 * `id` is required and unique within a scene because it is the only stable handle a client
 * has for a layer across re-renders: a later scene revision may repaint the layer whose id
 * is `sky`, and a client can key its own state on that. Frame indices shift; ids do not.
 *
 * `name` is a human-readable label and is *untrusted text*. It is escaped on serialization
 * rather than validated against, because a label a model chose should never be able to
 * close an element.
 */
export interface SceneLayer {
  id: string;
  name: string;
  /** Semantics only — the protocol always paints in array order. */
  order: number;
  /** Layer-level opacity, multiplied into each shape's own opacity. */
  opacity?: number;
  blend?: SceneBlendMode;
  shapes: SceneShape[];
}

/** A color stop in a gradient. `offset` is `0`–`1`. */
export interface SceneGradientStop {
  offset: number;
  color: string;
  opacity?: number;
}

/**
 * A paint server available to shapes by `url(#id)`.
 *
 * Gradients are declared out-of-band rather than inline on each shape because a shape's
 * `fill` is then the same short reference whether it is a flat color or a gradient — which
 * keeps the paint semantics identical across a whole scene, and keeps the serializer from
 * having to nest one element inside another's attribute.
 */
export type SceneGradient =
  | {
      kind: 'linear';
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stops: SceneGradientStop[];
    }
  | { kind: 'radial'; id: string; cx: number; cy: number; r: number; stops: SceneGradientStop[] };

/** The scene canvas. Both edges are bounded by `MAX_CANVAS_EDGE`. */
export interface SceneCanvas {
  width: number;
  height: number;
  /** Background fill. `none` (the default) leaves the canvas transparent. */
  background?: string;
}

/**
 * A whole scene: the declarative description a chat model produced, after validation.
 *
 * `sceneId` is assigned by the engine, not the model, so a stream stays addressable even
 * when the model's own output is unusable.
 */
export interface SceneDocument {
  sceneId: string;
  title?: string;
  canvas: SceneCanvas;
  gradients?: SceneGradient[];
  layers: SceneLayer[];
  /**
   * Seed for any deterministic visual jitter.
   *
   * Present so a caller can ask for "the same picture, differently jittered" without
   * re-prompting. It is consumed during normalization, never during assembly — see the
   * module header on why that distinction is what makes frames reproducible.
   */
  seed?: number;
  /** Free-form provenance, surfaced on every frame. Never interpreted. */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * A scene whose every field has been checked and materialized.
 *
 * The opaque brand is the point: it is the type-level half of the security boundary. A
 * function that assembles frames takes a `NormalizedScene`, so a caller cannot pass it the
 * raw model payload plus an assumption that it was validated somewhere upstream. The only
 * way to obtain one is to call `normalizeScene`, and the only way to call it is over an
 * untrusted input that it will either accept or refuse.
 */
export interface NormalizedScene {
  readonly sceneId: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly gradients: readonly SceneGradient[];
  readonly layers: readonly SceneLayer[];
  readonly seed: number | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  /** Total shape count, precomputed so frame assembly does not re-walk the scene. */
  readonly shapeCount: number;
}

// ─── Frames ──────────────────────────────────────────────────

/**
 * One progressive frame: what to show after N layers have arrived.
 *
 * `index` is the frame's position in the sequence and `progress` is `index / (total - 1)`,
 * so `0` is the first hint of structure and `1` is the finished picture. A client can use
 * `progress` directly for a progress bar without knowing how many layers a scene has.
 *
 * `svg` is a complete, standalone document — not a fragment. That is a deliberate
 * redundancy: a client that only ever receives the latest event on a lossy connection can
 * still render it, and a client that has lost the stream can be handed the final frame
 * alone. The cost is bytes; the alternative is a protocol where every frame is only
 * meaningful in the context of all preceding frames.
 */
export interface ProgressiveFrame {
  /** Zero-based position in the sequence. */
  index: number;
  /** Total frames in the sequence, equal to the scene's layer count. */
  total: number;
  /** Completion fraction, `0`–`1`. */
  progress: number;
  /** The layer this frame added. */
  layerId: string;
  /** The layer's display name, escaped-safe (raw text, not markup). */
  layerName: string;
  width: number;
  height: number;
  /** A complete SVG document showing every layer up to and including this frame's. */
  svg: string;
  /** Cumulative shape count drawn so far. */
  shapeCount: number;
  /** Byte length of `svg`, so a client can budget without measuring. */
  byteLength: number;
}

/**
 * Frame 0 as a placeholder: the canvas and background, before any layer exists.
 *
 * Emitted so a client has something to paint immediately and never has to guess a canvas
 * size from the first layer's geometry. It is a real frame — a blank page of the right
 * shape — rather than a synthetic event, because a client should only need one code path.
 */
export interface ProgressiveFrameZero {
  index: 0;
  total: number;
  progress: 0;
  layerId: null;
  layerName: string;
  width: number;
  height: number;
  svg: string;
  shapeCount: 0;
  byteLength: number;
}

/**
 * A frame ready to be written to an SSE or WebSocket transport.
 *
 * This is the integration surface. The renderer produces frames; *something else* decides
 * how they travel. Keeping the wire decision out of this module is what lets the same frame
 * sequence be replayed over SSE, pushed over a WebSocket, or served as a set of URLs
 * without the renderer knowing which of those is happening.
 */
export interface ProgressiveFrameEvent {
  /** SSE `event:` name, or the WebSocket message `type`. Always `frame`. */
  event: 'frame';
  /** Frame sequence number, for the SSE `id:` field so a client can resume. */
  id: string;
  sceneId: string;
  protocolVersion: number;
  index: number;
  total: number;
  progress: number;
  layerId: string | null;
  layerName: string;
  mime: typeof PROGRESSIVE_MIME;
  /** `data:image/svg+xml;base64,…`, so a client can paint the frame with no extra fetch. */
  dataUri: string;
  /** Inline document, for clients that prefer markup to a data URI. */
  svg: string;
  width: number;
  height: number;
  /**
   * Always `false`. Present so the wire format states plainly that this frame is an
   * assembly of authored geometry rather than a sample from a diffusion model — a client
   * must not read a frame's existence as evidence of a generating-image model.
   */
  diffusion: false;
}

/**
 * Aggregated shape statistics, used by tests and by the final frame's provenance.
 *
 * Exported because "how big is this scene" is a question both the engine and an operator
 * ask, and having one answer computed in one place beats two call sites disagreeing.
 */
export interface SceneStatistics {
  layerCount: number;
  shapeCount: number;
  shapesByKind: Readonly<Record<SceneShapeKind, number>>;
  gradientCount: number;
}
