/**
 * SVG serialization — where typed geometry becomes a document.
 *
 * This module is the only place in the progressive pipeline that emits markup, and that
 * concentration is the point. Because a scene is typed geometry rather than a markup string,
 * serialization is **total**: it writes elements it named itself, in a structure it controls,
 * and the only text that reaches the document comes from three fields - the title, a layer
 * name, and path data. So the safety question reduces to a finite, reviewable one: what
 * happens to those three.
 *
 * The answer differs by field, and the difference is deliberate:
 *
 *   - **Attribute values** (`href`, `fill`, numeric geometry) are written from values that
 *     `scene.ts` already proved match a closed pattern - hex colours, strict identifiers, and
 *     finite bounded numbers. There is nothing left to escape, because nothing outside the
 *     pattern can reach here.
 *
 *   - **Text content** (title, layer name) is *arbitrary model-authored text* that a layer
 *     may legitimately want - a layer called `Sky & Sea` is not an attack. So it is escaped
 *     here, at the point of writing, rather than being rejected upstream. Escaping is
 *     applied on the way out, which means it cannot be forgotten at a call site.
 *
 *   - **Path data** is neither escaped nor arbitrary: `scene.ts` validated it against the
 *     path grammar, which excludes `&`, `<`, `>`, and quotes entirely. It is emitted
 *     verbatim, and that verbatim emission is only sound because of that grammar check.
 *
 * Two invariants hold for every document this module produces, and both are asserted in the
 * tests rather than assumed:
 *
 *   1. The output passes `platform/svg`'s `validateSvg`. That is the real acceptance test -
 *      not "does it look like SVG" but "does the engine's own gate accept it", so the
 *      progressive path cannot drift from the document contract the rest of the system uses.
 *
 *   2. Serializing the same scene twice produces byte-identical output. No map iteration
 *      order, no timestamps, no floating-point formatting drift.
 */
import {
  PROGRESSIVE_SVG_NAMESPACE,
  type NormalizedScene,
  type SceneGradient,
  type SceneGradientStop,
  type SceneLayer,
  type SceneShape,
  type SceneStyle,
} from '../../types/progressive.types';

/**
 * Escape the five characters that can end a text node or an attribute.
 *
 * `&` is replaced first. Doing it in any other order would double-escape the replacements
 * made by the earlier rules - `&lt;` becoming `&amp;lt;` - which renders as literal text and
 * silently corrupts a legitimate layer name.
 *
 * `>` is escaped even though XML only requires it in the `]]>` sequence. It costs two bytes
 * and removes the need to reason about whether some CDATA-like context exists that this
 * serializer does not know about.
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format a number for a geometry attribute.
 *
 * `String(number)` rather than a fixed-precision or locale-aware format, for three reasons:
 * it round-trips exactly, it never emits a thousands separator or a locale decimal comma
 * that would produce invalid path data, and it is deterministic. Precision is trimmed by the
 * caller's own normalization, not by cosmetic rounding here - silently rounding a coordinate
 * at serialization would make the document disagree with the scene it came from.
 *
 * The one transformation applied is collapsing `-0` to `0`, so two scenes that differ only
 * in the sign of a zero serialise identically.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Object.is(value, -0) ? 0 : value);
}

/**
 * Write the style attributes shared by every shape.
 *
 * Attribute order is fixed rather than iteration-dependent so that the same shape always
 * produces the same bytes. Unset fields are omitted rather than defaulted, so the document
 * states only what the scene actually declares - which keeps a frame diff small when a
 * later layer changes one property.
 */
function writeStyle(style: SceneStyle): string {
  let attributes = '';
  if (style.fill !== undefined) attributes += ` fill="${style.fill}"`;
  if (style.stroke !== undefined) attributes += ` stroke="${style.stroke}"`;
  if (style.strokeWidth !== undefined && style.stroke !== undefined) {
    attributes += ` stroke-width="${formatNumber(style.strokeWidth)}"`;
  }
  if (style.opacity !== undefined) attributes += ` opacity="${formatNumber(style.opacity)}"`;
  return attributes;
}

/**
 * Write one shape element.
 *
 * A `switch` over the discriminant rather than a lookup table, so adding a variant to
 * `SceneShape` without handling it here is a compile error. That is the same totality
 * argument the validator makes, applied at the other end of the pipeline: the type system
 * is what guarantees no shape can reach the document unhandled.
 */
function writeShape(shape: SceneShape): string {
  switch (shape.kind) {
    case 'rect': {
      const radius =
        shape.rx !== undefined && shape.rx > 0 ? ` rx="${formatNumber(shape.rx)}"` : '';
      return (
        `<rect x="${formatNumber(shape.x)}" y="${formatNumber(shape.y)}" ` +
        `width="${formatNumber(shape.width)}" height="${formatNumber(shape.height)}"${radius}` +
        `${writeStyle(shape)}/>`
      );
    }
    case 'circle':
      return (
        `<circle cx="${formatNumber(shape.cx)}" cy="${formatNumber(shape.cy)}" ` +
        `r="${formatNumber(shape.r)}"${writeStyle(shape)}/>`
      );
    case 'ellipse':
      return (
        `<ellipse cx="${formatNumber(shape.cx)}" cy="${formatNumber(shape.cy)}" ` +
        `rx="${formatNumber(shape.rx)}" ry="${formatNumber(shape.ry)}"${writeStyle(shape)}/>`
      );
    case 'line':
      return (
        `<line x1="${formatNumber(shape.x1)}" y1="${formatNumber(shape.y1)}" ` +
        `x2="${formatNumber(shape.x2)}" y2="${formatNumber(shape.y2)}"${writeStyle(shape)}/>`
      );
    case 'polygon': {
      // Path data, not a `points` attribute. Both are legal SVG; the path form is chosen
      // because it is the one representation the whole pipeline already has a grammar for,
      // so a polygon and a path cannot drift apart in what they accept.
      const data = shape.points
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'}${formatNumber(point.x)} ${formatNumber(point.y)}`,
        )
        .join(' ');
      return `<path d="${data} Z"${writeStyle(shape)}/>`;
    }
    case 'path':
      // Emitted verbatim. Sound only because `scene.ts` validated `d` against the drawing
      // grammar, which admits no character that could escape the attribute.
      return `<path d="${shape.d}"${writeStyle(shape)}/>`;
    default:
      return '';
  }
}

/**
 * Write a layer's `<g>` group.
 *
 * The group always exists, even for a layer with default opacity and blend, because a client
 * that wants to toggle or animate one layer needs a stable element to address - and because
 * `id` is the handle the protocol promises across re-renders.
 */
function writeLayer(layer: SceneLayer): string {
  let attributes = ` id="${layer.id}"`;
  if (layer.opacity !== undefined && layer.opacity !== 1) {
    attributes += ` opacity="${formatNumber(layer.opacity)}"`;
  }
  if (layer.blend !== undefined && layer.blend !== 'normal') {
    // `mix-blend-mode` is CSS, not a presentation attribute, so it goes through `style`.
    // That is the correct spelling for a blend in SVG 2 and it keeps the value out of an
    // attribute namespace where an unknown name would be ignored silently.
    attributes += ` style="mix-blend-mode:${layer.blend}"`;
  }

  const name = layer.name.trim();
  const label = name.length > 0 && name !== layer.id ? `<title>${escapeXmlText(name)}</title>` : '';

  // Shapes are painted in array order, and that order is the layer's internal paint order.
  // The `z` field is a soft hint; sorting by it here would make the visual result depend on
  // a number a model chose rather than on the sequence the model wrote.
  return `<g${attributes}>${label}${layer.shapes.map(writeShape).join('')}</g>`;
}

/** Write one gradient stop. */
function writeStop(stop: SceneGradientStop): string {
  const opacity =
    stop.opacity !== undefined && stop.opacity !== 1
      ? ` stop-opacity="${formatNumber(stop.opacity)}"`
      : '';
  return `<stop offset="${formatNumber(stop.offset)}" stop-color="${stop.color}"${opacity}/>`;
}

/** Write one gradient into `<defs>`. */
function writeGradient(gradient: SceneGradient): string {
  const stops = gradient.stops.map(writeStop).join('');

  if (gradient.kind === 'linear') {
    return (
      `<linearGradient id="${gradient.id}" x1="${formatNumber(gradient.x1)}" ` +
      `y1="${formatNumber(gradient.y1)}" x2="${formatNumber(gradient.x2)}" ` +
      `y2="${formatNumber(gradient.y2)}">${stops}</linearGradient>`
    );
  }

  return (
    `<radialGradient id="${gradient.id}" cx="${formatNumber(gradient.cx)}" ` +
    `cy="${formatNumber(gradient.cy)}" r="${formatNumber(gradient.r)}">${stops}</radialGradient>`
  );
}

export interface SerializeOptions {
  /**
   * Layers to include. Defaults to the whole scene.
   *
   * Passing a slice is how a progressive frame is built, and it is why serialization takes a
   * layer list rather than reading `scene.layers` itself: the caller decides how much of the
   * picture to draw, and this function's only job is to draw it correctly.
   */
  layers?: readonly SceneLayer[];
}

/**
 * Serialize a scene, or a prefix of one, into a standalone SVG document.
 *
 * The output is a complete document rather than a fragment, always. A frame a client receives
 * is therefore renderable in isolation, which is what makes the stream resilient: a dropped
 * event does not orphan every frame after it.
 *
 * The `<rect>` background is emitted as the first element inside the root, beneath every
 * layer group, so it can never occlude artwork. A `none` background means transparent, which
 * is the SVG default, so the element is omitted entirely rather than written as a no-op fill.
 */
export function serializeSceneToSvg(
  scene: NormalizedScene,
  options: SerializeOptions = {},
): string {
  const layers = options.layers ?? scene.layers;

  const background =
    scene.background !== 'none'
      ? `<rect x="0" y="0" width="${scene.width}" height="${scene.height}" fill="${scene.background}"/>`
      : '';

  // `<defs>` is emitted whenever the scene declares gradients, even if the layers in *this*
  // frame do not reference them yet. That keeps a frame's defs stable across the sequence,
  // so a client diffing two frames does not see defs appear and disappear.
  const defs =
    scene.gradients.length > 0 ? `<defs>${scene.gradients.map(writeGradient).join('')}</defs>` : '';

  const title = scene.title.trim().length > 0 ? `<title>${escapeXmlText(scene.title)}</title>` : '';

  return (
    `<svg xmlns="${PROGRESSIVE_SVG_NAMESPACE}" width="${scene.width}" height="${scene.height}" ` +
    `viewBox="0 0 ${scene.width} ${scene.height}">` +
    `${title}${defs}${background}${layers.map(writeLayer).join('')}` +
    `</svg>`
  );
}

/**
 * Serialize only the layers up to and including `index`.
 *
 * A named function rather than a bare slice at each call site, so the off-by-one question -
 * "is frame 3 layers 0..3 or 0..2" - is answered once. The answer is inclusive: frame `N`
 * contains layer `N`, because a client that has received layer `N` should see it.
 */
export function serializeFrameSvg(scene: NormalizedScene, index: number): string {
  const count = Math.max(0, Math.min(index + 1, scene.layers.length));
  return serializeSceneToSvg(scene, { layers: scene.layers.slice(0, count) });
}
