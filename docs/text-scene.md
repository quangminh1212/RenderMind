# Compiling a text scene

`docs/progressive-rendering.md` covers what a scene *is*: a declarative object of typed geometry,
validated by `src/platform/progressive/scene.ts` and assembled into frames. This page covers the
step before that — how a **text-only chat response becomes a scene payload in the first place**.

That step is real work, and it is where most of the failure modes live. A chat model has no
structured-output guarantee, so the same logical scene arrives as a bare JSON string, as a fenced
block surrounded by narration, or wrapped in a chat content-parts array. It also arrives, often,
as none of those: as prose, as a truncated token stream, or as a scene whose geometry is out of
bounds. The compiler's job is to sort all of that into either a picture or a stable reason.

The implementation is `src/platform/text-scene/`.

## The two stages

    text-scene/extract.ts    is there a JSON object in this reply, and what shape was the reply?
    text-scene/compile.ts    run that object through the scene gate, or refuse it

The split is a trust boundary, not a filing convention. `extract` is the only code that touches
the raw reply, and its output type is `Record<string, unknown>` — which does **not** compile as an
argument to `serializeSceneToSvg` or `assembleFrames`. The only route from a reply to a frame is
`compileTextScene`, which cannot skip `normalizeScene`. That is the same brand-based argument
`types/progressive.types.ts` makes for `NormalizedScene`, applied one stage further out.

## The three spellings

All three normalize to the same thing — a bounded slice of text that either parses to a JSON
object or does not.

**Bare JSON.** The model emitted only the object. The happy path.

    {"canvas":{"width":1024,"height":768},"layers":[{"id":"sky","shapes":[…]}]}

**A fenced block.** The common case in practice, because a model told to "reply with a scene"
often narrates that it is doing so.

    Certainly! Here is the scene:

    ```json
    {"canvas":{"width":1024,"height":768},"layers":[…]}
    ```

    Let me know if you want changes.

**Chat content parts.** Not text at all, and the reason a regex over a string is not sufficient.

    [{"type":"text","text":"Here you go:"},
     {"type":"text","text":"```json\n{…}\n```"}]

Content parts are concatenated in order with a newline separator, so a fence split across two
parts — which a streaming transport can genuinely produce — still delimits correctly. Image parts
are skipped entirely: a scene compiler reads text, and a base64 blob is neither a scene nor worth
scanning for braces.

An already-parsed object is also accepted. That is not a convenience: it lets a caller inspect the
candidate before deciding to draw it, and hand it straight back, without a serialize/re-parse
round trip that the two routes could diverge over.

### Fences are preferred, and why that matters

The fence is matched **before** the character scan, because it is an explicit delimiter: the model
marked that region as "here is the artifact", and the prose around it is commentary. Without that
preference, a reply like

    I will use {"type":"x"} as the envelope.
    ```json
    {…the real scene…}
    ```

would be scanned to the *first* brace — the one in the sentence — and parse to the decoration
rather than the scene. The info string is deliberately not inspected: `json`, `JSON`, or a stray
language tag all describe a body that is scanned the same way, and refusing a block because the
model labelled it `javascript` would reject a good scene over a cosmetic mismatch. The JSON
parser is the only authority on whether the body is JSON.

## Balanced scanning, not first-to-last

Once a region is chosen, the compiler walks it once tracking bracket depth and string state, and
stops at the bracket that closes what it opened. `JSON.parse` receives *exactly that slice* — never
a slice from the first `{` to the last `}`.

The one-liner version is wrong for a specific, observable reason. A model legitimately emits prose
containing braces:

    Use {"type":"circle"} for a circle. Here is the scene: {"canvas":…}

A first-to-last slice spans the sentence *and* the object, and the resulting parse failure reads as
"the model emitted malformed JSON" — when in fact it emitted perfectly good JSON inside a sentence.
Balanced scanning removes that class of misdiagnosis, and it also keeps a `{` inside a string
(a layer named `Sky { Sea`) or an escaped quote from being counted as structure.

## The result, and why there are three outcomes

    compileTextScene(reply, sceneId) →
      { ok: true,  scene, svg, finalFrame, frames, source, statistics }
      { ok: false, stage: 'input'    | 'extract' | 'validate', code, reason, … }

A success carries four related things, and the redundancy is deliberate:

| Field | What it is | Who wants it |
|---|---|---|
| `scene` | The validated `NormalizedScene` | A cache or a layer that wants to re-render later |
| `svg` | The **final** frame: a complete standalone document | The rasterizer, and a client that only wants the finished picture |
| `finalFrame` | That frame's metadata and document | A caller reporting progress or size |
| `frames` | Every `ProgressiveFrameEvent`, placeholder first | The transport |

Each of the three consumers would otherwise re-derive what the compiler already had in hand, and
returning one while making the others re-run the pipeline is how the paths drift apart — one of
them eventually forgets to validate, and the drift is invisible until it is exploitable.

A single `ok: false` with a merged code would be simpler and worse. The two failure families imply
different caller behaviour:

- **`stage: 'extract'`** — no JSON object in the reply. Prose, a truncated token stream, an
  oversized payload, an image-only reply. Nothing scene-shaped was attempted, so retrying the same
  way reproduces it.
- **`stage: 'validate'`** — a JSON object was found, and it is not a drawable, safe scene. Bad
  geometry, an undeclared gradient, a canvas over the edge limit, a `data:` URL smuggled into a
  paint field. A scene *was* attempted; this is frequently a prompt-size or coordinate-scaling
  problem that a different request fixes.

Collapsing them would force every caller to pattern-match on code strings to recover a distinction
the compiler already knew.

## Frame indices

`frames` is passed through from `renderSceneFrames` unchanged, and that sequence has a shape worth
stating because it is not what a cursory read suggests. A scene of *N* layers yields **N + 1**
frames:

    frames[0]      the placeholder:  index: 0, layerId: null, shapeCount: 0
    frames[1..N]   the layer frames: index: 0 .. N-1, total: N

So `index` is **not unique** across the sequence — the placeholder and the first layer both report
`index: 0` — and `total` counts layers, not frames. The compiler does not rewrite this. Renumbering
here would make a compiled stream disagree with one built by calling `renderSceneFrames` directly,
which is exactly the drift described above. A client disambiguates the placeholder by
`layerId === null`.

`finalFrame` is therefore `frames[N]`, the frame that introduced the last layer.

## Bounds, and what is deliberately not done

**No repair.** A payload with a trailing comma, single-quoted keys, or a Python `None` is refused
rather than massaged into validity. Two reasons, and the second is the important one. A repair
heuristic is a parser, and every parser is a bug surface. And *a model that produced almost-JSON
has demonstrated it cannot produce JSON* — it will produce almost-JSON again on the next attempt.
Accepting it silently converts a bounded refusal into unbounded downstream ambiguity: which key did
the repair guess, and did the caller get the scene it asked for?

**No evaluation.** Nothing here is handed to `eval`, `new Function`, or a template engine. A scene
is data, and the only interpreter that ever touches it is `JSON.parse`.

**No unbounded parse.** Text is bounded before the parser sees it. `JSON.parse` on a multi-megabyte
string is a denial-of-service lever and the whole reply is held in memory regardless. An oversized
reply is *refused*, not truncated — truncation would produce a JSON prefix that is almost valid, and
the resulting error would point at the truncation rather than at the oversized reply.

**No rasterization.** PNG and JPEG have no progressive story, so a caller producing a bitmap wants
the finished picture. `svg` is exactly that, and the provider rasterizes it. Rasterizing here would
put a native dependency in the platform layer's reach and force every streaming caller to pay for a
render it will never use.

**No security decision.** Extraction classifies *shape*; it never judges *safety*. The object it
returns is a candidate, the type says so, and the scene gate is the only thing that decides whether
a candidate may be drawn.

## Failure codes

Stable and client-visible, in the same spirit as `SceneRejectionCode`.

| Code | Stage | Meaning |
|---|---|---|
| `scene_id_invalid` | input | The caller-assigned scene id is empty or over 128 characters |
| `scene_text_not_string` | extract | The reply is not text, a content-part array, or an object (e.g. a `Buffer`) |
| `scene_text_too_long` | extract | The reply exceeds the input bound, or the located region exceeds it |
| `scene_payload_prose` | extract | Text was read and no JSON region ever opened |
| `scene_json_truncated` | extract | A region opened and the text ended before it closed — a token-limit cut |
| `scene_json_malformed` | extract | A region closed, but its content is not JSON |
| `scene_payload_array` | extract | A region parsed to an array; a list of candidates is refused, not guessed at |
| `scene_*` (from `scene.ts`) | validate | The scene gate refused the payload; see `docs/error-taxonomy.md` |

Reason strings name the defect and **never echo the payload**. A reason reaches logs and sometimes
an HTTP error body, and interpolating untrusted model output into either is how a prompt-injection
payload gets a second life as a log line somebody greps for.

## Testing

`tests/unit/platform/text-scene/` covers both stages:

- `extract.test.ts` — the three spellings, fence-over-prose preference, balanced scanning against
  braces in strings and escaped quotes, malformed and truncated payloads, arrays, prose, non-text
  inputs, the bounds, and a hostile-input corpus asserting totality and payload-free reasons.
- `compile.test.ts` — valid scenes through all three spellings, extraction-versus-validation stage
  attribution, unsafe geometry refused, deterministic byte-identical output, and the frame
  sequence's shape, ordering, ids and per-frame `validateSvg` acceptance.

Two properties are asserted rather than assumed, because they are the ones a plausible future
change would silently break: that the compiled `svg`, the `finalFrame` and the last stream frame
are byte-identical, and that two compiles of the same reply produce identical bytes.
