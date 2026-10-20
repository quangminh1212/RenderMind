import { describe, it, expect } from 'vitest';
import {
  looksLikeScene,
  normalizeScene,
  sceneCanvas,
  sceneStatistics,
} from '../../../../src/platform/progressive/scene';
import type { SceneRejectionCode } from '../../../../src/platform/progressive/scene';
// Bounds come from the types module, which is their single source of truth. Importing them
// from `scene` would read as an undefined constant - it consumes them without re-exporting -
// and a test built on `undefined + 1` silently exercises an empty array instead of a
// boundary, which is exactly the failure mode a bound test exists to catch.
import {
  MAX_CANVAS_EDGE,
  MAX_COORDINATE,
  MAX_GRADIENT_STOPS,
  MAX_GRADIENTS,
  MAX_LAYERS,
  MAX_SHAPES_PER_LAYER,
} from '../../../../src/types/progressive.types';

/**
 * Scene gate tests.
 *
 * `normalizeScene` is the security boundary of progressive rendering: everything downstream
 * assumes its output is safe and never re-checks. So the cases here are chosen to pin the
 * *refusals*, not just the acceptances - each one asserts on the rejection **code**, because
 * a future change that still refuses a payload but for the wrong reason must fail here rather
 * than pass by accident.
 *
 * The payloads are all written as plain JSON objects rather than through a typed builder, on
 * purpose. Reality arrives as `JSON.parse(modelOutput)`, which is `any`; a test that went
 * through a typed constructor would be exercising a code path no caller has.
 */

/** A scene that genuinely draws something, and passes every field check. */
function validScene(): Record<string, unknown> {
  return {
    title: 'A house',
    canvas: { width: 320, height: 200, background: '#ffffff' },
    layers: [
      {
        id: 'sky',
        name: 'Sky',
        shapes: [{ kind: 'rect', x: 0, y: 0, width: 320, height: 120, fill: '#87ceeb' }],
      },
      {
        id: 'house',
        name: 'House',
        opacity: 0.9,
        blend: 'multiply',
        shapes: [
          { kind: 'rect', x: 100, y: 90, width: 120, height: 80, fill: '#8b5a2b' },
          {
            kind: 'polygon',
            points: [
              { x: 80, y: 90 },
              { x: 160, y: 40 },
              { x: 240, y: 90 },
            ],
            fill: '#b22222',
          },
        ],
      },
    ],
  };
}

/** Run the gate and return the rejection code, failing the test if it was accepted. */
function rejectionCode(payload: unknown): SceneRejectionCode {
  const verdict = normalizeScene(payload, 'scene_1');
  if (verdict.ok) throw new Error('Expected the payload to be refused, but it was accepted');
  return verdict.code;
}

/** Run the gate and return the reason, failing the test if it was accepted. */
function rejectionReason(payload: unknown): string {
  const verdict = normalizeScene(payload, 'scene_1');
  if (verdict.ok) throw new Error('Expected the payload to be refused, but it was accepted');
  return verdict.reason;
}

describe('normalizeScene — acceptance', () => {
  it('accepts a well-formed scene and materializes every field', () => {
    const verdict = normalizeScene(validScene(), 'scene_abc');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    expect(verdict.scene.sceneId).toBe('scene_abc');
    expect(verdict.scene.title).toBe('A house');
    expect(verdict.scene.width).toBe(320);
    expect(verdict.scene.height).toBe(200);
    expect(verdict.scene.background).toBe('#ffffff');
    expect(verdict.scene.layers).toHaveLength(2);
    expect(verdict.scene.shapeCount).toBe(3);
  });

  it('takes the scene id from the caller, never from the payload', () => {
    // The model must not be able to make its own stream unaddressable by writing a bad id.
    const payload = { ...validScene(), sceneId: '../../etc/passwd' };
    const verdict = normalizeScene(payload, 'scene_trusted');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.sceneId).toBe('scene_trusted');
  });

  it('defaults the title to the empty string rather than undefined', () => {
    const payload = validScene();
    delete payload.title;
    const verdict = normalizeScene(payload, 'scene_1');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.title).toBe('');
  });

  it('defaults the background to transparent, which is what SVG does', () => {
    const payload = validScene();
    payload.canvas = { width: 10, height: 10 };
    const verdict = normalizeScene(payload, 'scene_1');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.background).toBe('none');
  });

  it('defaults a layer name to its id', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'only', shapes: [{ kind: 'circle', cx: 5, cy: 5, r: 2, fill: '#000' }] }],
    };
    const verdict = normalizeScene(payload, 'scene_1');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.layers[0].name).toBe('only');
  });

  it('records the array position as the layer order', () => {
    const verdict = normalizeScene(validScene(), 'scene_1');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.layers.map((layer) => layer.order)).toEqual([0, 1]);
  });

  it('accepts every shape kind in the repertoire', () => {
    const payload = {
      canvas: { width: 100, height: 100 },
      layers: [
        {
          id: 'all',
          shapes: [
            { kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
            { kind: 'circle', cx: 5, cy: 5, r: 3 },
            { kind: 'ellipse', cx: 5, cy: 5, rx: 3, ry: 2 },
            { kind: 'line', x1: 0, y1: 0, x2: 9, y2: 9 },
            {
              kind: 'polygon',
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
                { x: 2, y: 0 },
              ],
            },
            { kind: 'path', d: 'M0 0 L10 10 Z' },
          ],
        },
      ],
    };
    const verdict = normalizeScene(payload, 'scene_1');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.shapeCount).toBe(6);
    expect(Object.keys(sceneStatistics(verdict.scene).shapesByKind)).toHaveLength(6);
  });

  it('accepts gradients and resolves a shape reference to one', () => {
    const payload = {
      canvas: { width: 100, height: 100 },
      gradients: [
        {
          kind: 'linear',
          id: 'sunset',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 0,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff', opacity: 0.5 },
          ],
        },
      ],
      layers: [
        {
          id: 'sky',
          shapes: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 100, fill: 'url(#sunset)' }],
        },
      ],
    };
    const verdict = normalizeScene(payload, 'scene_1');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.gradients).toHaveLength(1);
  });

  it('accepts a gradient declared after the shape that references it', () => {
    // Order-independence matters: a model writing JSON has no reason to emit defs first.
    const payload = {
      canvas: { width: 100, height: 100 },
      layers: [
        {
          id: 'sky',
          shapes: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 100, fill: 'url(#g)' }],
        },
      ],
      gradients: [
        {
          kind: 'linear',
          id: 'g',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: '#000' },
            { offset: 1, color: '#fff' },
          ],
        },
      ],
    };
    expect(normalizeScene(payload, 'scene_1').ok).toBe(true);
  });

  it('accepts a path with every supported drawing command', () => {
    const payload = {
      canvas: { width: 100, height: 100 },
      layers: [
        { id: 'p', shapes: [{ kind: 'path', d: 'M0 0 L10 0 H20 V20 C1 1 2 2 3 3 Q4 4 5 5 Z' }] },
      ],
    };
    expect(normalizeScene(payload, 'scene_1').ok).toBe(true);
  });

  it('accepts a path with comma separators, signs, and exponents', () => {
    const payload = {
      canvas: { width: 100, height: 100 },
      layers: [{ id: 'p', shapes: [{ kind: 'path', d: 'M-1.5,2 L1e2 3.25' }] }],
    };
    expect(normalizeScene(payload, 'scene_1').ok).toBe(true);
  });

  it('keeps scalar metadata and drops nested values without failing the render', () => {
    const payload = {
      ...validScene(),
      metadata: { traceId: 'abc', attempt: 2, cached: false, nested: { a: 1 }, list: [1, 2] },
    };
    const verdict = normalizeScene(payload, 'scene_1');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.scene.metadata).toEqual({ traceId: 'abc', attempt: 2, cached: false });
  });

  it('accepts a single-layer scene, which is the degenerate progressive case', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'one', shapes: [{ kind: 'circle', cx: 5, cy: 5, r: 1 }] }],
    };
    expect(normalizeScene(payload, 'scene_1').ok).toBe(true);
  });
});

describe('normalizeScene — structural refusals', () => {
  it('refuses a payload that is not an object', () => {
    expect(rejectionCode('a house')).toBe('scene_not_object');
    expect(rejectionCode(null)).toBe('scene_not_object');
    expect(rejectionCode([])).toBe('scene_not_object');
    expect(rejectionCode(42)).toBe('scene_not_object');
  });

  it('refuses a scene with no canvas', () => {
    expect(rejectionCode({ layers: [] })).toBe('scene_missing_canvas');
  });

  it('refuses a canvas that is not an object', () => {
    expect(rejectionCode({ canvas: 'big', layers: [] })).toBe('scene_invalid_canvas');
  });

  it('refuses a scene with no layers, which would render nothing', () => {
    expect(rejectionCode({ canvas: { width: 10, height: 10 }, layers: [] })).toBe(
      'scene_no_layers',
    );
  });

  it('refuses a missing layers field', () => {
    expect(rejectionCode({ canvas: { width: 10, height: 10 } })).toBe('scene_no_layers');
  });

  it('refuses a non-string scene id', () => {
    const verdict = normalizeScene(validScene(), 42 as unknown as string);
    expect(verdict.ok).toBe(false);
  });
});

describe('normalizeScene — bounds', () => {
  it('refuses a canvas wider than the edge limit', () => {
    const payload = {
      canvas: { width: MAX_CANVAS_EDGE + 1, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_invalid_canvas');
  });

  it('refuses a zero or negative canvas dimension', () => {
    for (const dimension of [0, -1]) {
      const payload = {
        canvas: { width: dimension, height: 10 },
        layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
      };
      expect(rejectionCode(payload)).toBe('scene_invalid_canvas');
    }
  });

  it('refuses a NaN canvas dimension, which JSON.parse cannot produce but code can', () => {
    const payload = {
      canvas: { width: NaN, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_invalid_canvas');
  });

  it('refuses more layers than the frame limit', () => {
    const layers = Array.from({ length: MAX_LAYERS + 1 }, (_, index) => ({
      id: `layer-${index}`,
      shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }],
    }));
    expect(rejectionCode({ canvas: { width: 10, height: 10 }, layers })).toBe(
      'scene_too_many_layers',
    );
  });

  it('accepts exactly the layer limit, so the bound is off-by-one clean', () => {
    const layers = Array.from({ length: MAX_LAYERS }, (_, index) => ({
      id: `layer-${index}`,
      shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }],
    }));
    expect(normalizeScene({ canvas: { width: 10, height: 10 }, layers }, 'scene_1').ok).toBe(true);
  });

  it('refuses more shapes in a layer than the limit', () => {
    const shapes = Array.from({ length: MAX_SHAPES_PER_LAYER + 1 }, () => ({
      kind: 'circle',
      cx: 1,
      cy: 1,
      r: 1,
    }));
    expect(
      rejectionCode({ canvas: { width: 10, height: 10 }, layers: [{ id: 'a', shapes }] }),
    ).toBe('scene_shape_invalid');
  });

  it('refuses a layer with no shapes, which would be a frame that changes nothing', () => {
    expect(
      rejectionCode({ canvas: { width: 10, height: 10 }, layers: [{ id: 'empty', shapes: [] }] }),
    ).toBe('scene_layer_invalid');
  });

  it('refuses a coordinate beyond the magnitude bound', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: MAX_COORDINATE + 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionReason(payload)).toContain('beyond');
  });

  it('refuses a coordinate that is Infinity', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: Infinity, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_shape_invalid');
  });

  it('refuses more gradients than the limit', () => {
    const gradients = Array.from({ length: MAX_GRADIENTS + 1 }, (_, index) => ({
      kind: 'linear',
      id: `g${index}`,
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stops: [
        { offset: 0, color: '#000' },
        { offset: 1, color: '#fff' },
      ],
    }));
    expect(
      rejectionCode({
        canvas: { width: 10, height: 10 },
        gradients,
        layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
      }),
    ).toBe('scene_gradient_invalid');
  });

  it('refuses more gradient stops than the limit', () => {
    const stops = Array.from({ length: MAX_GRADIENT_STOPS + 1 }, (_, index) => ({
      offset: index / MAX_GRADIENT_STOPS,
      color: '#000000',
    }));
    const payload = {
      canvas: { width: 10, height: 10 },
      gradients: [{ kind: 'linear', id: 'g', x1: 0, y1: 0, x2: 1, y2: 1, stops }],
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_gradient_invalid');
  });

  it('refuses an over-long title rather than truncating it silently', () => {
    const payload = { ...validScene(), title: 'x'.repeat(1000) };
    expect(rejectionCode(payload)).toBe('scene_text_too_long');
  });
});

describe('normalizeScene — identifiers', () => {
  it('refuses a layer id containing an angle bracket', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: '<script>', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_layer_invalid');
  });

  it('refuses a layer id containing a quote, which would escape an attribute', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a"b', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_layer_invalid');
  });

  it('refuses a layer id containing whitespace', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a b', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_layer_invalid');
  });

  it('refuses a layer id starting with a non-alphanumeric', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: '-lead', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_layer_invalid');
  });

  it('refuses a duplicate layer id, which would make the frame handle ambiguous', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        { id: 'same', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] },
        { id: 'same', shapes: [{ kind: 'circle', cx: 2, cy: 2, r: 1 }] },
      ],
    };
    expect(rejectionCode(payload)).toBe('scene_duplicate_layer_id');
  });

  it('refuses a duplicate gradient id', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      gradients: [
        {
          kind: 'linear',
          id: 'g',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: '#000' },
            { offset: 1, color: '#fff' },
          ],
        },
        {
          kind: 'linear',
          id: 'g',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: '#000' },
            { offset: 1, color: '#fff' },
          ],
        },
      ],
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_gradient_invalid');
  });
});

describe('normalizeScene — paint safety', () => {
  it('refuses a data: URL in a fill, which would smuggle an unvalidated payload', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'a',
          shapes: [
            { kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
    };
    expect(rejectionCode(payload)).toBe('scene_paint_invalid');
  });

  it('refuses an external http reference in a fill', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'a',
          shapes: [
            {
              kind: 'rect',
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              fill: 'url(http://evil.example/x.svg)',
            },
          ],
        },
      ],
    };
    expect(rejectionCode(payload)).toBe('scene_paint_invalid');
  });

  it('refuses a javascript: URL in a fill', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'a',
          shapes: [
            { kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: 'javascript:alert(1)' },
          ],
        },
      ],
    };
    expect(rejectionCode(payload)).toBe('scene_paint_invalid');
  });

  it('refuses a CSS colour function, which is a parser this protocol does not need', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'a',
          shapes: [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: 'rgb(1,2,3)' }],
        },
      ],
    };
    expect(rejectionCode(payload)).toBe('scene_paint_invalid');
  });

  it('refuses a background that is not a hex colour or none', () => {
    const payload = {
      canvas: { width: 10, height: 10, background: 'url(#x)' },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_invalid_canvas');
  });

  it('refuses an unresolvable gradient reference', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'a',
          shapes: [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: 'url(#missing)' }],
        },
      ],
    };
    expect(rejectionCode(payload)).toBe('scene_gradient_undeclared');
  });

  it('refuses a gradient whose own stop is a reference, which SVG cannot nest', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      gradients: [
        {
          kind: 'linear',
          id: 'g',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: 'url(#g)' },
            { offset: 1, color: '#fff' },
          ],
        },
      ],
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_gradient_invalid');
  });
});

describe('normalizeScene — shape geometry', () => {
  it('refuses an unknown shape kind, naming the accepted set', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'script', d: 'alert(1)' }] }],
    };
    expect(rejectionReason(payload)).toContain('kind');
  });

  it('refuses a shape that is a bare string, which is how a model writes a shortcut', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: ['a red circle'] }],
    };
    expect(rejectionCode(payload)).toBe('scene_shape_invalid');
  });

  it('refuses a zero-width rect', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'rect', x: 0, y: 0, width: 0, height: 10 }] }],
    };
    expect(rejectionReason(payload)).toContain('width');
  });

  it('refuses a negative radius', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 1, cy: 1, r: -1 }] }],
    };
    expect(rejectionCode(payload)).toBe('scene_shape_invalid');
  });

  it('refuses a zero-length line, which paints nothing', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'line', x1: 1, y1: 1, x2: 1, y2: 1 }] }],
    };
    expect(rejectionReason(payload)).toContain('zero-length');
  });

  it('refuses a polygon with fewer than 3 points', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'a',
          shapes: [
            {
              kind: 'polygon',
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ],
            },
          ],
        },
      ],
    };
    expect(rejectionReason(payload)).toContain('3 points');
  });

  it('refuses a polygon point that is not a pair', () => {
    const payload = {
      canvas: { width: 10, height: 10 },
      layers: [
        {
          id: 'a',
          shapes: [{ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, 'nope'] }],
        },
      ],
    };
    expect(rejectionCode(payload)).toBe('scene_shape_invalid');
  });
});

describe('normalizeScene — path grammar', () => {
  const withPath = (d: unknown) => ({
    canvas: { width: 10, height: 10 },
    layers: [{ id: 'p', shapes: [{ kind: 'path', d }] }],
  });

  it('refuses a path that is not a string', () => {
    expect(rejectionCode(withPath(['M0 0']))).toBe('scene_shape_invalid');
  });

  it('refuses an empty path', () => {
    expect(rejectionCode(withPath(''))).toBe('scene_path_invalid');
  });

  it('refuses a path that starts with a number instead of a command', () => {
    expect(rejectionCode(withPath('0 0 L10 10'))).toBe('scene_path_invalid');
  });

  it('refuses a path with a wrong argument count', () => {
    expect(rejectionCode(withPath('M0 L10 10'))).toBe('scene_path_invalid');
  });

  it('refuses a path with a trailing fragment', () => {
    expect(rejectionCode(withPath('M0 0 L10 10 L'))).toBe('scene_path_invalid');
  });

  it('refuses a lone moveto, which draws nothing', () => {
    expect(rejectionReason(withPath('M0 0'))).toContain('no drawing command');
  });

  it('refuses a path containing an angle bracket, which could escape the attribute', () => {
    expect(rejectionCode(withPath('M0 0 L10 10 ><script>'))).toBe('scene_path_invalid');
  });

  it('refuses a path containing a quote', () => {
    expect(rejectionCode(withPath('M0 0 L10 10" onload="x'))).toBe('scene_path_invalid');
  });

  it('refuses a path containing an ampersand entity', () => {
    expect(rejectionCode(withPath('M0 0 L10 10&amp;'))).toBe('scene_path_invalid');
  });

  it('refuses an arc command, which this protocol does not implement', () => {
    expect(rejectionCode(withPath('M0 0 A5 5 0 0 1 10 10'))).toBe('scene_path_invalid');
  });

  it('refuses a path with a coordinate beyond the magnitude bound', () => {
    expect(rejectionReason(withPath(`M0 0 L${MAX_COORDINATE + 1} 0`))).toContain('beyond');
  });

  it('refuses an over-long path', () => {
    expect(rejectionCode(withPath(`M0 0 ${'L0 0 '.repeat(3000)}`))).toBe('scene_path_invalid');
  });

  it('reports a bad path data field with the path code, not a generic shape code', () => {
    // The code a client branches on must point at the actual defect. A caller that treats
    // `scene_shape_invalid` as retryable and `scene_path_invalid` as terminal would otherwise
    // make the wrong decision on a malformed path.
    expect(rejectionCode(withPath('M0 0 L10 10 <'))).toBe('scene_path_invalid');
  });
});

describe('sceneStatistics', () => {
  it('counts every shape by kind', () => {
    const verdict = normalizeScene(validScene(), 'scene_1');
    if (!verdict.ok) throw new Error('fixture should be accepted');
    const stats = sceneStatistics(verdict.scene);
    expect(stats.layerCount).toBe(2);
    expect(stats.shapeCount).toBe(3);
    expect(stats.shapesByKind.rect).toBe(2);
    expect(stats.shapesByKind.polygon).toBe(1);
    expect(stats.gradientCount).toBe(0);
  });

  it('reports zero for kinds the scene does not use rather than omitting them', () => {
    const verdict = normalizeScene(validScene(), 'scene_1');
    if (!verdict.ok) throw new Error('fixture should be accepted');
    expect(sceneStatistics(verdict.scene).shapesByKind.circle).toBe(0);
  });
});

describe('sceneCanvas', () => {
  it('exposes the canvas without the rest of the scene', () => {
    const verdict = normalizeScene(validScene(), 'scene_1');
    if (!verdict.ok) throw new Error('fixture should be accepted');
    expect(sceneCanvas(verdict.scene)).toEqual({ width: 320, height: 200, background: '#ffffff' });
  });
});

describe('looksLikeScene', () => {
  it('accepts a payload shaped like a scene', () => {
    expect(looksLikeScene(validScene())).toBe(true);
  });

  it('rejects prose', () => {
    expect(looksLikeScene('Here is a picture of a house')).toBe(false);
  });

  it('rejects a payload with no canvas', () => {
    expect(looksLikeScene({ layers: [] })).toBe(false);
  });

  it('does not claim safety — an unsafe scene still looks like one', () => {
    // The distinction matters: `looksLikeScene` is a dispatcher hint, and only
    // `normalizeScene` may be trusted. A scene full of script-looking payloads still passes.
    const unsafe = {
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'a', shapes: [{ kind: 'script' }] }],
    };
    expect(looksLikeScene(unsafe)).toBe(true);
    expect(normalizeScene(unsafe, 's').ok).toBe(false);
  });
});
