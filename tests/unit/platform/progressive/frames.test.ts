import { describe, it, expect } from 'vitest';
import {
  FRAME_EVENT_NAME,
  assembleFrames,
  buildFrame,
  buildFrameZero,
  renderSceneFrames,
  toFrameEvent,
} from '../../../../src/platform/progressive/frames';
import { normalizeScene } from '../../../../src/platform/progressive/scene';
import {
  PROGRESSIVE_MIME,
  PROGRESSIVE_PROTOCOL_VERSION,
} from '../../../../src/types/progressive.types';
import { validateSvg } from '../../../../src/platform/svg';
import type { NormalizedScene } from '../../../../src/types/progressive.types';

/**
 * Frame assembly tests.
 *
 * Two properties carry this module, and most of what follows exists to pin one of them:
 *
 *   1. **Every frame is independently renderable.** Frame K is a complete document, not a
 *      fragment, so a client that missed the stream so far can still paint the latest one.
 *      Asserted by routing each frame through the engine's own `validateSvg`.
 *
 *   2. **Assembly is a pure function of (scene, index).** No accumulator, no clock. Asserted
 *      by rebuilding a frame and comparing bytes, and by checking that a frame built in
 *      isolation equals the one produced by a full assembly pass.
 */

function sceneOf(payload: unknown, sceneId = 'scene_test'): NormalizedScene {
  const verdict = normalizeScene(payload, sceneId);
  if (!verdict.ok)
    throw new Error(`fixture should be valid, got ${verdict.code}: ${verdict.reason}`);
  return verdict.scene;
}

const THREE_LAYERS = {
  canvas: { width: 100, height: 100, background: '#ffffff' },
  layers: [
    { id: 'one', name: 'First', shapes: [{ kind: 'circle', cx: 10, cy: 10, r: 5, fill: '#111' }] },
    { id: 'two', name: 'Second', shapes: [{ kind: 'circle', cx: 50, cy: 50, r: 5, fill: '#222' }] },
    {
      id: 'three',
      name: 'Third',
      shapes: [
        { kind: 'circle', cx: 90, cy: 90, r: 5, fill: '#333' },
        { kind: 'rect', x: 0, y: 0, width: 5, height: 5, fill: '#444' },
      ],
    },
  ],
};

describe('buildFrameZero — the placeholder', () => {
  it('draws the canvas and nothing else', () => {
    const frame = buildFrameZero(sceneOf(THREE_LAYERS));
    expect(frame.shapeCount).toBe(0);
    expect(frame.layerId).toBeNull();
    expect(frame.svg).not.toContain('<g id=');
  });

  it('reports a canvas size before any layer has arrived, so a client can reserve layout', () => {
    const frame = buildFrameZero(sceneOf(THREE_LAYERS));
    expect(frame.width).toBe(100);
    expect(frame.height).toBe(100);
  });

  it('reports progress 0', () => {
    expect(buildFrameZero(sceneOf(THREE_LAYERS)).progress).toBe(0);
  });

  it('reports the total frame count so a client knows the length up front', () => {
    expect(buildFrameZero(sceneOf(THREE_LAYERS)).total).toBe(3);
  });

  it('is a document the engine gate accepts', () => {
    expect(validateSvg(buildFrameZero(sceneOf(THREE_LAYERS)).svg).ok).toBe(true);
  });

  it('reports a byte length matching the document', () => {
    const frame = buildFrameZero(sceneOf(THREE_LAYERS));
    expect(frame.byteLength).toBe(Buffer.byteLength(frame.svg, 'utf8'));
  });
});

describe('buildFrame — one frame per layer', () => {
  it('adds exactly the layer at the given index', () => {
    const scene = sceneOf(THREE_LAYERS);
    expect(buildFrame(scene, 0).layerId).toBe('one');
    expect(buildFrame(scene, 1).layerId).toBe('two');
    expect(buildFrame(scene, 2).layerId).toBe('three');
  });

  it('carries the layer name for a progress label', () => {
    expect(buildFrame(sceneOf(THREE_LAYERS), 1).layerName).toBe('Second');
  });

  it('accumulates the shape count', () => {
    const scene = sceneOf(THREE_LAYERS);
    expect(buildFrame(scene, 0).shapeCount).toBe(1);
    expect(buildFrame(scene, 1).shapeCount).toBe(2);
    expect(buildFrame(scene, 2).shapeCount).toBe(4);
  });

  it('includes this layer and every earlier one', () => {
    const scene = sceneOf(THREE_LAYERS);
    const frame = buildFrame(scene, 1);
    expect(frame.svg).toContain('id="one"');
    expect(frame.svg).toContain('id="two"');
    expect(frame.svg).not.toContain('id="three"');
  });

  it('produces a document the engine gate accepts, so a frame is independently renderable', () => {
    const scene = sceneOf(THREE_LAYERS);
    for (let index = 0; index < scene.layers.length; index += 1) {
      const verdict = validateSvg(buildFrame(scene, index).svg);
      expect(verdict.ok, `frame ${index} was refused: ${verdict.ok ? '' : verdict.reason}`).toBe(
        true,
      );
    }
  });

  it('reports a byte length matching the document', () => {
    const frame = buildFrame(sceneOf(THREE_LAYERS), 2);
    expect(frame.byteLength).toBe(Buffer.byteLength(frame.svg, 'utf8'));
  });

  it('reports the scene dimensions on every frame', () => {
    for (const frame of assembleFrames(sceneOf(THREE_LAYERS))) {
      expect(frame.width).toBe(100);
      expect(frame.height).toBe(100);
    }
  });

  it('reports the same total on every frame', () => {
    for (const frame of assembleFrames(sceneOf(THREE_LAYERS))) {
      expect(frame.total).toBe(3);
    }
  });
});

describe('buildFrame — progress', () => {
  it('runs from 0 on the first layer to 1 on the last', () => {
    const frames = assembleFrames(sceneOf(THREE_LAYERS));
    expect(frames[0].progress).toBe(0);
    expect(frames[frames.length - 1].progress).toBe(1);
  });

  it('reports the exact completion fraction between the ends', () => {
    const frames = assembleFrames(sceneOf(THREE_LAYERS));
    expect(frames[1].progress).toBeCloseTo(0.5);
  });

  it('reports 1 for a single-layer scene, rather than dividing by zero', () => {
    const scene = sceneOf({
      canvas: { width: 10, height: 10 },
      layers: [{ id: 'only', shapes: [{ kind: 'circle', cx: 5, cy: 5, r: 1, fill: '#000' }] }],
    });
    expect(buildFrame(scene, 0).progress).toBe(1);
  });

  it('increases monotonically, so a progress bar never goes backwards', () => {
    const frames = assembleFrames(sceneOf(THREE_LAYERS));
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index].progress).toBeGreaterThan(frames[index - 1].progress);
    }
  });
});

describe('buildFrame — bounds', () => {
  it('throws on an index past the last layer rather than clamping', () => {
    // Clamping would silently repeat the final frame, which a client reads as a stall.
    const scene = sceneOf(THREE_LAYERS);
    expect(() => buildFrame(scene, 3)).toThrow(RangeError);
  });

  it('throws on a negative index', () => {
    expect(() => buildFrame(sceneOf(THREE_LAYERS), -1)).toThrow(RangeError);
  });

  it('throws on a non-integer index', () => {
    expect(() => buildFrame(sceneOf(THREE_LAYERS), 1.5)).toThrow(RangeError);
  });

  it('names the valid range in the error, so the caller can see the mistake', () => {
    expect(() => buildFrame(sceneOf(THREE_LAYERS), 9)).toThrow(/3 layer/);
  });
});

describe('assembleFrames', () => {
  it('returns one frame per layer', () => {
    expect(assembleFrames(sceneOf(THREE_LAYERS))).toHaveLength(3);
  });

  it('numbers frames from 0', () => {
    expect(assembleFrames(sceneOf(THREE_LAYERS)).map((frame) => frame.index)).toEqual([0, 1, 2]);
  });

  it('returns an empty list for a scene with no layers, which normalizeScene already refuses', () => {
    // Unreachable through a validated scene, but the function must not assume its caller
    // validated: an empty list is the honest answer to an empty scene.
    const scene = sceneOf(THREE_LAYERS);
    const hollow = { ...scene, layers: [] } as NormalizedScene;
    expect(assembleFrames(hollow)).toEqual([]);
  });

  it('produces frames whose shapes never decrease, so a picture only accumulates', () => {
    const frames = assembleFrames(sceneOf(THREE_LAYERS));
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index].shapeCount).toBeGreaterThanOrEqual(frames[index - 1].shapeCount);
    }
  });
});

describe('assembly is deterministic', () => {
  it('produces byte-identical frames across two assembly passes', () => {
    const scene = sceneOf(THREE_LAYERS);
    const first = assembleFrames(scene);
    const second = assembleFrames(scene);
    expect(first.map((frame) => frame.svg)).toEqual(second.map((frame) => frame.svg));
  });

  it('produces the same frame built alone as built in a full pass', () => {
    // The property that makes frames recomputable and cacheable: there is no accumulator.
    const scene = sceneOf(THREE_LAYERS);
    const fromPass = assembleFrames(scene);
    for (let index = 0; index < scene.layers.length; index += 1) {
      expect(buildFrame(scene, index).svg).toBe(fromPass[index].svg);
    }
  });

  it('is unaffected by the scene id, which is stream identity and not content', () => {
    const a = assembleFrames(sceneOf(THREE_LAYERS, 'stream-a'));
    const b = assembleFrames(sceneOf(THREE_LAYERS, 'stream-b'));
    expect(a.map((frame) => frame.svg)).toEqual(b.map((frame) => frame.svg));
  });
});

describe('toFrameEvent — the transport payload', () => {
  it('names the event so a client matches on one constant', () => {
    const scene = sceneOf(THREE_LAYERS);
    expect(toFrameEvent(scene, buildFrame(scene, 0)).event).toBe(FRAME_EVENT_NAME);
  });

  it('builds a resumable id from the scene id and frame index', () => {
    const scene = sceneOf(THREE_LAYERS, 'scn_7');
    expect(toFrameEvent(scene, buildFrame(scene, 1)).id).toBe('scn_7:1');
  });

  it('carries the protocol version, so a client can refuse a stream it does not speak', () => {
    const scene = sceneOf(THREE_LAYERS);
    expect(toFrameEvent(scene, buildFrame(scene, 0)).protocolVersion).toBe(
      PROGRESSIVE_PROTOCOL_VERSION,
    );
  });

  it('declares the SVG mime type', () => {
    const scene = sceneOf(THREE_LAYERS);
    expect(toFrameEvent(scene, buildFrame(scene, 0)).mime).toBe(PROGRESSIVE_MIME);
  });

  it('provides a data URI that base64-decodes back to the same document', () => {
    const scene = sceneOf(THREE_LAYERS);
    const event = toFrameEvent(scene, buildFrame(scene, 1));
    expect(event.dataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);

    const base64 = event.dataUri.slice('data:image/svg+xml;base64,'.length);
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(event.svg);
  });

  it('ships the inline document alongside the data URI, for clients that want markup', () => {
    const scene = sceneOf(THREE_LAYERS);
    const event = toFrameEvent(scene, buildFrame(scene, 0));
    expect(validateSvg(event.svg).ok).toBe(true);
  });

  it('states plainly that the frame is assembled, not diffusion-sampled', () => {
    // Honesty on the wire: a client must not read a frame as evidence of an image model.
    const scene = sceneOf(THREE_LAYERS);
    expect(toFrameEvent(scene, buildFrame(scene, 0)).diffusion).toBe(false);
  });

  it('handles frame zero, whose layer id is null', () => {
    const scene = sceneOf(THREE_LAYERS);
    const event = toFrameEvent(scene, buildFrameZero(scene));
    expect(event.layerId).toBeNull();
    expect(event.id).toBe('scene_test:0');
    expect(event.diffusion).toBe(false);
  });

  it('carries the same geometry fields a consumer needs to place the frame', () => {
    const scene = sceneOf(THREE_LAYERS);
    const event = toFrameEvent(scene, buildFrame(scene, 2));
    expect(event.width).toBe(100);
    expect(event.height).toBe(100);
    expect(event.total).toBe(3);
    expect(event.index).toBe(2);
    expect(event.progress).toBe(1);
  });
});

describe('renderSceneFrames — the one-call path', () => {
  it('validates, assembles and wraps in one call', () => {
    const result = renderSceneFrames(THREE_LAYERS, 'scene_1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(4);
  });

  it('includes frame zero, so the client is never missing the head of the stream', () => {
    const result = renderSceneFrames(THREE_LAYERS, 'scene_1');
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.frames?.[0].index).toBe(0);
    expect(result.frames?.[0].layerId).toBeNull();
  });

  it('returns the validation verdict unchanged when the payload is unsafe', () => {
    // The failure must not be swallowed into an empty frame list - a caller has to be able to
    // tell "no frames" from "refused, and here is why".
    const result = renderSceneFrames(
      { canvas: { width: 10, height: 10 }, layers: [{ id: 'a', shapes: [{ kind: 'script' }] }] },
      'scene_1',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.frames).toBeUndefined();
  });

  it('returns no frames at all for a refused payload', () => {
    const result = renderSceneFrames('prose, not a scene', 'scene_1');
    expect(result.ok).toBe(false);
    expect(result.frames).toBeUndefined();
  });

  it('exposes the scene alongside the frames, for a caller that wants both', () => {
    const result = renderSceneFrames(THREE_LAYERS, 'scene_1');
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.scene.layers).toHaveLength(3);
    expect(result.scene.sceneId).toBe('scene_1');
  });

  it('produces a stream in which every frame is independently renderable', () => {
    const result = renderSceneFrames(THREE_LAYERS, 'scene_1');
    if (!result.ok) throw new Error('expected acceptance');
    for (const frame of result.frames ?? []) {
      const verdict = validateSvg(frame.svg);
      expect(verdict.ok, `frame ${frame.index} refused: ${verdict.ok ? '' : verdict.reason}`).toBe(
        true,
      );
    }
  });

  it('produces a final frame containing every shape in the scene', () => {
    const result = renderSceneFrames(THREE_LAYERS, 'scene_1');
    if (!result.ok) throw new Error('expected acceptance');
    const frames = result.frames ?? [];
    const last = frames[frames.length - 1];
    expect(last.shapeCount).toBe(result.scene.shapeCount);
    expect(last.progress).toBe(1);
  });

  it('is deterministic end to end', () => {
    const a = renderSceneFrames(THREE_LAYERS, 'scene_1');
    const b = renderSceneFrames(THREE_LAYERS, 'scene_1');
    if (!a.ok || !b.ok) throw new Error('expected acceptance');
    expect((a.frames ?? []).map((frame) => frame.svg)).toEqual(
      (b.frames ?? []).map((frame) => frame.svg),
    );
  });
});
