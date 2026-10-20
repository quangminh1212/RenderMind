import { describe, it, expect } from 'vitest';
import {
  escapeXmlText,
  serializeFrameSvg,
  serializeSceneToSvg,
} from '../../../../src/platform/progressive/serialize';
import { normalizeScene } from '../../../../src/platform/progressive/scene';
import {
  MAX_SVG_BYTES,
  SVG_MIME,
  rasterizeSvgToPng,
  sniffImageMime,
  validateSvg,
} from '../../../../src/platform/svg';
import type { NormalizedScene } from '../../../../src/types/progressive.types';

/**
 * Serializer tests.
 *
 * The acceptance criterion for this module is not "does the output look like SVG" but **does
 * `platform/svg`'s own gate accept it**. That is the load-bearing test, because the
 * progressive path must not be able to produce a document the rest of the engine would have
 * refused. Several cases below route a serialized frame straight into `validateSvg` for that
 * reason, and one deliberately goes as far as `rasterizeSvgToPng` to prove the document is
 * something a real renderer can draw.
 *
 * The other half is determinism. Frame assembly is a pure function of (scene, index), and the
 * only way that claim stays true is if it is asserted - a `Date` or a map iteration snuck into
 * a format string would break byte-stability without breaking any render.
 */

/** Normalize a fixture, failing loudly rather than returning a possibly-bad scene. */
function sceneOf(payload: unknown, sceneId = 'scene_test'): NormalizedScene {
  const verdict = normalizeScene(payload, sceneId);
  if (!verdict.ok)
    throw new Error(`fixture should be valid, got ${verdict.code}: ${verdict.reason}`);
  return verdict.scene;
}

const HOUSE = {
  title: 'A house',
  canvas: { width: 320, height: 200, background: '#eef2f7' },
  layers: [
    {
      id: 'sky',
      name: 'Sky',
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 320, height: 120, fill: '#87ceeb' }],
    },
    {
      id: 'house',
      name: 'House',
      shapes: [{ kind: 'rect', x: 100, y: 90, width: 120, height: 80, fill: '#8b5a2b' }],
    },
  ],
};

describe('serializeSceneToSvg — the document is accepted by the engine gate', () => {
  it('produces a document validateSvg accepts', () => {
    const verdict = validateSvg(serializeSceneToSvg(sceneOf(HOUSE)));
    expect(verdict.ok).toBe(true);
  });

  it('produces a document whose bytes sniff as SVG', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE));
    expect(sniffImageMime(Buffer.from(svg, 'utf8'))).toBe(SVG_MIME);
  });

  it('produces a document a real renderer can rasterize', () => {
    // The end-to-end proof: the serializer's output is not merely well-formed, it draws.
    const png = rasterizeSvgToPng(serializeSceneToSvg(sceneOf(HOUSE)), { width: 64 });
    expect(png.png.byteLength).toBeGreaterThan(0);
    expect(png.width).toBe(64);
  });

  it('stays under the engine-wide SVG byte ceiling', () => {
    const scene = sceneOf({
      canvas: { width: 100, height: 100 },
      layers: Array.from({ length: 8 }, (_, layer) => ({
        id: `l${layer}`,
        shapes: Array.from({ length: 32 }, () => ({
          kind: 'circle',
          cx: 50,
          cy: 50,
          r: 20,
          fill: '#123456',
        })),
      })),
    });
    expect(Buffer.byteLength(serializeSceneToSvg(scene), 'utf8')).toBeLessThan(MAX_SVG_BYTES);
  });

  it('declares the namespace the gate requires', () => {
    expect(serializeSceneToSvg(sceneOf(HOUSE))).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('declares width, height and a matching viewBox', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE));
    expect(svg).toContain('width="320"');
    expect(svg).toContain('height="200"');
    expect(svg).toContain('viewBox="0 0 320 200"');
  });

  it('emits exactly one root element', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE));
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});

describe('serializeSceneToSvg — layers and paint order', () => {
  it('paints layers in array order, so a later layer covers an earlier one', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE));
    expect(svg.indexOf('id="sky"')).toBeLessThan(svg.indexOf('id="house"'));
  });

  it('emits the background beneath every layer so it cannot occlude artwork', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE));
    expect(svg.indexOf('#eef2f7')).toBeLessThan(svg.indexOf('id="sky"'));
  });

  it('omits the background element when the canvas is transparent', () => {
    const scene = sceneOf({
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 5, cy: 5, r: 2, fill: '#000' }] }],
    });
    // The default fill of a shape is black; asserting on the *background* rect specifically
    // is what keeps this test from passing on a shape's own fill.
    expect(serializeSceneToSvg(scene)).not.toContain(
      '<rect x="0" y="0" width="10" height="10" fill="none"',
    );
  });

  it('wraps each layer in an addressable group carrying its id', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE));
    expect(svg).toContain('<g id="sky">');
    expect(svg).toContain('<g id="house">');
  });

  it('emits layer opacity only when it is not fully opaque', () => {
    const scene = sceneOf({
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'opaque',
          opacity: 1,
          shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }],
        },
        {
          id: 'faded',
          opacity: 0.25,
          shapes: [{ kind: 'circle', cx: 2, cy: 2, r: 1, fill: '#000' }],
        },
      ],
    });
    const svg = serializeSceneToSvg(scene);
    expect(svg).toContain('<g id="opaque">');
    expect(svg).toContain('opacity="0.25"');
  });

  it('emits a blend mode through style, which is where SVG 2 spells it', () => {
    const scene = sceneOf({
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'b',
          blend: 'multiply',
          shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }],
        },
      ],
    });
    expect(serializeSceneToSvg(scene)).toContain('style="mix-blend-mode:multiply"');
  });

  it('emits a layer name as an escaped title element', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE));
    expect(svg).toContain('<title>Sky</title>');
  });

  it('omits the layer title when it is just the id, which would be noise', () => {
    const scene = sceneOf({
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'only', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }] }],
    });
    expect(serializeSceneToSvg(scene)).not.toContain('<title>only</title>');
  });
});

describe('serializeSceneToSvg — shape geometry', () => {
  const one = (shape: Record<string, unknown>) =>
    serializeSceneToSvg(
      sceneOf({ canvas: { width: 100, height: 100 }, layers: [{ id: 'a', shapes: [shape] }] }),
    );

  it('writes a rect', () => {
    expect(one({ kind: 'rect', x: 1, y: 2, width: 3, height: 4 })).toContain(
      '<rect x="1" y="2" width="3" height="4"/>',
    );
  });

  it('writes a rounded rect', () => {
    expect(one({ kind: 'rect', x: 0, y: 0, width: 3, height: 4, rx: 2 })).toContain('rx="2"');
  });

  it('writes a circle', () => {
    expect(one({ kind: 'circle', cx: 5, cy: 6, r: 7 })).toContain('<circle cx="5" cy="6" r="7"/>');
  });

  it('writes an ellipse', () => {
    expect(one({ kind: 'ellipse', cx: 5, cy: 6, rx: 7, ry: 8 })).toContain(
      '<ellipse cx="5" cy="6" rx="7" ry="8"/>',
    );
  });

  it('writes a line', () => {
    expect(one({ kind: 'line', x1: 1, y1: 2, x2: 3, y2: 4 })).toContain(
      '<line x1="1" y1="2" x2="3" y2="4"/>',
    );
  });

  it('writes a polygon as a closed path, which is the form the pipeline has a grammar for', () => {
    const svg = one({
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 8 },
      ],
    });
    expect(svg).toContain('d="M0 0 L10 0 L5 8 Z"');
  });

  it('writes a path verbatim, which is sound because the grammar admits no escapable character', () => {
    expect(one({ kind: 'path', d: 'M0 0 L10 10 Z' })).toContain('d="M0 0 L10 10 Z"');
  });

  it('writes fill, stroke, stroke-width and opacity', () => {
    const svg = one({
      kind: 'rect',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      fill: '#abc',
      stroke: '#123456',
      strokeWidth: 3,
      opacity: 0.5,
    });
    expect(svg).toContain('fill="#abc"');
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('opacity="0.5"');
  });

  it('omits stroke-width when there is no stroke, since it would be inert', () => {
    const svg = one({ kind: 'rect', x: 0, y: 0, width: 1, height: 1, strokeWidth: 3 });
    expect(svg).not.toContain('stroke-width');
  });

  it('collapses negative zero so two scenes differing only in zero sign serialize identically', () => {
    expect(one({ kind: 'circle', cx: -0, cy: -0, r: 1 })).toContain('cx="0" cy="0"');
  });

  it('omits unset style fields rather than defaulting them', () => {
    expect(one({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 })).toContain(
      '<rect x="0" y="0" width="1" height="1"/>',
    );
  });
});

describe('serializeSceneToSvg — gradients', () => {
  const withGradient = (gradient: Record<string, unknown>) =>
    sceneOf({
      canvas: { width: 100, height: 100 },
      gradients: [gradient],
      layers: [
        {
          id: 'a',
          shapes: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 100, fill: 'url(#g)' }],
        },
      ],
    });

  it('writes a linear gradient into defs', () => {
    const svg = serializeSceneToSvg(
      withGradient({
        kind: 'linear',
        id: 'g',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        stops: [
          { offset: 0, color: '#000' },
          { offset: 1, color: '#fff' },
        ],
      }),
    );
    expect(svg).toContain('<defs>');
    expect(svg).toContain('<linearGradient id="g" x1="0" y1="0" x2="100" y2="0">');
    expect(svg).toContain('<stop offset="0" stop-color="#000"/>');
  });

  it('writes a radial gradient', () => {
    const svg = serializeSceneToSvg(
      withGradient({
        kind: 'radial',
        id: 'g',
        cx: 50,
        cy: 50,
        r: 40,
        stops: [
          { offset: 0, color: '#fff' },
          { offset: 1, color: '#000' },
        ],
      }),
    );
    expect(svg).toContain('<radialGradient id="g" cx="50" cy="50" r="40">');
  });

  it('writes a stop opacity only when it is not fully opaque', () => {
    const svg = serializeSceneToSvg(
      withGradient({
        kind: 'linear',
        id: 'g',
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 0,
        stops: [
          { offset: 0, color: '#000', opacity: 0.5 },
          { offset: 1, color: '#fff', opacity: 1 },
        ],
      }),
    );
    expect(svg).toContain('stop-opacity="0.5"');
    expect(svg.match(/stop-opacity/g)).toHaveLength(1);
  });

  it('emits defs before the layers that reference them', () => {
    const svg = serializeSceneToSvg(
      withGradient({
        kind: 'linear',
        id: 'g',
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 0,
        stops: [
          { offset: 0, color: '#000' },
          { offset: 1, color: '#fff' },
        ],
      }),
    );
    expect(svg.indexOf('<defs>')).toBeLessThan(svg.indexOf('<g id="a">'));
  });

  it('produces a gradient document the engine gate accepts', () => {
    const svg = serializeSceneToSvg(
      withGradient({
        kind: 'linear',
        id: 'g',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 100,
        stops: [
          { offset: 0, color: '#ff0000', opacity: 0.5 },
          { offset: 1, color: '#0000ff' },
        ],
      }),
    );
    expect(validateSvg(svg).ok).toBe(true);
  });

  it('emits no defs when the scene declares no gradients', () => {
    expect(serializeSceneToSvg(sceneOf(HOUSE))).not.toContain('<defs>');
  });
});

describe('escapeXmlText', () => {
  it('escapes the five characters that can end a node or an attribute', () => {
    expect(escapeXmlText(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('escapes ampersand first, so it does not double-escape its own replacements', () => {
    // The failure this guards: `&lt;` becoming `&amp;lt;`, which renders as literal text.
    expect(escapeXmlText('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text untouched, so a legitimate name is not mangled', () => {
    expect(escapeXmlText('A red house')).toBe('A red house');
  });
});

describe('serializeSceneToSvg — model-authored text is neutralized, not trusted', () => {
  /**
   * The threat this block pins: a layer name or title is model-authored text that reaches the
   * document. Validation cannot reject it - `Sky & Sea` is a legitimate label - so escaping
   * must make it inert. See "security" below for the assertion that the document is still
   * accepted after escaping, which is the property that matters.
   */
  const hostileText = '</title><script>alert(1)</script><title>';

  it('escapes a hostile layer name rather than letting it close the title element', () => {
    const scene = sceneOf({
      canvas: { width: 100, height: 100 },
      layers: [
        {
          id: 'a',
          name: hostileText,
          shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }],
        },
      ],
    });
    const svg = serializeSceneToSvg(scene);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('escapes a hostile scene title', () => {
    const scene = sceneOf({
      title: hostileText,
      canvas: { width: 100, height: 100 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }] }],
    });
    const svg = serializeSceneToSvg(scene);
    expect(svg).not.toContain('<script>');
  });

  it('keeps a legitimate ampersand readable instead of rejecting the layer', () => {
    const scene = sceneOf({
      canvas: { width: 100, height: 100 },
      layers: [
        {
          id: 'a',
          name: 'Sky & Sea',
          shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }],
        },
      ],
    });
    expect(serializeSceneToSvg(scene)).toContain('<title>Sky &amp; Sea</title>');
  });

  it('produces a document the gate still accepts after escaping hostile text', () => {
    // The property that matters: escaping must not merely hide the payload, it must leave a
    // document the engine's own validator accepts.
    const scene = sceneOf({
      title: hostileText,
      canvas: { width: 100, height: 100 },
      layers: [
        {
          id: 'a',
          name: hostileText,
          shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }],
        },
      ],
    });
    const verdict = validateSvg(serializeSceneToSvg(scene));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.svg).not.toContain('<script>');
  });
});

describe('serializeFrameSvg — progressive prefixes', () => {
  it('includes only the layers up to and including the frame index', () => {
    const scene = sceneOf(HOUSE);
    expect(serializeFrameSvg(scene, 0)).toContain('id="sky"');
    expect(serializeFrameSvg(scene, 0)).not.toContain('id="house"');
    expect(serializeFrameSvg(scene, 1)).toContain('id="house"');
  });

  it('treats the index as inclusive, which is the whole off-by-one question', () => {
    const scene = sceneOf(HOUSE);
    expect(serializeFrameSvg(scene, 0).match(/<g id=/g)).toHaveLength(1);
    expect(serializeFrameSvg(scene, 1).match(/<g id=/g)).toHaveLength(2);
  });

  it('still emits defs on a frame whose layers do not use them yet', () => {
    // Keeps a client's frame diff clean: defs must not appear and disappear mid-sequence.
    const scene = sceneOf({
      canvas: { width: 100, height: 100 },
      gradients: [
        {
          kind: 'linear',
          id: 'g',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 0,
          stops: [
            { offset: 0, color: '#000' },
            { offset: 1, color: '#fff' },
          ],
        },
      ],
      layers: [
        { id: 'plain', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }] },
        {
          id: 'grad',
          shapes: [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: 'url(#g)' }],
        },
      ],
    });
    expect(serializeFrameSvg(scene, 0)).toContain('<defs>');
  });

  it('clamps an out-of-range index rather than throwing, unlike buildFrame', () => {
    // Serialization is a pure formatting step; the range check belongs to frame assembly,
    // which is where an out-of-range index means a caller's arithmetic is wrong.
    const scene = sceneOf(HOUSE);
    expect(serializeFrameSvg(scene, 99).match(/<g id=/g)).toHaveLength(2);
  });

  it('produces a canvas-only document for an empty prefix, which is frame zero', () => {
    const svg = serializeSceneToSvg(sceneOf(HOUSE), { layers: [] });
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('<g id=');
  });
});

describe('serializeSceneToSvg — determinism', () => {
  it('produces byte-identical output for the same scene', () => {
    const scene = sceneOf(HOUSE);
    expect(serializeSceneToSvg(scene)).toBe(serializeSceneToSvg(scene));
  });

  it('produces byte-identical output for two independently normalized copies', () => {
    expect(serializeSceneToSvg(sceneOf(HOUSE, 'a'))).toBe(serializeSceneToSvg(sceneOf(HOUSE, 'b')));
  });

  it('produces byte-identical frames for repeated assembly', () => {
    const scene = sceneOf(HOUSE);
    expect(serializeFrameSvg(scene, 1)).toBe(serializeFrameSvg(scene, 1));
  });
});
