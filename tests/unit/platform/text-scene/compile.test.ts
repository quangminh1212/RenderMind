import { describe, it, expect } from 'vitest';
import { compileTextScene, isValidationFailure } from '../../../../src/platform/text-scene/compile';
import { extractSceneCandidate } from '../../../../src/platform/text-scene/extract';
import { validateSvg } from '../../../../src/platform/svg';
import {
  FRAME_EVENT_NAME,
  PROGRESSIVE_MIME,
  PROGRESSIVE_PROTOCOL_VERSION,
} from '../../../../src/platform/progressive';
import type {
  ProgressiveFrame,
  ProgressiveFrameZero,
} from '../../../../src/types/progressive.types';

/**
 * Compiler tests.
 *
 * The compiler is the join between extraction and the scene gate, so this suite exists to prove
 * three things that neither half proves on its own:
 *
 *   1. **The join is ordered correctly.** A valid scene compiles; an object that extracts cleanly
 *      but fails validation is refused at `stage: 'validate'` and never reaches frame assembly.
 *      Asserted by handing the compiler payloads that extraction accepts and `normalizeScene`
 *      rejects — the only inputs that can distinguish the two stages.
 *
 *   2. **The three outputs agree.** `svg`, `finalFrame.svg`, and the last entry of `frames` must
 *      be byte-identical, `frames` must length-match `layers + 1`, and every frame must pass the
 *      engine's own `validateSvg`. A final frame that disagreed with the stream would be a bug
 *      nothing else in the pipeline catches, because each consumer only ever reads one of them.
 *
 *   3. **Determinism.** Two compiles of the same reply produce byte-identical output. This is
 *      the property that makes a compiled scene cacheable, and it is the property a well-meaning
 *      "add a timestamp to the frame id" change would silently destroy.
 */

/** A valid scene as a JSON string, used as the base of most fixtures. */
const SCENE_JSON = JSON.stringify({
  canvas: { width: 64, height: 64, background: '#ffffff' },
  title: 'Demo',
  layers: [
    {
      id: 'sky',
      name: 'Sky',
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 64, height: 64, fill: '#3366cc' }],
    },
    {
      id: 'sun',
      name: 'Sun',
      shapes: [{ kind: 'circle', cx: 32, cy: 32, r: 10, fill: '#ffcc00' }],
    },
  ],
});

/** Expect a failure and hand back the narrowed value. */
function expectFailure(result: ReturnType<typeof compileTextScene>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a failure');
  return result;
}

/** Expect a success and hand back the narrowed value. */
function expectSuccess(result: ReturnType<typeof compileTextScene>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected a success, got ${result.code}: ${result.reason}`);
  return result;
}

describe('compileTextScene — a valid scene', () => {
  it('compiles a bare JSON scene into a scene, an SVG and a frame sequence', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 'scene_1'));
    expect(result.scene.layers).toHaveLength(2);
    expect(result.scene.sceneId).toBe('scene_1');
    expect(result.svg.startsWith('<svg')).toBe(true);
    expect(result.svg.endsWith('</svg>')).toBe(true);
  });

  it('reports the extraction source so an operator can see how the reply was spelled', () => {
    expect(expectSuccess(compileTextScene(SCENE_JSON, 's')).source).toBe('json_text');
    expect(expectSuccess(compileTextScene('```json\n' + SCENE_JSON + '\n```', 's')).source).toBe(
      'fenced_json',
    );
    expect(expectSuccess(compileTextScene([{ type: 'text', text: SCENE_JSON }], 's')).source).toBe(
      'content_parts_text',
    );
  });

  it('assigns the caller-supplied scene id and never one from the payload', () => {
    const withHostileId = JSON.stringify({
      ...JSON.parse(SCENE_JSON),
      sceneId: 'model_chose_this',
    });
    const result = expectSuccess(compileTextScene(withHostileId, 'engine_chose_this'));
    expect(result.scene.sceneId).toBe('engine_chose_this');
    expect(result.frames.every((frame) => frame.sceneId === 'engine_chose_this')).toBe(true);
  });

  it('produces a final SVG the engine gate accepts, so the provider can rasterize it', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 'scene_1'));
    const verdict = validateSvg(result.svg);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
    if (verdict.ok) {
      expect(verdict.width).toBe(64);
      expect(verdict.height).toBe(64);
    }
  });

  it('reports statistics for the scene so a caller can log size without walking it', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    expect(result.statistics.layerCount).toBe(2);
    expect(result.statistics.shapeCount).toBe(2);
    expect(result.statistics.shapesByKind.rect).toBe(1);
    expect(result.statistics.shapesByKind.circle).toBe(1);
  });

  it('carries the final frame as a ProgressiveFrame, never as the placeholder', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    // `finalFrame` is `frames[layers]`, i.e. the last layer frame. Its upstream `index` is
    // `layers - 1` because layer frames are numbered from zero, not from the placeholder.
    expect(result.finalFrame.index).toBe(1);
    expect(result.finalFrame.layerId).toBe('sun');
    expect(result.finalFrame.total).toBe(2);
    expect(result.finalFrame.progress).toBe(1);
  });
});

describe('compileTextScene — fenced and content-part forms', () => {
  it('compiles a scene out of a fenced block surrounded by prose', () => {
    const reply = `Certainly! Here is the scene:\n\n\`\`\`json\n${SCENE_JSON}\n\`\`\`\n\nLet me know if you want changes.`;
    const result = expectSuccess(compileTextScene(reply, 's'));
    expect(result.scene.layers).toHaveLength(2);
    expect(result.source).toBe('fenced_json');
  });

  it('reports the source of the *fence* when a scene arrived inside one, even from content parts', () => {
    // The source names how the object was found, which is the more useful fact: this reply came
    // over content parts but the object was located inside a fenced block, and an operator
    // debugging a transport issue wants to know the fence was present and used.
    const result = expectSuccess(
      compileTextScene(
        [
          { type: 'text', text: 'Here you go:' },
          { type: 'text', text: '```json\n' + SCENE_JSON + '\n```' },
        ],
        's',
      ),
    );
    expect(result.source).toBe('fenced_json');
  });

  it('reports content_parts_text when content parts carry bare JSON with no fence', () => {
    const result = expectSuccess(compileTextScene([{ type: 'text', text: SCENE_JSON }], 's'));
    expect(result.source).toBe('content_parts_text');
  });

  it('compiles the same scene identically from a bare string and from a fence', () => {
    // The two spellings are the same picture, and a client keyed on the scene id must not be
    // able to tell them apart. This is the property that lets the transport be changed without
    // invalidating anything a caller cached.
    const bare = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const fenced = expectSuccess(compileTextScene('```json\n' + SCENE_JSON + '\n```', 's'));
    expect(fenced.svg).toBe(bare.svg);
    expect(fenced.frames).toEqual(bare.frames);
  });
});

describe('compileTextScene — extraction failures', () => {
  it('reports prose as an extraction failure, not a validation one', () => {
    const failure = expectFailure(compileTextScene('I cannot draw that.', 's'));
    expect(failure.stage).toBe('extract');
    expect(failure.code).toBe('scene_payload_prose');
  });

  it('reports malformed JSON as an extraction failure at the right code', () => {
    const failure = expectFailure(compileTextScene('{"canvas":{"width":64,', 's'));
    expect(failure.stage).toBe('extract');
    expect(failure.code).toBe('scene_json_truncated');
  });

  it('reports an array as an extraction failure rather than validating its elements', () => {
    const failure = expectFailure(compileTextScene(`[${SCENE_JSON}]`, 's'));
    expect(failure.stage).toBe('extract');
    expect(failure.code).toBe('scene_payload_array');
  });

  it('reports a non-text input as an extraction failure without throwing', () => {
    for (const input of [null, undefined, 7, true]) {
      const failure = expectFailure(compileTextScene(input, 's'));
      expect(failure.stage).toBe('extract');
      expect(failure.code).toBe('scene_text_not_string');
    }
  });

  it('carries no source for a failure that never reached the scan', () => {
    const failure = expectFailure(compileTextScene(null, 's'));
    expect(failure.source).toBeUndefined();
  });
});

describe('compileTextScene — validation failures', () => {
  it('refuses a scene with a canvas over the edge limit', () => {
    const payload = JSON.stringify({
      canvas: { width: 100000, height: 64 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 0, cy: 0, r: 1 }] }],
    });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_invalid_canvas');
  });

  it('refuses a scene whose layer has no shapes', () => {
    const payload = JSON.stringify({
      canvas: { width: 64, height: 64 },
      layers: [{ id: 'empty', shapes: [] }],
    });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_layer_invalid');
  });

  it('refuses a scene with no layers at all', () => {
    const payload = JSON.stringify({ canvas: { width: 64, height: 64 }, layers: [] });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_no_layers');
  });

  it('refuses an undeclared gradient reference', () => {
    const payload = JSON.stringify({
      canvas: { width: 64, height: 64 },
      layers: [
        {
          id: 'a',
          shapes: [{ kind: 'rect', x: 0, y: 0, width: 8, height: 8, fill: 'url(#nope)' }],
        },
      ],
    });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_gradient_undeclared');
  });

  it('refuses a data: URL smuggled into a paint field', () => {
    const payload = JSON.stringify({
      canvas: { width: 64, height: 64 },
      layers: [
        {
          id: 'a',
          shapes: [
            {
              kind: 'rect',
              x: 0,
              y: 0,
              width: 8,
              height: 8,
              fill: 'url(data:image/svg+xml,<svg onload=alert(1)>)',
            },
          ],
        },
      ],
    });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_paint_invalid');
  });

  it('refuses a shape with an out-of-bound coordinate', () => {
    const payload = JSON.stringify({
      canvas: { width: 64, height: 64 },
      layers: [{ id: 'a', shapes: [{ kind: 'circle', cx: 9e9, cy: 0, r: 1 }] }],
    });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_shape_invalid');
  });

  it('refuses a shape kind outside the protocol vocabulary', () => {
    const payload = JSON.stringify({
      canvas: { width: 64, height: 64 },
      layers: [{ id: 'a', shapes: [{ kind: 'script', cx: 0, cy: 0, r: 1 }] }],
    });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_shape_invalid');
  });

  it('refuses markup hidden in a shape kind and never evaluates it', () => {
    const payload = JSON.stringify({
      canvas: { width: 64, height: 64 },
      layers: [
        {
          id: 'a',
          shapes: [{ kind: '<script>alert(1)</script>', x: 0, y: 0, width: 1, height: 1 }],
        },
      ],
    });
    const failure = expectFailure(compileTextScene(payload, 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.code).toBe('scene_shape_invalid');
    // The bad kind is named as an unrecognised discriminant. That is `normalizeScene`'s existing
    // behaviour and is safe here only because the reason never reaches a document — the payload
    // was refused, so no serialization happens. Asserted as a property of the *result*: there is
    // no svg, and the compiler did not fall back to drawing anything.
    expect(failure).not.toHaveProperty('svg');
  });

  it('never emits a document for a refused payload', () => {
    // The invariant that makes the verbose reason strings safe: a rejected scene produces no
    // output at all, so untrusted text can never be interpolated into markup.
    const payload = JSON.stringify({
      canvas: { width: 64, height: 64 },
      layers: [{ id: 'a', shapes: [{ kind: '<img src=x onerror=alert(1)>' }] }],
    });
    const result = compileTextScene(payload, 's');
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('svg');
    expect(result).not.toHaveProperty('frames');
    expect(result).not.toHaveProperty('scene');
  });

  it('reports the source alongside a validation failure so a transport bug is visible', () => {
    const payload = JSON.stringify({ canvas: { width: 100000, height: 64 }, layers: [] });
    const failure = expectFailure(compileTextScene([{ type: 'text', text: payload }], 's'));
    expect(failure.stage).toBe('validate');
    expect(failure.source).toBe('content_parts_text');
    expect(failure.extractedLength).toBe(payload.length);
  });

  it('discriminates a validation failure from an extraction one via the helper', () => {
    const badScene = JSON.stringify({ canvas: { width: 100000, height: 64 }, layers: [] });
    expect(isValidationFailure(compileTextScene(badScene, 's'))).toBe(true);
    expect(isValidationFailure(compileTextScene('prose', 's'))).toBe(false);
    expect(isValidationFailure(compileTextScene(SCENE_JSON, 's'))).toBe(false);
  });
});

describe('compileTextScene — scene id handling', () => {
  it('refuses an empty scene id at stage input, blaming the caller not the model', () => {
    const failure = expectFailure(compileTextScene(SCENE_JSON, ''));
    expect(failure.stage).toBe('input');
    expect(failure.code).toBe('scene_id_invalid');
  });

  it('refuses an over-long scene id', () => {
    const failure = expectFailure(compileTextScene(SCENE_JSON, 'x'.repeat(129)));
    expect(failure.stage).toBe('input');
  });

  it('checks the id before reading the payload, so a bad id fails fast', () => {
    // The payload is prose, which would otherwise fail at extraction.
    const failure = expectFailure(compileTextScene('not json', ''));
    expect(failure.stage).toBe('input');
  });
});

describe('compileTextScene — the frame sequence', () => {
  it('emits layers + 1 frames, placeholder first', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    expect(result.frames).toHaveLength(result.scene.layers.length + 1);
    expect(result.frames[0].index).toBe(0);
    expect(result.frames[0].layerId).toBeNull();
    expect(result.frames[0].progress).toBe(0);
    expect(result.frames[0].layerName).toBe('canvas');
  });

  it('reports the upstream index shape unchanged: layer frames run 0..N-1, total counts layers', () => {
    // `renderSceneFrames` emits the placeholder with `index: 0` and then layer frames numbered
    // `0..N-1`, so `index` is deliberately NOT unique across the sequence. The compiler passes
    // that through rather than renumbering, because renumbering would make a compiled stream
    // disagree with one built by calling `renderSceneFrames` directly.
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    expect(result.frames.map((frame) => frame.index)).toEqual([0, 0, 1]);
    expect(result.frames.map((frame) => frame.total)).toEqual([2, 2, 2]);
    expect(result.frames.map((frame) => frame.layerId)).toEqual([null, 'sky', 'sun']);
  });

  it('leaves the placeholder as the only frame with a null layerId, so it stays addressable', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const nulls = result.frames.filter((frame) => frame.layerId === null);
    expect(nulls).toHaveLength(1);
    expect(nulls[0]).toBe(result.frames[0]);
  });

  it('ends the sequence on the finished picture, at progress 1 with every layer present', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const last = result.frames[result.frames.length - 1];
    expect(last.progress).toBe(1);
    expect(last.svg).toContain('id="sky"');
    expect(last.svg).toContain('id="sun"');
  });

  it('adds exactly one layer per non-placeholder frame, in scene order', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    expect(result.frames[1].layerId).toBe('sky');
    expect(result.frames[2].layerId).toBe('sun');
  });

  it('addresses every frame by sceneId and index, so a client can resume', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 'scene_abc'));
    expect(result.frames.map((frame) => frame.id)).toEqual([
      'scene_abc:0',
      'scene_abc:0',
      'scene_abc:1',
    ]);
  });

  it('grows the drawn layer count monotonically, which is what a progress bar needs', () => {
    // `index` is not unique across the sequence (the placeholder and the first layer both report
    // 0), and the wire event carries no `shapeCount`. So the monotone signal a client can rely on
    // is the number of `<g>` groups in each frame's own SVG — asserted here against the scene's
    // layer order so a change that emitted frames out of order fails loudly.
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const drawn = result.frames.map((frame) => (frame.svg.match(/<g id=/g) ?? []).length);
    expect(drawn).toEqual([0, 1, 2]);
    for (let i = 1; i < drawn.length; i += 1) {
      expect(drawn[i]).toBeGreaterThanOrEqual(drawn[i - 1]);
    }
  });

  it('carries the protocol version, mime and the non-diffusion marker on every frame', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    for (const frame of result.frames) {
      expect(frame.event).toBe(FRAME_EVENT_NAME);
      expect(frame.mime).toBe(PROGRESSIVE_MIME);
      expect(frame.protocolVersion).toBe(PROGRESSIVE_PROTOCOL_VERSION);
      expect(frame.diffusion).toBe(false);
    }
  });

  it('paints the placeholder as the bare canvas, so a client can reserve layout immediately', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const zero = result.frames[0];
    expect(zero.width).toBe(64);
    expect(zero.height).toBe(64);
    expect(zero.svg).not.toContain('<g id=');
  });

  it('gives every frame a complete document the engine gate accepts', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    for (const frame of result.frames) {
      const verdict = validateSvg(frame.svg);
      expect(verdict.ok, `frame ${frame.index} refused: ${verdict.ok ? '' : verdict.reason}`).toBe(
        true,
      );
    }
  });

  it('includes earlier layers in each later frame, so a frame is a real picture', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    expect(result.frames[1].svg).toContain('id="sky"');
    expect(result.frames[1].svg).not.toContain('id="sun"');
    expect(result.frames[2].svg).toContain('id="sky"');
    expect(result.frames[2].svg).toContain('id="sun"');
  });

  it('carries a data URI whose bytes match the inline document, so a client can paint either', () => {
    // The wire event has no `byteLength` field — that lives on the assembled `ProgressiveFrame`.
    // What it does carry is both renderings of the same document, and the base64 must decode back
    // to exactly the inline SVG or a client uses one and gets a different picture than another.
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    for (const frame of result.frames) {
      expect(frame.dataUri.startsWith(`data:${PROGRESSIVE_MIME};base64,`)).toBe(true);
      const encoded = frame.dataUri.slice(`data:${PROGRESSIVE_MIME};base64,`.length);
      expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(frame.svg);
    }
  });

  it('reports a byteLength on the finalFrame matching its own document', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    expect(result.finalFrame.byteLength).toBe(Buffer.byteLength(result.finalFrame.svg, 'utf8'));
  });
});

describe('compileTextScene — the three views of the final picture', () => {
  it('produces a final SVG identical to the last frame of the stream', () => {
    // Three views of the same picture: the top-level `svg`, the `finalFrame`, and the tail of
    // `frames`. A caller reading any one of them must get the same bytes.
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const last = result.frames[result.frames.length - 1];
    expect(result.svg).toBe(last.svg);
    expect(result.finalFrame.svg).toBe(result.svg);
    expect(result.finalFrame.byteLength).toBe(result.svg.length);
    expect(result.finalFrame.layerId).toBe(last.layerId);
  });

  it('reports a finalFrame that is structurally a ProgressiveFrame', () => {
    const result = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    // Narrow via the discriminant: `layerId` is `null` only on the placeholder, and a valid
    // scene always has at least one layer, so the final frame must carry a real layer id.
    const frame: ProgressiveFrame | ProgressiveFrameZero = result.finalFrame;
    expect(typeof frame.layerId).toBe('string');
  });

  it('reports a single-layer scene at progress 1 rather than dividing by zero', () => {
    const single = JSON.stringify({
      canvas: { width: 8, height: 8 },
      layers: [{ id: 'only', shapes: [{ kind: 'circle', cx: 4, cy: 4, r: 2 }] }],
    });
    const result = expectSuccess(compileTextScene(single, 's'));
    expect(result.frames).toHaveLength(2);
    expect(result.finalFrame.progress).toBe(1);
  });
});

describe('compileTextScene — deterministic final SVG', () => {
  it('produces byte-identical output for the same reply compiled twice', () => {
    const first = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const second = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    expect(second.svg).toBe(first.svg);
    expect(second.frames).toEqual(first.frames);
    expect(second.statistics).toEqual(first.statistics);
  });

  it('produces byte-identical output across all three reply spellings', () => {
    // The svg must not depend on how the reply arrived. If it did, a cache keyed on the scene
    // would miss whenever a transport changed its envelope.
    const viaString = expectSuccess(compileTextScene(SCENE_JSON, 's')).svg;
    const viaFence = expectSuccess(compileTextScene('```json\n' + SCENE_JSON + '\n```', 's')).svg;
    const viaParts = expectSuccess(compileTextScene([{ type: 'text', text: SCENE_JSON }], 's')).svg;
    expect(viaFence).toBe(viaString);
    expect(viaParts).toBe(viaString);
  });

  it('carries no clock or randomness into the document', () => {
    // A generated timestamp or nonce would make two compiles differ. Asserted by compiling the
    // same reply twice with a real clock running in between.
    const first = expectSuccess(compileTextScene(SCENE_JSON, 's')).svg;
    const second = expectSuccess(compileTextScene(SCENE_JSON, 's')).svg;
    expect(first).toBe(second);
    // And the document does not merely happen to match — it contains nothing timestamp-shaped.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the frame sequence identical when the reply has surrounding prose', () => {
    const bare = expectSuccess(compileTextScene(SCENE_JSON, 's'));
    const narrated = expectSuccess(compileTextScene(`Here: ${SCENE_JSON} — hope that helps!`, 's'));
    expect(narrated.frames).toEqual(bare.frames);
  });

  it('compiles an already-extracted candidate identically to the raw reply', () => {
    // Cross-checks the join: the compiler accepts either a raw reply or an object that extraction
    // already handed over, and both routes must reach the same picture. An object input is not
    // a regressive case — `compileTextScene` is called with the candidate by any caller that
    // wanted to inspect extraction before drawing.
    const viaReply = expectSuccess(compileTextScene(SCENE_JSON, 's'));

    const extracted = extractSceneCandidate(SCENE_JSON);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const viaCandidate = expectSuccess(compileTextScene(extracted.candidate, 's'));

    expect(viaCandidate.svg).toBe(viaReply.svg);
    expect(viaCandidate.frames).toEqual(viaReply.frames);
  });
});

describe('compileTextScene — totality', () => {
  it('never throws, whatever it is handed', () => {
    const corpus: unknown[] = [
      '',
      '   ',
      '{',
      '}',
      '[]',
      '[',
      '{"canvas":',
      '```',
      '```json\n',
      'plain prose',
      null,
      undefined,
      0,
      -1,
      NaN,
      Infinity,
      true,
      Symbol('x'),
      Buffer.from(SCENE_JSON),
      { canvas: {}, layers: [] },
      new Date(0),
      [[SCENE_JSON]],
      [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
    ];
    for (const input of corpus) {
      expect(() => compileTextScene(input, 's')).not.toThrow();
    }
  });

  it('never throws on a hostile scene id', () => {
    for (const id of ['', 'x'.repeat(1000), 'a'.repeat(129)]) {
      expect(() => compileTextScene(SCENE_JSON, id)).not.toThrow();
    }
  });

  it('returns a stable code rather than an exception for every failure', () => {
    const cases: Array<[unknown, string]> = [
      ['prose', 'scene_payload_prose'],
      ['{"canvas":', 'scene_json_truncated'],
      ['[{}]', 'scene_payload_array'],
      [null, 'scene_text_not_string'],
    ];
    for (const [input, code] of cases) {
      const failure = expectFailure(compileTextScene(input, 's'));
      expect(failure.code).toBe(code);
      expect(typeof failure.reason).toBe('string');
      expect(failure.reason.length).toBeGreaterThan(0);
    }
  });

  it('never leaks the model payload into an *extraction* failure reason', () => {
    // Extraction reads untrusted text before anything has been validated, so its reason strings
    // are the ones that could echo a payload. Asserted for the extraction stage specifically,
    // because a validation reason may legitimately name a *field* the model got wrong — that is
    // bounded, structural text, and the payload was already refused by then.
    const marker = 'IGNORE-ALL-PREVIOUS-INSTRUCTIONS';
    const inputs: unknown[] = [
      marker,
      `${marker}{`,
      `${marker}\n\`\`\`json\n{"a":\n\`\`\``,
      `[{"type":"text","text":"${marker}"}]`,
    ];
    for (const input of inputs) {
      const result = compileTextScene(input, 's');
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.stage).toBe('extract');
      expect(result.reason).not.toContain(marker);
    }
  });
});
