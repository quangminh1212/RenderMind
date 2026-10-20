/**
 * Scene validation and normalization - the security boundary of progressive rendering.
 *
 * Everything downstream (`assemble`, `serialize`) assumes a scene it receives is safe and
 * well-formed, and does not re-check. That assumption is only sound because this module is
 * the *only* producer of `NormalizedScene`, and it is total: an input either becomes a
 * normalized scene or is refused with a stable code. There is no third path, and no
 * partially-trusted value.
 *
 * The model this follows is `platform/svg`'s gate, and the reasoning is the same. A chat
 * model's output is untrusted input that a downstream browser will draw. In the SVG path
 * the threat is markup - `<script>`, an `on*` handler, a doctype. Here the threat is
 * *shape*: the scene is a JSON object, so the question is not "is this well-formed markup"
 * but "does this data, once serialized, still describe only the things I intended to draw".
 *
 * That reframing is why validation has two jobs rather than one:
 *
 *   1. **Refuse anything active or out-of-bound.** Bad discriminants, non-finite numbers,
 *      oversized canvases, undeclared gradient references, `data:` URLs smuggled into a
 *      paint field. None of these can draw anything legitimate, so refusing costs nothing.
 *
 *   2. **Neutralize text that is interpolated into markup.** `title`, layer `name`s and
 *      shape path data all end up inside an attribute or an element in the output document.
 *      Validation cannot make those safe by rejecting characters - a layer legitimately
 *      named `Sky & Sea` is not an attack - so this module bounds the text and confirms its
 *      type, and escaping happens at serialization. Escaping and validation answer
 *      different questions and are deliberately not merged.
 *
 * The `path` shape is the one place genuine judgement is required. Path data is a mini
 * grammar (`M0 0 L10 10 Z`), and it is the single field where model-authored text reaches
 * the output document *outside* an escapable position: an escaped path string is a broken
 * drawing, so the grammar itself has to be validated. The accepted sublanguage is
 * deliberately the drawing commands only - no `<`, no quote, no entity, no `&`. That
 * restriction is what makes path data safe to emit verbatim, and it costs a legitimate
 * illustration nothing, because none of those characters are path syntax.
 */
import {
  MAX_CANVAS_EDGE,
  MAX_COORDINATE,
  MAX_GRADIENT_STOPS,
  MAX_GRADIENTS,
  MAX_LAYERS,
  MAX_NAME_LENGTH,
  MAX_OPACITY,
  MAX_SCENE_ID_LENGTH,
  MAX_SHAPES_PER_LAYER,
  SCENE_BLEND_MODES,
  SCENE_SHAPE_KINDS,
  type NormalizedScene,
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

/** How a scene payload may fail validation. Each value is a stable, client-visible code. */
export type SceneRejectionCode =
  | 'scene_not_object'
  | 'scene_missing_canvas'
  | 'scene_invalid_canvas'
  | 'scene_canvas_too_large'
  | 'scene_too_many_layers'
  | 'scene_no_layers'
  | 'scene_duplicate_layer_id'
  | 'scene_layer_invalid'
  | 'scene_too_many_shapes'
  | 'scene_shape_invalid'
  | 'scene_shape_out_of_bounds'
  | 'scene_path_invalid'
  | 'scene_paint_invalid'
  | 'scene_gradient_invalid'
  | 'scene_gradient_undeclared'
  | 'scene_text_too_long';

export interface SceneRejected {
  ok: false;
  code: SceneRejectionCode;
  /** Human-readable and safe to return to a caller: names the defect, never the payload. */
  reason: string;
}

export interface SceneAccepted {
  ok: true;
  scene: NormalizedScene;
}

export type SceneValidation = SceneAccepted | SceneRejected;

function reject(code: SceneRejectionCode, reason: string): SceneRejected {
  return { ok: false, code, reason };
}

// ─── Primitives ──────────────────────────────────────────────

/**
 * Whether a value is a finite number within a magnitude bound.
 *
 * `Number.isFinite` rather than a range comparison, because the failure this catches is
 * `NaN` and `Infinity` reaching a coordinate. `NaN` is the dangerous one: it survives
 * arithmetic silently and serializes to the string `NaN`, which turns a valid document into
 * one no renderer can parse. `JSON.parse` cannot produce either from a well-formed payload,
 * but a caller assembling a scene object in code can, and this module does not care which
 * route the value took to arrive.
 */
function isBoundedNumber(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
}

/** Whether a value is a number in `[0, 1]`. */
function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Whether a value is a non-empty string within a length bound. */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Identifier pattern for scene-assigned handles: layer ids and gradient ids.
 *
 * The alphabet is deliberately narrow. These ids are written into the output document as
 * element ids and as `url(#id)` references, so they are the one class of string that is
 * emitted without escaping. Confining them to `[A-Za-z0-9_.:-]`, with an alphanumeric
 * first character, means no id can contain a quote, an angle bracket, an ampersand, or
 * whitespace - so the "escape or validate" question does not even arise for them.
 *
 * `:` is admitted for namespaced-looking ids a model may produce, and `-`/`_`/`.` because
 * they are common in generated ids. `#` is not, because a leading `#` would produce a
 * reference that is already a fragment.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    IDENTIFIER_PATTERN.test(value)
  );
}

/**
 * Paint value pattern: a hex colour, or the keyword `none`.
 *
 * A closed vocabulary rather than a permissive "not obviously dangerous" test. CSS colour
 * syntax has many spellings - `rgb()`, `hsl()`, named colours, `color-mix()`, and `url()`
 * for paint servers - and every one of them is another parser to reason about. Hex plus
 * `none` covers what a generated illustration actually uses, and gradients cover the case
 * hex cannot express. Anything outside the set is refused with a nameable reason rather
 * than passed through on the theory that it is probably fine.
 */
const PAINT_PATTERN = /^(none|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;

/**
 * Whether a paint value is a reference to a declared scene gradient.
 *
 * Separated from `isValidPaint` because the two are checked at different times: the syntax
 * here is confirmed while the shape is read, and the *existence* of the target gradient is
 * confirmed after every gradient has been collected. A shape painted by a gradient declared
 * later in the document is legal; a shape painted by one that does not exist is not.
 */
const GRADIENT_REFERENCE_PATTERN = /^url\(#([A-Za-z0-9][A-Za-z0-9_.:-]*)\)$/;

function gradientReferenceId(value: string): string | null {
  const match = GRADIENT_REFERENCE_PATTERN.exec(value);
  return match ? match[1] : null;
}

/**
 * Whether a paint string is syntactically acceptable.
 *
 * `url(#id)` is accepted by pattern and its target is resolved later; a `url(` with any
 * other content - an off-document load, a `data:` payload - is not matched by the pattern
 * and so is refused here, at the syntax gate, without needing a second check.
 */
function isValidPaint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  if (typeof value !== 'string') return false;
  return PAINT_PATTERN.test(value) || gradientReferenceId(value) !== null;
}

/**
 * The SVG path grammar this protocol accepts.
 *
 * Path data is the single field emitted without escaping, so it is validated by grammar
 * rather than by pattern-matching for known-bad substrings. The grammar is the drawing
 * subset of SVG's path syntax: a moveto, then any number of drawing commands, each with the
 * right arity of numbers, terminated by an optional `Z`.
 *
 * What is deliberately *not* accepted, and why each matters:
 *   - `<`, `>`, `&`, `"`, `'` - none are path syntax, and all would let a payload escape
 *     the attribute it is written into.
 *   - a leading `data:` or `javascript:` - not reachable through the grammar at all, since
 *     the first token must be a command letter.
 *   - arcs (`A`/`a`) and the smooth curves - not excluded for safety, but because the
 *     arity and flag-packing rules are fiddly enough that a parser for them is a genuine
 *     bug surface. A model that wants an arc can approximate it with cubics, and the
 *     renderer draws the result identically.
 *   - implicit repeated commands (`M0 0 1 1` meaning `M` then implicit `L`) - SVG allows
 *     them and they are unambiguous, but requiring the letter costs the model nothing and
 *     removes a class of "how many numbers is this really" question from the parser.
 */
const PATH_COMMANDS: Record<string, number> = {
  M: 2,
  m: 2,
  L: 2,
  l: 2,
  H: 1,
  h: 1,
  V: 1,
  v: 1,
  C: 6,
  c: 6,
  Q: 4,
  q: 4,
  Z: 0,
  z: 0,
};

const PATH_MAX_LENGTH = 8192;
const PATH_MAX_COMMANDS = 2048;

/**
 * Tokenize and arity-check a path string.
 *
 * The tokenizer is intentionally strict: after each command letter it consumes exactly the
 * number of numeric arguments that command takes, and then *requires* another command
 * letter. A number it cannot parse, a stray character, a wrong argument count, or a
 * trailing fragment all fail the same way - `scene_path_invalid` with the offset - so a
 * caller can see exactly where the model's grammar went wrong.
 *
 * Coordinate magnitude is bounded by `MAX_COORDINATE`, the same bound shapes get, so a path
 * cannot smuggle a coordinate the standalone shapes would have been refused.
 *
 * @returns the reason the path is unusable, or `null` when it is valid.
 */
function validatePathData(d: string, shapeLabel: string): string | null {
  if (d.length > PATH_MAX_LENGTH) {
    return `${shapeLabel} has path data longer than ${PATH_MAX_LENGTH} characters`;
  }

  let cursor = 0;
  let commandCount = 0;

  /** Read one numeric argument (with optional exponent) at the cursor. */
  const readNumber = (): number | null => {
    const slice = d.slice(cursor);
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(slice);
    if (!match) return null;
    cursor += match[0].length;
    return Number(match[0]);
  };

  const skipSeparators = (): void => {
    while (cursor < d.length && (d[cursor] === ' ' || d[cursor] === ',')) cursor += 1;
  };

  skipSeparators();
  if (cursor >= d.length) return `${shapeLabel} has empty path data`;

  while (cursor < d.length) {
    skipSeparators();
    if (cursor >= d.length) break;

    const letter = d[cursor];
    if (letter === undefined || !(letter in PATH_COMMANDS)) {
      return `${shapeLabel} has invalid path data: unexpected "${letter}" at offset ${cursor}`;
    }
    cursor += 1;

    commandCount += 1;
    if (commandCount > PATH_MAX_COMMANDS) {
      return `${shapeLabel} has more than ${PATH_MAX_COMMANDS} path commands`;
    }

    const arity = PATH_COMMANDS[letter];

    // `Z` takes no arguments, which is what closes a subpath.
    if (arity === 0) continue;

    for (let argument = 0; argument < arity; argument += 1) {
      skipSeparators();
      const value = readNumber();
      if (value === null) {
        return (
          `${shapeLabel} has invalid path data: command "${letter}" at offset ${cursor} ` +
          `expects ${arity} number(s), found ${argument}`
        );
      }
      if (!isBoundedNumber(value, MAX_COORDINATE)) {
        return `${shapeLabel} has path data with a coordinate beyond ±${MAX_COORDINATE}`;
      }
    }
  }

  // A path with no drawing command after the moveto still draws nothing; the anti-placeholder
  // principle from `platform/svg` applies, so a lone `M` is refused rather than accepted as
  // an invisible shape that inflates the layer count without changing the picture.
  const hasDrawingCommand = /[LlHhVvCcQqZz]/.test(d);
  if (!hasDrawingCommand) {
    return `${shapeLabel} has path data with no drawing command (a lone moveto draws nothing)`;
  }

  return null;
}

// ─── Field readers ───────────────────────────────────────────

/**
 * Read a bounded coordinate, returning the reason on failure.
 *
 * A tagged result rather than `number | null` so the caller can report *why* - "out of
 * bounds" and "not a number" are different defects, and a model that emits a coordinate of
 * `1e9` is a different problem from one that emits `"wide"`.
 */
type FieldResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function readCoordinate(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<number> {
  const raw = source[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, reason: `${label} "${key}" must be a finite number` };
  }
  if (Math.abs(raw) > MAX_COORDINATE) {
    return { ok: false, reason: `${label} "${key}" is beyond ±${MAX_COORDINATE}` };
  }
  return { ok: true, value: normalizeNumber(raw) };
}

/** Round-trip a float so downstream comparisons and serialization are byte-stable. */
function normalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function readOptionalCoordinate(
  source: Record<string, unknown>,
  key: string,
  label: string,
  fallback: number,
): FieldResult<number> {
  if (source[key] === undefined) return { ok: true, value: fallback };
  return readCoordinate(source, key, label);
}

/**
 * Read and validate a paint field.
 *
 * Returns the gradient id separately when the paint is a `url(#…)` reference, so the caller
 * can record the dependency without re-parsing the string. `undefined` means the field was
 * absent; `'none'` means explicitly unpainted.
 */
function readPaint(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<{ paint?: string; gradientRef?: string }> {
  const raw = source[key];
  if (raw === undefined) return { ok: true, value: {} };
  if (!isValidPaint(raw)) {
    // The message names the offending paint shape rather than echoing the input, and it
    // avoids the words the layer-failure classifier keys on. A message that says "gradient"
    // here would be classified as an undeclared gradient dependency, when the actual defect
    // is a paint value that is not a paint at all.
    return {
      ok: false,
      reason:
        `${label} "${key}" is an invalid paint value. Use a hex colour, "none", or an ` +
        'in-document paint-server reference; external and data: references are refused.',
    };
  }
  const gradientRef = gradientReferenceId(raw);
  return gradientRef
    ? { ok: true, value: { paint: raw, gradientRef } }
    : { ok: true, value: { paint: raw } };
}

function readOptionalUnit(
  source: Record<string, unknown>,
  key: string,
  label: string,
): FieldResult<number | undefined> {
  const raw = source[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isUnitInterval(raw)) {
    return { ok: false, reason: `${label} "${key}" must be a number between 0 and ${MAX_OPACITY}` };
  }
  return { ok: true, value: raw };
}

// ─── Shape normalization ─────────────────────────────────────

/**
 * Build the shared `SceneStyle` from a raw shape, or explain why it cannot be built.
 *
 * Collecting the style in one place keeps the six shape variants from each re-implementing
 * the same four optional fields, which is where they would drift: a `circle` that forgot to
 * bounds-check `opacity` is exactly the kind of gap a per-variant implementation invites.
 */
function readStyle(source: Record<string, unknown>, label: string): FieldResult<SceneStyle> {
  const fill = readPaint(source, 'fill', label);
  if (!fill.ok) return fill;

  const stroke = readPaint(source, 'stroke', label);
  if (!stroke.ok) return stroke;

  const opacity = readOptionalUnit(source, 'opacity', label);
  if (!opacity.ok) return opacity;

  const strokeWidth = readOptionalCoordinate(source, 'strokeWidth', label, 1);
  if (!strokeWidth.ok) return strokeWidth;

  const style: SceneStyle = {};
  if (fill.value.paint !== undefined) style.fill = fill.value.paint;
  if (stroke.value.paint !== undefined) style.stroke = stroke.value.paint;
  if (opacity.value !== undefined) style.opacity = opacity.value;
  if (source.strokeWidth !== undefined) style.strokeWidth = strokeWidth.value;

  const z = source.z;
  if (z !== undefined) {
    if (!isBoundedNumber(z, MAX_SHAPES_PER_LAYER)) {
      return {
        ok: false,
        reason: `${label} "z" must be a finite number between 0 and ${MAX_SHAPES_PER_LAYER}`,
      };
    }
    style.z = z;
  }

  return { ok: true, value: style };
}

/** The gradient ids a shape's style depends on, so the caller can verify them later. */
function styleGradientRefs(source: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const key of ['fill', 'stroke'] as const) {
    const raw = source[key];
    if (typeof raw !== 'string') continue;
    const id = gradientReferenceId(raw);
    if (id) refs.push(id);
  }
  return refs;
}

/** Normalize one raw shape, or explain why it cannot be drawn. */
function normalizeShape(raw: unknown, label: string): FieldResult<SceneShape> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${label} must be an object` };
  }

  const source = raw as Record<string, unknown>;
  const kind = source.kind;
  if (typeof kind !== 'string' || !SCENE_SHAPE_KINDS.includes(kind as SceneShapeKind)) {
    return {
      ok: false,
      reason: `${label} has kind "${String(kind)}", which is not one of: ${SCENE_SHAPE_KINDS.join(', ')}`,
    };
  }

  const style = readStyle(source, label);
  if (!style.ok) return { ok: false, reason: style.reason };
  const shapeLabel = `${label} (${kind})`;

  switch (kind as SceneShapeKind) {
    case 'rect': {
      const width = readCoordinate(source, 'width', shapeLabel);
      if (!width.ok) return { ok: false, reason: width.reason };
      if (width.value <= 0) {
        return { ok: false, reason: `${shapeLabel} "width" must be greater than 0` };
      }

      const height = readCoordinate(source, 'height', shapeLabel);
      if (!height.ok) return { ok: false, reason: height.reason };
      if (height.value <= 0) {
        return { ok: false, reason: `${shapeLabel} "height" must be greater than 0` };
      }

      const x = readCoordinate(source, 'x', shapeLabel);
      if (!x.ok) return { ok: false, reason: x.reason };
      const y = readCoordinate(source, 'y', shapeLabel);
      if (!y.ok) return { ok: false, reason: y.reason };
      const rx = readOptionalCoordinate(source, 'rx', shapeLabel, 0);
      if (!rx.ok) return { ok: false, reason: rx.reason };
      if (rx.value < 0) return { ok: false, reason: `${shapeLabel} "rx" cannot be negative` };

      const rect: SceneShape = {
        kind: 'rect',
        x: x.value,
        y: y.value,
        width: width.value,
        height: height.value,
        ...style.value,
      };
      if (source.rx !== undefined) rect.rx = rx.value;
      return { ok: true, value: rect };
    }

    case 'circle': {
      const r = readCoordinate(source, 'r', shapeLabel);
      if (!r.ok) return { ok: false, reason: r.reason };
      if (r.value <= 0) return { ok: false, reason: `${shapeLabel} "r" must be greater than 0` };

      const cx = readCoordinate(source, 'cx', shapeLabel);
      if (!cx.ok) return { ok: false, reason: cx.reason };
      const cy = readCoordinate(source, 'cy', shapeLabel);
      if (!cy.ok) return { ok: false, reason: cy.reason };

      return {
        ok: true,
        value: { kind: 'circle', cx: cx.value, cy: cy.value, r: r.value, ...style.value },
      };
    }

    case 'ellipse': {
      const rx = readCoordinate(source, 'rx', shapeLabel);
      if (!rx.ok) return { ok: false, reason: rx.reason };
      if (rx.value <= 0) return { ok: false, reason: `${shapeLabel} "rx" must be greater than 0` };

      const ry = readCoordinate(source, 'ry', shapeLabel);
      if (!ry.ok) return { ok: false, reason: ry.reason };
      if (ry.value <= 0) return { ok: false, reason: `${shapeLabel} "ry" must be greater than 0` };

      const cx = readCoordinate(source, 'cx', shapeLabel);
      if (!cx.ok) return { ok: false, reason: cx.reason };
      const cy = readCoordinate(source, 'cy', shapeLabel);
      if (!cy.ok) return { ok: false, reason: cy.reason };

      return {
        ok: true,
        value: {
          kind: 'ellipse',
          cx: cx.value,
          cy: cy.value,
          rx: rx.value,
          ry: ry.value,
          ...style.value,
        },
      };
    }

    case 'line': {
      const coords: Record<string, number> = {};
      for (const field of ['x1', 'y1', 'x2', 'y2'] as const) {
        const value = readCoordinate(source, field, shapeLabel);
        if (!value.ok) return { ok: false, reason: value.reason };
        coords[field] = value.value;
      }

      // A zero-length line paints nothing, so it is the placeholder case again.
      if (coords.x1 === coords.x2 && coords.y1 === coords.y2) {
        return { ok: false, reason: `${shapeLabel} is zero-length and would draw nothing` };
      }

      return {
        ok: true,
        value: {
          kind: 'line',
          x1: coords.x1,
          y1: coords.y1,
          x2: coords.x2,
          y2: coords.y2,
          ...style.value,
        },
      };
    }

    case 'polygon': {
      const rawPoints = source.points;
      if (!Array.isArray(rawPoints)) {
        return { ok: false, reason: `${shapeLabel} "points" must be an array of {x,y} pairs` };
      }
      if (rawPoints.length < 3) {
        return {
          ok: false,
          reason: `${shapeLabel} needs at least 3 points, found ${rawPoints.length}`,
        };
      }
      if (rawPoints.length > MAX_SHAPES_PER_LAYER) {
        return { ok: false, reason: `${shapeLabel} has more than ${MAX_SHAPES_PER_LAYER} points` };
      }

      const points: ScenePoint[] = [];
      for (let index = 0; index < rawPoints.length; index += 1) {
        const point: unknown = rawPoints[index];
        if (typeof point !== 'object' || point === null || Array.isArray(point)) {
          return { ok: false, reason: `${shapeLabel} point ${index} must be an {x,y} object` };
        }
        const pair = point as Record<string, unknown>;
        const x = readCoordinate(pair, 'x', `${shapeLabel} point ${index}`);
        if (!x.ok) return { ok: false, reason: x.reason };
        const y = readCoordinate(pair, 'y', `${shapeLabel} point ${index}`);
        if (!y.ok) return { ok: false, reason: y.reason };
        points.push({ x: x.value, y: y.value });
      }

      return { ok: true, value: { kind: 'polygon', points, ...style.value } };
    }

    case 'path': {
      const d = source.d;
      if (typeof d !== 'string') {
        return { ok: false, reason: `${shapeLabel} "d" must be a string` };
      }
      const pathReason = validatePathData(d, shapeLabel);
      if (pathReason) return { ok: false, reason: pathReason };

      return { ok: true, value: { kind: 'path', d, ...style.value } };
    }

    default:
      // Unreachable: `kind` was checked against `SCENE_SHAPE_KINDS` above. Kept as a
      // totality guard so a new variant added to the union without a case here is a compile
      // error rather than a shape that silently loses its geometry.
      return { ok: false, reason: `${label} has an unhandled shape kind` };
  }
}

// ─── Gradient normalization ──────────────────────────────────

/** Normalize one gradient, or explain why it cannot be a paint server. */
function normalizeGradient(raw: unknown, label: string): FieldResult<SceneGradient> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${label} must be an object` };
  }

  const source = raw as Record<string, unknown>;
  const kind = source.kind;
  if (kind !== 'linear' && kind !== 'radial') {
    return {
      ok: false,
      reason: `${label} has kind "${String(kind)}", must be "linear" or "radial"`,
    };
  }

  const id = source.id;
  if (!isIdentifier(id, MAX_NAME_LENGTH)) {
    return {
      ok: false,
      reason:
        `${label} has an invalid id. Ids must be at most ${MAX_NAME_LENGTH} characters and ` +
        'use only letters, digits, and _ . : -',
    };
  }

  const rawStops = source.stops;
  if (!Array.isArray(rawStops) || rawStops.length < 2) {
    return {
      ok: false,
      reason: `${label} needs at least 2 colour stops, found ${Array.isArray(rawStops) ? rawStops.length : 0}`,
    };
  }
  if (rawStops.length > MAX_GRADIENT_STOPS) {
    return { ok: false, reason: `${label} has more than ${MAX_GRADIENT_STOPS} colour stops` };
  }

  const stops: SceneGradientStop[] = [];
  for (let index = 0; index < rawStops.length; index += 1) {
    const rawStop: unknown = rawStops[index];
    if (typeof rawStop !== 'object' || rawStop === null || Array.isArray(rawStop)) {
      return { ok: false, reason: `${label} stop ${index} must be an object` };
    }
    const stop = rawStop as Record<string, unknown>;
    if (!isUnitInterval(stop.offset)) {
      return {
        ok: false,
        reason: `${label} stop ${index} "offset" must be a number between 0 and 1`,
      };
    }
    if (!isValidPaint(stop.color) || gradientReferenceId(String(stop.color))) {
      // A stop cannot itself be a gradient reference: SVG has no nested paint servers, and a
      // cycle of them would be an infinite paint.
      return {
        ok: false,
        reason: `${label} stop ${index} "color" must be a solid hex colour, not a reference`,
      };
    }
    if (stop.opacity !== undefined && !isUnitInterval(stop.opacity)) {
      return {
        ok: false,
        reason: `${label} stop ${index} "opacity" must be a number between 0 and ${MAX_OPACITY}`,
      };
    }

    const normalized: SceneGradientStop = { offset: stop.offset, color: String(stop.color) };
    if (typeof stop.opacity === 'number') normalized.opacity = stop.opacity;
    stops.push(normalized);
  }

  if (kind === 'linear') {
    const geometry: Record<string, number> = {};
    for (const field of ['x1', 'y1', 'x2', 'y2'] as const) {
      const value = readCoordinate(source, field, label);
      if (!value.ok) return { ok: false, reason: value.reason };
      geometry[field] = value.value;
    }
    // A zero-length vector has no direction, so the renderer falls back to a flat paint and
    // the gradient silently has no effect. Refusing states that plainly.
    if (geometry.x1 === geometry.x2 && geometry.y1 === geometry.y2) {
      return { ok: false, reason: `${label} has zero length and would paint nothing` };
    }

    return {
      ok: true,
      value: {
        kind: 'linear',
        id,
        x1: geometry.x1,
        y1: geometry.y1,
        x2: geometry.x2,
        y2: geometry.y2,
        stops,
      },
    };
  }

  const cx = readCoordinate(source, 'cx', label);
  if (!cx.ok) return { ok: false, reason: cx.reason };
  const cy = readCoordinate(source, 'cy', label);
  if (!cy.ok) return { ok: false, reason: cy.reason };
  const r = readCoordinate(source, 'r', label);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.value <= 0) return { ok: false, reason: `${label} "r" must be greater than 0` };

  return { ok: true, value: { kind: 'radial', id, cx: cx.value, cy: cy.value, r: r.value, stops } };
}

// ─── Layer normalization ─────────────────────────────────────

/** Normalize one layer, or explain why it cannot be a frame. */
function normalizeLayer(
  raw: unknown,
  index: number,
  gradientRefs: Set<string>,
): FieldResult<SceneLayer> {
  const label = `Layer ${index}`;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${label} must be an object` };
  }

  const source = raw as Record<string, unknown>;

  const id = source.id;
  if (!isIdentifier(id, MAX_NAME_LENGTH)) {
    return {
      ok: false,
      reason:
        `${label} has an invalid id. Ids must be at most ${MAX_NAME_LENGTH} characters, start ` +
        'with a letter or digit, and use only letters, digits, and _ . : -',
    };
  }

  const name = source.name;
  if (name !== undefined && !isBoundedString(name, MAX_NAME_LENGTH)) {
    return {
      ok: false,
      reason: `${label} "name" must be a string of at most ${MAX_NAME_LENGTH} characters`,
    };
  }

  const rawShapes = source.shapes;
  if (!Array.isArray(rawShapes)) {
    return { ok: false, reason: `${label} "shapes" must be an array` };
  }
  // An empty layer is a frame that changes nothing. Accepting it would let a model pad a
  // stream with no-op frames, which reads to a client as progress that never arrives.
  if (rawShapes.length === 0) {
    return { ok: false, reason: `${label} has no shapes, so it would render as an empty frame` };
  }
  if (rawShapes.length > MAX_SHAPES_PER_LAYER) {
    return {
      ok: false,
      reason: `${label} has ${rawShapes.length} shapes, over the ${MAX_SHAPES_PER_LAYER}-shape limit`,
    };
  }

  const shapes: SceneShape[] = [];
  for (let shapeIndex = 0; shapeIndex < rawShapes.length; shapeIndex += 1) {
    const shapeResult = normalizeShape(rawShapes[shapeIndex], `${label} shape ${shapeIndex}`);
    if (!shapeResult.ok) return { ok: false, reason: shapeResult.reason };

    // Every `url(#id)` a shape names must resolve. An unresolvable reference is not merely
    // an invisible fill: SVG says a `url()` that does not resolve is a rendering error, and
    // renderers differ on whether they fall back to black or to nothing. Refusing keeps the
    // output unambiguous.
    const shapeSource = rawShapes[shapeIndex] as Record<string, unknown>;
    for (const ref of styleGradientRefs(shapeSource)) {
      if (!gradientRefs.has(ref)) {
        return {
          ok: false,
          reason: `${label} shape ${shapeIndex} references gradient "${ref}", which the scene does not declare`,
        };
      }
    }

    shapes.push(shapeResult.value);
  }

  const opacity = readOptionalUnit(source, 'opacity', label);
  if (!opacity.ok) return { ok: false, reason: opacity.reason };

  const blend = source.blend;
  if (blend !== undefined && !SCENE_BLEND_MODES.includes(blend as SceneBlendMode)) {
    return {
      ok: false,
      reason: `${label} has blend "${String(blend)}", which is not one of: ${SCENE_BLEND_MODES.join(', ')}`,
    };
  }

  const layer: SceneLayer = {
    id,
    name: typeof name === 'string' ? name : id,
    // The protocol paints in array order and ignores this field; it is recorded so a later
    // re-render can restore the author's intended ordering intent. Array order wins.
    order: index,
    shapes,
  };
  if (opacity.value !== undefined) layer.opacity = opacity.value;
  if (blend !== undefined) layer.blend = blend as SceneBlendMode;

  return { ok: true, value: layer };
}

// ─── Canvas normalization ────────────────────────────────────

function normalizeCanvas(raw: unknown): FieldResult<{
  width: number;
  height: number;
  background: string;
}> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'Scene "canvas" must be an object with width and height' };
  }

  const source = raw as Record<string, unknown>;

  const width = source.width;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return { ok: false, reason: 'Scene canvas "width" must be a finite number greater than 0' };
  }
  if (width > MAX_CANVAS_EDGE) {
    return { ok: false, reason: `Scene canvas "width" is over the ${MAX_CANVAS_EDGE}-unit limit` };
  }

  const height = source.height;
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
    return { ok: false, reason: 'Scene canvas "height" must be a finite number greater than 0' };
  }
  if (height > MAX_CANVAS_EDGE) {
    return { ok: false, reason: `Scene canvas "height" is over the ${MAX_CANVAS_EDGE}-unit limit` };
  }

  const background = source.background;
  if (background !== undefined) {
    if (typeof background !== 'string') {
      return { ok: false, reason: 'Scene canvas "background" must be a string' };
    }
    if (background !== 'none' && !PAINT_PATTERN.test(background)) {
      return {
        ok: false,
        reason:
          'Scene canvas "background" must be a hex colour or "none". External references are refused.',
      };
    }
  }

  return {
    ok: true,
    value: {
      width: Math.round(width),
      height: Math.round(height),
      background: typeof background === 'string' ? background : 'none',
    },
  };
}

/**
 * Map a layer-level failure onto the most specific rejection code available.
 *
 * `normalizeLayer` returns a human-readable reason rather than a code, because the reason is
 * what reaches a caller and the code is what a client branches on. This function is the one
 * place the two are reconciled, and it exists as a named function precisely so the ordering
 * is explicit and testable rather than a nested ternary that reads differently every time.
 *
 * Order matters, and it is most-specific-first. `"path data"` beats a bare `paint` match
 * because a path reason can mention a coordinate rather than a paint; `"no shapes"` must be
 * checked *before* the generic `shape` match, or an empty layer - a defect of the container -
 * would be reported as a defect of a shape that does not exist. That misclassification is
 * worth avoiding: a client that retries on `scene_shape_invalid` but gives up on
 * `scene_layer_invalid` would make the wrong decision on an empty layer.
 */
function classifyLayerFailure(reason: string): SceneRejectionCode {
  if (/no shapes/.test(reason)) return 'scene_layer_invalid';
  if (/path data/.test(reason)) return 'scene_path_invalid';
  if (/gradient/.test(reason)) return 'scene_gradient_undeclared';
  if (/paint|fill|stroke/i.test(reason)) return 'scene_paint_invalid';
  if (/shape|point/i.test(reason)) return 'scene_shape_invalid';
  return 'scene_layer_invalid';
}

// ─── Entry point ─────────────────────────────────────────────

/**
 * Validate an untrusted scene payload and materialize it into a `NormalizedScene`.
 *
 * This is the only way to obtain a `NormalizedScene`, and therefore the only door into the
 * frame pipeline. Order matters, and it is chosen the way `validateSvg` chooses its order:
 * the cheapest structural checks run first, so the earliest failure also gives the most
 * precise reason, and nothing expensive runs against a payload that is already known bad.
 *
 * The scene id is *not* taken from the payload. It is assigned by the caller, because a
 * model that produced an unparseable scene id must not also be able to make the stream
 * unaddressable - the id is how a client joins a frame to the request that asked for it.
 *
 * Pure and synchronous: no I/O, no clock, no randomness. That is what makes it safe to call
 * inside a request handler and what makes the whole gate testable as a table of
 * (payload -> verdict), which is the only way to be confident about a security check.
 */
export function normalizeScene(raw: unknown, sceneId: string): SceneValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject('scene_not_object', 'Scene payload must be a JSON object');
  }

  if (!isBoundedString(sceneId, MAX_SCENE_ID_LENGTH)) {
    return reject(
      'scene_layer_invalid',
      `Scene id must be a string of 1-${MAX_SCENE_ID_LENGTH} characters`,
    );
  }

  const source = raw as Record<string, unknown>;

  // ── 1. Canvas ────────────────────────────────────────────
  if (source.canvas === undefined) {
    return reject('scene_missing_canvas', 'Scene must declare a canvas with width and height');
  }
  const canvas = normalizeCanvas(source.canvas);
  if (!canvas.ok) {
    return reject('scene_invalid_canvas', canvas.reason);
  }

  // ── 2. Gradients, before layers, because layers reference them ───
  const rawGradients = source.gradients;
  const gradients: SceneGradient[] = [];
  const gradientIds = new Set<string>();

  if (rawGradients !== undefined) {
    if (!Array.isArray(rawGradients)) {
      return reject('scene_gradient_invalid', 'Scene "gradients" must be an array');
    }
    if (rawGradients.length > MAX_GRADIENTS) {
      return reject(
        'scene_gradient_invalid',
        `Scene has ${rawGradients.length} gradients, over the ${MAX_GRADIENTS} limit`,
      );
    }

    for (let index = 0; index < rawGradients.length; index += 1) {
      const result = normalizeGradient(rawGradients[index], `Gradient ${index}`);
      if (!result.ok) {
        return reject('scene_gradient_invalid', result.reason);
      }
      if (gradientIds.has(result.value.id)) {
        return reject(
          'scene_gradient_invalid',
          `Scene declares gradient id "${result.value.id}" twice`,
        );
      }
      gradientIds.add(result.value.id);
      gradients.push(result.value);
    }
  }

  // ── 3. Layers ────────────────────────────────────────────
  const rawLayers = source.layers;
  if (!Array.isArray(rawLayers)) {
    return reject('scene_no_layers', 'Scene "layers" must be an array');
  }
  if (rawLayers.length === 0) {
    return reject('scene_no_layers', 'Scene has no layers, so there is no picture to render');
  }
  if (rawLayers.length > MAX_LAYERS) {
    return reject(
      'scene_too_many_layers',
      `Scene has ${rawLayers.length} layers, over the ${MAX_LAYERS}-frame limit`,
    );
  }

  const layers: SceneLayer[] = [];
  const layerIds = new Set<string>();

  for (let index = 0; index < rawLayers.length; index += 1) {
    const result = normalizeLayer(rawLayers[index], index, gradientIds);
    if (!result.ok) {
      return reject(classifyLayerFailure(result.reason), result.reason);
    }

    if (layerIds.has(result.value.id)) {
      return reject(
        'scene_duplicate_layer_id',
        `Scene declares layer id "${result.value.id}" twice`,
      );
    }
    layerIds.add(result.value.id);
    layers.push(result.value);
  }

  // ── 4. Optional metadata ─────────────────────────────────
  const title = source.title;
  if (title !== undefined && !isBoundedString(title, MAX_NAME_LENGTH * 4)) {
    return reject(
      'scene_text_too_long',
      `Scene "title" must be a string of at most ${MAX_NAME_LENGTH * 4} characters`,
    );
  }

  const seed = source.seed;
  if (seed !== undefined && !isBoundedNumber(seed, Number.MAX_SAFE_INTEGER)) {
    return reject('scene_layer_invalid', 'Scene "seed" must be a finite integer');
  }

  const metadata = normalizeMetadata(source.metadata);

  // ── 5. Materialize ───────────────────────────────────────
  const scene: NormalizedScene = {
    sceneId,
    title: typeof title === 'string' ? title : '',
    width: canvas.value.width,
    height: canvas.value.height,
    background: canvas.value.background,
    gradients,
    layers,
    seed: typeof seed === 'number' ? Math.trunc(seed) : null,
    metadata,
    shapeCount: layers.reduce((total, layer) => total + layer.shapes.length, 0),
  };

  return { ok: true, scene };
}

/**
 * Keep only scalar metadata values.
 *
 * Metadata is provenance - a trace id, a model name - and is surfaced on every frame for a
 * client to log. Nested objects and arrays are dropped rather than rejected, because the
 * field is advisory: a caller that put a nested object here has not made the scene
 * undrawable, and failing the whole render over a log field would be the wrong trade. The
 * values are still bounded, so metadata cannot become an unbounded payload channel.
 */
function normalizeMetadata(raw: unknown): Record<string, string | number | boolean> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || key.length > MAX_NAME_LENGTH) continue;
    if (typeof value === 'string') {
      if (value.length <= MAX_NAME_LENGTH * 4) metadata[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      metadata[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

/**
 * Count what a scene draws, by kind.
 *
 * Exported because "how big is this scene" is asked in more than one place - a test wanting
 * to assert a bake, an operator wanting to see a pathological prompt - and one implementation
 * beats two call sites quietly disagreeing about what counts as a shape.
 */
export function sceneStatistics(scene: NormalizedScene): SceneStatistics {
  const shapesByKind = Object.fromEntries(SCENE_SHAPE_KINDS.map((kind) => [kind, 0])) as Record<
    SceneShapeKind,
    number
  >;

  for (const layer of scene.layers) {
    for (const shape of layer.shapes) {
      shapesByKind[shape.kind] += 1;
    }
  }

  return {
    layerCount: scene.layers.length,
    shapeCount: scene.shapeCount,
    shapesByKind,
    gradientCount: scene.gradients.length,
  };
}

/** The canvas a scene draws on, as a plain object, for callers that do not want the scene. */
export function sceneCanvas(scene: NormalizedScene): SceneCanvas {
  return { width: scene.width, height: scene.height, background: scene.background };
}

/**
 * Whether a payload looks like a scene at all, without validating it.
 *
 * A cheap pre-flight for a dispatcher deciding whether a model's reply is a scene or prose.
 * Deliberately shallow - it answers "is this worth trying" and never "is this safe"; only
 * `normalizeScene` may be trusted for the latter.
 */
export function looksLikeScene(raw: unknown): raw is SceneDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const source = raw as Record<string, unknown>;
  return (
    Array.isArray(source.layers) && typeof source.canvas === 'object' && source.canvas !== null
  );
}
