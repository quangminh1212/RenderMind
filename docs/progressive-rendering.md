# Progressive rendering

A chat-completions model cannot emit pixels, so the artifact it can honestly produce is one
it can *write out as text*. `docs/providers.md` covers that decision for a single finished
document. This page covers what happens when the drawing is large enough that producing it in
one shot is the wrong shape of problem.

## The problem this solves

A long SVG streamed token by token has no honest intermediate state. Until the last byte
arrives the document is either incomplete — nothing to draw — or complete but wrong. A client
showing it mid-flight is showing a half-parsed file, and a client waiting for the end is
showing nothing at all. Both are worse than a smaller picture delivered sooner.

The progressive track changes the unit of production from *a document* to **a layer**. Layers
arrive in back-to-front paint order; frame *N* is `layers[0..N]`. Every intermediate frame is
therefore a real, self-consistent picture with fewer details painted, which is the classic
progressive-render experience: shape first, then structure, then detail.

## The contract

Five facts hold for every scene, and a client may rely on all of them.

**1. A frame is a complete document.** Not a fragment. A client that missed every previous
event, or that only keeps the latest, can still render it. This costs bytes and buys
resilience: the stream has no hidden state that a dropped event would orphan.

**2. Frame assembly is a pure function of `(scene, index)`.** No clock, no randomness, no
accumulator between frames. Two calls with the same scene produce byte-identical frames. This
is why each frame is rebuilt from the scene prefix rather than appended to the previous frame
— the cheaper implementation would be O(N) instead of O(N²), but it would make a frame a
product of session history rather than a function of its inputs, and that would rule out
caching, replay and out-of-order delivery.

**3. Progress is explicit.** Every frame carries `index`, `total` and `progress`
(`index / (total - 1)`, so `0` at the first layer and `1` at the finished picture). A client
can drive a progress bar without knowing the layer count in advance.

**4. Layer ids are stable handles.** A later revision of the same scene can repaint the layer
whose id is `sky`, and a client can key its own state on that. Frame indices shift between
revisions; ids do not.

**5. Nothing here is diffusion.** `diffusion: false` on every event is not decoration. It is
the wire format stating plainly that a frame is an *assembly of authored geometry*, not a
sample from a generating-image model. See "What this is not" below.

## Protocol

A scene of *N* layers produces *N + 1* frames. Frame 0 is the bare canvas, so a client is told
the page dimensions before anything is painted on it and can reserve layout instead of
reflowing when the first layer lands.

    {
      "event": "frame",
      "id": "scn_7:2",
      "sceneId": "scn_7",
      "protocolVersion": 1,
      "index": 2,
      "total": 4,
      "progress": 0.6666666666666666,
      "layerId": "roof",
      "layerName": "Roof",
      "mime": "image/svg+xml",
      "dataUri": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i...",
      "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" ...>...</svg>",
      "width": 1024,
      "height": 768,
      "diffusion": false
    }

`id` is built for the SSE `id:` field, so a client that reconnects can resume from the last
frame it saw. `svg` and `dataUri` are both present because they suit different clients: an
`<img src>` wants the data URI, and a client that intends to keep or edit the document wants
the markup. Neither requires an extra fetch.

### Scene shape

    {
      "title": "A house",
      "canvas": { "width": 1024, "height": 768, "background": "#eef2f7" },
      "gradients": [
        { "kind": "linear", "id": "sky",
          "x1": 0, "y1": 0, "x2": 0, "y2": 768,
          "stops": [{ "offset": 0, "color": "#87ceeb" },
                    { "offset": 1, "color": "#ffffff" }] }
      ],
      "layers": [
        { "id": "sky",    "name": "Sky",    "shapes": [{ "kind": "rect", "x": 0, "y": 0,
                                                          "width": 1024, "height": 480,
                                                          "fill": "url(#sky)" }] },
        { "id": "house",  "name": "House",  "opacity": 0.95, "blend": "multiply",
          "shapes": [{ "kind": "rect", "x": 320, "y": 360, "width": 384, "height": 256,
                       "fill": "#8b5a2b" },
                     { "kind": "polygon",
                       "points": [{ "x": 256, "y": 360 }, { "x": 512, "y": 160 },
                                  { "x": 768, "y": 360 }],
                       "fill": "#b22222" }] }
      ]
    }

Shapes are `rect`, `circle`, `ellipse`, `line`, `polygon` and `path`. There is no `text`
element and no free-form attribute bag — each omission is deliberate, and both are covered
under "Security boundaries".

## Security boundaries

A scene is untrusted input that a downstream browser will draw. The gate is
`src/platform/progressive/scene.ts`, it is total (an input either becomes a `NormalizedScene`
or is refused with a stable code), and it is the **only** producer of that type. Everything
downstream assumes its output is safe and never re-checks — which is sound only because the
branded type makes the assumption unforgeable in the type system.

### Data, never code

The protocol is declarative: every layer field is a named value with a bounded domain. There
is no expression language, no scripting hook, and no path by which model-authored text is
evaluated. The worst a hostile scene can do is draw something ugly.

This is also why layers are **typed geometry rather than markup strings**. If a layer carried
an SVG fragment, assembly would produce a new document every frame and validation would have
to re-run on each one — and a layer could close the root element or open a `<script>`. With
typed geometry there is no markup to be well- or ill-formed: serialization only ever writes
elements it named itself, so it is structurally incapable of emitting an unsafe document.

### The three classes of text, and how each is handled

| Field | Treatment | Why |
|---|---|---|
| Attribute values (paint, ids, numbers) | Validated against a closed pattern | Hex colours, strict identifiers, finite bounded numbers. Nothing outside the pattern reaches the writer, so there is nothing to escape. |
| Text content (`title`, layer `name`) | XML-escaped at serialization | Arbitrary model text that is legitimately allowed to contain `&`, `<`, quotes. Escaping is applied on the way out, so a call site cannot forget it. |
| Path data (`d`) | Validated by grammar, emitted verbatim | An escaped path is a broken drawing. The accepted sublanguage excludes `&`, `<`, `>`, quotes entirely — none are path syntax — which is what makes verbatim emission safe. |

Identifier and paint patterns are deliberately narrow. Layer and gradient ids are written into
the document as element ids and `url(#id)` references, so they are the one class of string
emitted without escaping; confining them to `[A-Za-z0-9]` first then `[A-Za-z0-9_.:-]` means no
id can contain a quote, an angle bracket or whitespace, and the escape-or-validate question
does not arise. Paint is hex or `none` (or an in-document gradient reference) rather than a
permissive "not obviously dangerous" test, because every additional CSS colour spelling is
another parser to reason about.

### Refusals

The gate refuses, with a stable code: unknown shape kinds; non-finite or out-of-bounds
coordinates; oversized canvases and layer counts; duplicate layer or gradient ids; gradients
with fewer than two stops; **undeclared gradient references** (SVG treats an unresolvable
`url()` as a rendering error and renderers disagree on the fallback); `data:` and external
URLs in any paint field; zero-length lines; degenerate paths; and more than
`MAX_LAYERS`/`MAX_SHAPES_PER_LAYER` of anything.

Text is bounded but never content-filtered. A layer named `Sky & Sea` is not an attack, and
rejecting it would be the wrong trade — so it is escaped rather than refused.

### Bounds

Every loop and array has an explicit ceiling, because "how many" is a number a model chose and
a model can choose an enormous one. `MAX_LAYERS` 64, `MAX_SHAPES_PER_LAYER` 256,
`MAX_GRADIENTS` 32, `MAX_GRADIENT_STOPS` 16, `MAX_COORDINATE` 100000, `MAX_CANVAS_EDGE` 8192.
Every frame is asserted to stay under the engine-wide `MAX_SVG_BYTES` ceiling.

### What the path grammar excludes

Path data is the one field emitted without escaping, so it is validated by grammar rather than
by pattern-matching for known-bad substrings. Excluded, and why: a leading `data:`/`javascript:`
is unreachable (the first token must be a command letter); arcs (`A`) and smooth curves are
excluded because their arity and flag-packing rules are a genuine bug surface and cubics
approximate them; implicit repeated commands are excluded so argument counts are never
ambiguous.

### The load-bearing test

The acceptance criterion is not "does the output look like SVG" but **does `platform/svg`'s
own `validateSvg` accept it**. The progressive path must not be able to produce a document the
rest of the engine would refuse. `serialize.test.ts` routes frames through that gate, and one
case goes as far as `rasterizeSvgToPng` to prove the document is something a real renderer can
draw. Escaping hostile text is asserted to leave a document that still passes — escaping must
make the payload inert, not merely hide it.

## What is not true pixel-level diffusion

The rendering is **geometry authoring, not sampling**. Concretely:

- **No pixels are generated.** A frame is vector geometry; rasterization is a separate,
  optional step (`platform/svg`) and does not happen here.
- **No noise, no denoising, no iterative refinement.** A frame is an exact recomputation of a
  prefix of authored data. There is no sampler, no scheduler, no step count.
- **A seed is not a diffusion seed.** `scene.seed` exists so a caller can ask for "the same
  picture, differently jittered". It is consumed during normalization and turned into
  geometry; assembly never consults it, which is what keeps frames reproducible. A diffusion
  seed requests statistical similarity; this seed, being data the scene carries, cannot affect
  assembly at all.
- **Frame count is layer count, not a quality/time dial.** There is no "20 steps" — the number
  of frames is however many layers the model authored.
- **Later frames add detail; they never revise earlier geometry.** Each frame is a superset of
  the last. A diffusion preview refines the whole canvas each step, so an early preview can be
  visibly *wrong* rather than merely *coarse*. This cannot happen here, and that is the
  property that makes an intermediate frame safe to show.

The honest summary: this is a **deterministic, declarative scene compositor with incremental
reveal**. It is progressive rendering in the sense of progressive *delivery* of an authored
drawing, not progressive *generation* of an image.

## Integration hooks

The renderer stops at the wire payload; it does not deliver. That boundary is deliberate —
nothing in this module knows about HTTP, SSE or a socket, which is what lets the same frame
sequence travel over any of them.

**The normal path** validates, assembles and wraps in one call:

```ts
import { renderSceneFrames, toFrameEvent } from '@/platform/progressive';

const result = renderSceneFrames(rawModelOutput, sceneId);
if (!result.ok) return res.status(422).json({ error: result.reason });

for (const frame of result.frames) {
  res.write(`event: ${FRAME_EVENT_NAME}\n`);
  res.write(`id: ${toFrameEvent(result.scene, frame).id}\n`);
  res.write(`data: ${JSON.stringify(toFrameEvent(result.scene, frame))}\n\n`);
}
```

**The streaming path** validates once and builds frames lazily, which is what an SSE handler
actually wants — no need to hold *N* documents in memory:

```ts
const validation = normalizeScene(rawModelOutput, sceneId);
if (!validation.ok) return reject(validation);

// Frame 0 first, so the client can size its viewport immediately.
emit(toFrameEvent(validation.scene, buildFrameZero(validation.scene)));
for (let index = 0; index < validation.scene.layers.length; index += 1) {
  emit(toFrameEvent(validation.scene, buildFrame(validation.scene, index)));
}
```

**What a transport worker needs to provide:** an SSE or WebSocket endpoint that writes the
`ProgressiveFrameEvent` objects, and a policy for how many frames to emit (one per layer, as
above) and whether to coalesce fast layers. Nothing in the payload requires a transport
feature beyond text framing.

**To rasterize a finished frame** — for a client that wants a PNG — pass the final frame's
`svg` to `rasterizeSvgToPng` from `platform/svg`. Frames are already validated documents, so
they satisfy that function's precondition directly.

## Files

| Path | Responsibility |
|---|---|
| `src/types/progressive.types.ts` | The scene, frame and event types, plus every bound |
| `src/platform/progressive/scene.ts` | The security boundary: validation and normalization |
| `src/platform/progressive/serialize.ts` | Typed geometry → SVG document, with escaping |
| `src/platform/progressive/frames.ts` | Frame assembly and transport wrapping |
| `src/platform/progressive/index.ts` | Public surface |
| `tests/unit/platform/progressive/` | 164 cases across `scene`, `serialize` and `frames` |

Not modified by this work: any provider, adapter, engine, config, package or shared test file.
No dependencies were added.
