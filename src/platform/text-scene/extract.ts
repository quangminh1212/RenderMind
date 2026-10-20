/**
 * Scene extraction — turning a chat model's reply into a candidate scene payload.
 *
 * This module answers one question: **is there a JSON object in this text that claims to be a
 * picture?** It answers nothing else. It does not decide whether the object is drawable, safe,
 * or well-formed as a scene; that is `scene.ts`'s gate, and keeping the two apart is the whole
 * reason this file exists separately. Extraction is about *finding*; validation is about
 * *trusting*, and a module that did both would tempt its caller into treating "found" as
 * "safe".
 *
 * A chat model has no structured-output guarantee, so the same logical scene arrives in one of
 * three spellings:
 *
 *   1. A bare JSON string — the model emitted only the object, the happy path.
 *   2. A fenced block — ` ```json {…} ``` `, usually with a sentence of prose around it. This
 *      is the common case in practice, because a model that has been told to "reply with a
 *      scene" will often narrate that it is doing so.
 *   3. Chat content parts — the openclaw-shaped `[{type:'text', text:'…'}, {type:'image_url',…}]`
 *      array. Not text at all, and the reason a plain regex over a string is not sufficient.
 *
 * All three normalize to the same thing: a slice of text, bounded, that either parses to a
 * JSON object or does not. Everything after that is downstream.
 *
 * ## What is deliberately not done here
 *
 * **No repair.** A payload with a trailing comma, a Python `True`, or single-quoted keys is
 * refused rather than massaged into validity. Two reasons, and the second is the important
 * one. First, a repair heuristic is a parser, and every parser is a bug surface. Second — and
 * this is the design rule the rest of the module follows — *a model that produced almost-JSON
 * has demonstrated it cannot produce JSON*, and it will produce almost-JSON again on the next
 * attempt. Accepting it silently converts a bounded refusal into unbounded downstream
 * ambiguity: which key did the repair guess, and did the caller get the scene it asked for?
 * The refusal names the defect instead.
 *
 * **No evaluation.** Nothing here is ever handed to `eval`, `new Function`, or a template
 * engine. A scene is data, and the only interpreter that ever touches it is `JSON.parse`.
 * That is what makes it safe to run over untrusted model output, and it is a property worth
 * stating because "parse the model's reply" is exactly the kind of requirement that invites a
 * cleverer, unsafer implementation.
 *
 * **No unbounded parse.** `JSON.parse` on a multi-megabyte string is a denial-of-service lever
 * — quadratic on deeply nested input, and the whole reply is held in memory regardless. The
 * candidate text is bounded here, before the parser sees it, which is why the length checks
 * below are load-bearing rather than defensive decoration.
 *
 * ## Nothing in here is a security decision
 *
 * The object this module returns is a **candidate**, and the type says so (`SceneCandidate`,
 * never `SceneDocument`). A caller that fed it to `serializeSceneToSvg` would not compile. The
 * only way from a candidate to a frame is through `renderSceneFrames`, which validates first.
 */
import { MAX_SCENE_ID_LENGTH } from '../../types/progressive.types';

/**
 * Ceiling on the text this module will look at, in characters.
 *
 * A scene of 64 layers by 256 shapes is on the order of a few hundred kilobytes of JSON at the
 * absolute maximum the protocol permits, so a megabyte is comfortably above anything a
 * legitimate scene can be while still being far below "the model wrote an essay and this
 * process is now holding it". Text longer than this is not truncated — truncation would
 * produce a JSON prefix that is *almost* valid, and the resulting error message would point at
 * the truncation rather than at the oversized reply. It is refused, and the code says why.
 */
export const MAX_SCENE_TEXT_LENGTH = 1024 * 1024;

/**
 * How a reply may fail to yield a scene candidate.
 *
 * Each value is stable and client-visible, in the same spirit as `SceneRejectionCode`. The
 * distinction that matters to a caller is between the two families:
 *
 *   - **`scene_text_*`** — the text itself is unusable (too long, wrong type). The reply is not
 *     something this module can read as text at all.
 *   - **`scene_no_json_object` / `scene_json_*`** — text was read, and either no JSON region
 *     opened in it or the region that opened does not parse.
 *   - **`scene_payload_*`** — JSON *was* parsed, but the value is not a scene. The model
 *     attempted a picture and got the envelope wrong.
 *
 * A caller may reasonably retry the third family and should not retry the first, which is why
 * the codes are grouped and named rather than collapsed into one `scene_unparseable`.
 *
 * There is no `scene_payload_not_object`. A region that begins with `{` cannot parse to a
 * scalar, and a region that begins with `[` is reported as an array — so `not_object` would be
 * a code no input could reach, and an unreachable code in a union that callers branch on is
 * worse than no code at all.
 */
export type SceneExtractionCode =
  | 'scene_text_empty'
  | 'scene_text_not_string'
  | 'scene_text_too_long'
  | 'scene_no_json_object'
  | 'scene_json_truncated'
  | 'scene_json_malformed'
  | 'scene_payload_array'
  | 'scene_payload_prose';

export interface SceneExtractionFailure {
  ok: false;
  code: SceneExtractionCode;
  /**
   * Human-readable and safe to return to a caller: names the defect, never the payload.
   *
   * Deliberately never echoes the model's text. A reason string reaches logs and sometimes an
   * HTTP error body, and echoing untrusted model output into either is how a prompt-injection
   * payload gets a second life as a log line somebody greps for.
   */
  reason: string;
  /** Where the object came from, when one was found at all. Absent for the text-level failures. */
  source?: SceneExtractionSource;
}

export interface SceneExtractionSuccess {
  ok: true;
  /**
   * The parsed payload, already known to be a plain JSON object.
   *
   * A *candidate*, not a `SceneDocument`. Nothing about safety, bounds, or drawability has
   * been established — that is `normalizeScene`'s job, and it is the only function permitted
   * to accept this value as trustworthy.
   */
  candidate: Record<string, unknown>;
  /** Which spelling the object was found in, for logging and for a test to assert on. */
  source: SceneExtractionSource;
  /** Length of the text slice that was parsed, so a caller can see how much was read. */
  extractedLength: number;
}

export type SceneExtraction = SceneExtractionSuccess | SceneExtractionFailure;

/** The three spellings a scene arrives in, plus the fallback scan. */
export type SceneExtractionSource =
  'json_text' | 'fenced_json' | 'content_part' | 'content_parts_text';

// ─── Content-part handling ───────────────────────────────────

/** The content-part spellings a chat model's reply uses for prose. */
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);

/** The content-part type that carries an image, which a scene compiler never reads. */
const IMAGE_PART_TYPES = new Set(['image_url', 'image', 'input_image']);

/**
 * Whether a value is an array-shaped chat content part list.
 *
 * A shallow structural test, and intentionally so: this decides *how to read* a reply, not
 * whether to trust it. A payload that is an array of objects but not really content parts
 * simply yields no text, and lands on `scene_payload_array` below with an accurate reason.
 */
function isContentParts(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === 'object' && part !== null && !Array.isArray(part))
  );
}

/**
 * The text a content-part list carries, concatenated in order.
 *
 * Parts are joined with a newline rather than a space so that a fence split across two parts —
 * which a streaming transport can genuinely produce — still delimits correctly. Image parts
 * are skipped entirely: a scene compiler reads text, and a base64 blob is neither a scene nor
 * something worth scanning for braces.
 */
function textFromContentParts(parts: Array<Record<string, unknown>>): string {
  const chunks: string[] = [];
  for (const part of parts) {
    const type = part.type;
    if (type !== undefined && IMAGE_PART_TYPES.has(String(type))) continue;
    if (type !== undefined && !TEXT_PART_TYPES.has(String(type))) continue;
    if (typeof part.text === 'string') chunks.push(part.text);
  }
  return chunks.join('\n');
}

// ─── Candidate text ──────────────────────────────────────────

/**
 * The bounded text candidate, or the reason there is none.
 *
 * A tagged result rather than `string | null` because the failures are not interchangeable:
 * "the reply was not text" and "the reply was 40 MB of text" lead a caller to different
 * decisions, and a single null would flatten both into one unhelpful message.
 */
/**
 * Reduce any accepted reply shape to a bounded string of text, or an already-parsed object.
 *
 * The order of the branches is the preference order, and it is chosen so the most explicit
 * spelling wins: a bare string is unambiguous, a transport wrapper is next, and an already-parsed
 * object is last because it is the only input that skips this module's own work.
 *
 * The plain-object branch is not a convenience. It is what makes the compiler composable with
 * extraction: a caller that wants to log or inspect the candidate before deciding to draw it —
 * which is exactly what an operator-facing handler does — hands the `candidate` back to
 * `compileTextScene`, and refusing it would force that caller to re-serialize to JSON and
 * re-parse, which is pure ceremony and a place for the two routes to diverge.
 *
 * Accepting an object is *not* a trust decision. The value still goes through `normalizeScene`
 * unchanged; `candidate` is a `Record<string, unknown>` and carries no brand, so an object that
 * arrived this way is validated exactly as hard as one that came out of `JSON.parse`.
 */
type TextCandidate =
  | { ok: true; text: string; source: SceneExtractionSource }
  | { ok: true; parsed: Record<string, unknown>; source: SceneExtractionSource }
  | { ok: false; code: SceneExtractionCode; reason: string };

function toTextCandidate(input: unknown): TextCandidate {
  if (typeof input === 'string') {
    if (input.length > MAX_SCENE_TEXT_LENGTH) {
      return {
        ok: false,
        code: 'scene_text_too_long',
        reason:
          `Scene text is ${input.length} characters, over the ${MAX_SCENE_TEXT_LENGTH}-character ` +
          'limit. A legitimate scene does not approach this size; the reply is not one.',
      };
    }
    return { ok: true, text: input, source: 'json_text' };
  }

  if (isContentParts(input)) {
    const text = textFromContentParts(input);
    if (text.length > MAX_SCENE_TEXT_LENGTH) {
      return {
        ok: false,
        code: 'scene_text_too_long',
        reason:
          `Chat content parts carry ${text.length} characters of text, over the ` +
          `${MAX_SCENE_TEXT_LENGTH}-character limit`,
      };
    }
    return { ok: true, text, source: 'content_parts_text' };
  }

  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    // A Node `Buffer` is an object with integer-indexed keys, so it would otherwise be accepted as
    // a "parsed scene" and refused later as a scene with no canvas — a confusing code for what is
    // really a caller passing bytes where text was expected. Named here so the reason is accurate.
    if (Buffer.isBuffer(input) || ArrayBuffer.isView(input)) {
      return {
        ok: false,
        code: 'scene_text_not_string',
        reason:
          'Scene reply must be text, not raw bytes. Decode to a UTF-8 string before compiling ' +
          'so the JSON bound and the parse apply to the decoded text.',
      };
    }
    return { ok: true, parsed: input as Record<string, unknown>, source: 'json_text' };
  }

  return {
    ok: false,
    code: 'scene_text_not_string',
    reason:
      'Scene reply must be a JSON string, a fenced JSON block, a chat content-part array of ' +
      `text parts, or an already-parsed scene object; received ${describe(input)}`,
  };
}

/** Name a value's shape without echoing it. Never interpolates the value itself. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`;
  if (typeof value === 'string') return `a string of ${value.length} character(s)`;
  return `a ${typeof value}`;
}

// ─── Balanced-object scan ────────────────────────────────────

/** Failure shapes the character scan can produce. */
type ScanFailure = { kind: 'none' } | { kind: 'truncated' } | { kind: 'malformed'; detail: string };

/**
 * Scan for a balanced JSON region starting at the first `{` or `[`, and report why there is
 * none.
 *
 * The scan walks the text once, tracking bracket depth and string state, and stops at the
 * closing bracket of the same *kind* that opened the region. `JSON.parse` is then given exactly
 * that slice, never a slice from the first opener to the last closer.
 *
 * Why not "first `{` to last `}`", which is the one-liner this replaces? Because a chat model
 * legitimately emits prose containing braces — `Use {"type":"circle"} for a circle.` — and a
 * first-to-last slice over such a reply spans the sentence *and* the object, producing text that
 * fails to parse for a reason that has nothing to do with the scene. The observed failure then
 * reads as "the model emitted malformed JSON" when in fact the model emitted perfectly good JSON
 * inside a sentence. Balanced scanning removes that class of misdiagnosis.
 *
 * The array opener is scanned for rather than rejected outright, because the two array cases are
 * *different defects* and a caller needs to tell them apart: a bare `[…, …]` where a single scene
 * was asked for is indecision, while a content-part array reaching this function is a transport
 * bug. Both are refused downstream with distinct codes; this function's only job is to hand the
 * parser a region it can parse so the downstream classification can be accurate rather than
 * "the text did not parse".
 *
 * The two failure kinds are kept apart because they lead to different caller decisions. A
 * `truncated` scan means a bracket was still open when the text ended, which is what a
 * token-limit cut looks like and is worth a retry with a smaller scene. A `malformed` scan means
 * the region closed but the content is not JSON, which is a different defect.
 */
function scanObject(text: string): { json: string } | { failure: ScanFailure } {
  // The earliest opener wins, whichever kind it is, so the scan never skips past a malformed
  // fragment to find a later valid object and silently report success on the wrong thing.
  const openBrace = text.indexOf('{');
  const openBracket = text.indexOf('[');

  let start: number;
  let closing: string;
  if (openBrace === -1 && openBracket === -1) {
    return { failure: { kind: 'none' } };
  } else if (openBrace === -1) {
    start = openBracket;
    closing = ']';
  } else if (openBracket === -1) {
    start = openBrace;
    closing = '}';
  } else if (openBracket < openBrace) {
    start = openBracket;
    closing = ']';
  } else {
    start = openBrace;
    closing = '}';
  }

  // Brace depth only; brackets are tracked separately so `{"a":[1,2]}` closes on the right
  // character and a `]` inside an object cannot end the region early.
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth -= 1;
    } else if (character === ']') {
      bracketDepth -= 1;
    } else {
      continue;
    }

    if (braceDepth < 0 || bracketDepth < 0) {
      // Closers with nothing open: the opener we picked was itself the tail of something else.
      // Treated as "no region" rather than as malformed, because nothing was actually malformed
      // — we simply had not found the start of anything.
      return { failure: { kind: 'none' } };
    }

    // The region closes on the bracket that matches the opener, once nothing is nested inside.
    if (character === closing && braceDepth === 0 && bracketDepth === 0) {
      return { json: text.slice(start, index + 1) };
    }
  }

  // Ran out of text with something still open. A dangling escape or an unterminated string is
  // the same symptom as far as a caller is concerned: the region never closed.
  return { failure: { kind: 'truncated' } };
}

/**
 * The body of the first fenced code block in a reply, or `null` when there is none.
 *
 * Fences are matched before the character scan because a fence is an *explicit* delimiter: the
 * model marked that region as "here is the artifact", and prose around it is commentary. Without
 * this pass a reply like `I will use {"type":"x"} as the envelope.\n```json\n{…}\n``` ` would be
 * scanned to the *first* brace — the one in the sentence — and parse to the decoration rather
 * than to the scene. Preferring the fence is what makes the common narrated reply work.
 *
 * The info string is deliberately not inspected. `json`, `JSON`, `jsonc`, or a stray language tag
 * all describe a body that is scanned the same way, and rejecting a block because the model
 * labelled it `javascript` would refuse a perfectly good scene over a cosmetic mismatch. The
 * JSON parser is the only authority on whether the body is JSON.
 *
 * Unclosed fences are not treated as errors here. A model that opened a fence and never closed it
 * has produced a truncated reply; the region scan below finds the object inside the fence body
 * and, if the object itself is complete, the reply is accepted. If it is not, the scan reports
 * truncation — which is the accurate code for what is actually wrong.
 */
function firstFencedBody(text: string): string | null {
  // Non-greedy, so the block ends at the *next* fence rather than at the last one in the reply.
  // A model that emitted two blocks must not have them concatenated into one malformed body.
  const match = /```[^\n]*\n([\s\S]*?)```/.exec(text);
  if (match) return match[1];

  // An unclosed trailing fence: take everything after the opening line so the region scan can
  // still find a complete object inside it.
  const unclosed = /```[^\n]*\n([\s\S]*)$/.exec(text);
  return unclosed ? unclosed[1] : null;
}

/**
 * A one-line, payload-free description of where a JSON parse failed.
 *
 * V8's `SyntaxError.message` includes a position and, on newer runtimes, a short excerpt of
 * the offending text. The position is useful; the excerpt is model output and must not be
 * propagated. Only the numeric position is kept, and only when the message actually carries
 * one — this is a message-scraper, and it degrades to a generic line rather than throwing when
 * the format differs.
 */
function parseFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const position = /position (\d+)/.exec(message);
  if (position) return `JSON is not well-formed (parse failed at character ${position[1]})`;
  return 'JSON is not well-formed';
}

/**
 * Extract a scene candidate from a model reply.
 *
 * Total: every input produces either a candidate object or a stable failure. It never throws,
 * for the same reason `normalizeScene` does not — a compiler that throws on hostile input
 * hands the caller an exception to handle at a layer that has no business knowing about JSON,
 * and the code it produces is not stable enough to branch on.
 *
 * Pure and synchronous: no clock, no randomness, no I/O. Two calls with the same reply produce
 * deep-equal results, which is what makes the whole path testable as a table of
 * (reply → verdict).
 *
 * @param input A chat model's reply: a string, or a content-part array.
 */
export function extractSceneCandidate(input: unknown): SceneExtraction {
  const text = toTextCandidate(input);
  if (!text.ok) return { ok: false, code: text.code, reason: text.reason };

  // An already-parsed object skips both passes: there is nothing to find and nothing to parse.
  // It is classified exactly as a parsed region would be, so this route cannot accept a payload
  // the string route would have refused.
  if ('parsed' in text) {
    return classifyParsed(text.parsed, text.source, 0);
  }

  // Pass 1 — an explicit fence, which wins over anything the surrounding prose contains.
  const fenced = firstFencedBody(text.text);
  if (fenced !== null) {
    const fencedResult = parseRegion(fenced, 'fenced_json');
    if (fencedResult.ok) return fencedResult;
  }

  // Pass 2 — the balanced region in the text as a whole. Also reached when a fence was present
  // but its body yielded nothing, so a reply with a decorative fence and a real object outside
  // it is still read rather than refused on the strength of the fence alone.
  return parseRegion(text.text, text.source);
}

/**
 * Find, bound, parse and classify the JSON region in a piece of text.
 *
 * Split out of the entry point because the entry point runs it twice — once over a fenced body
 * and once over the whole reply — and two inline copies of a parse-with-fallthrough is where the
 * bound would eventually be applied on one path and not the other.
 */
function parseRegion(text: string, source: SceneExtractionSource): SceneExtraction {
  const scan = scanObject(text);
  if ('failure' in scan) {
    return scanFailureResult(scan.failure, source, text);
  }

  if (scan.json.length > MAX_SCENE_TEXT_LENGTH) {
    return {
      ok: false,
      code: 'scene_text_too_long',
      reason: `Scene JSON is ${scan.json.length} characters, over the limit`,
      source,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(scan.json);
  } catch (error) {
    return {
      ok: false,
      code: 'scene_json_malformed',
      reason: parseFailureDetail(error),
      source,
    };
  }

  return classifyParsed(parsed, source, scan.json.length);
}

/** Map a scan failure onto the code and reason a caller sees. */
function scanFailureResult(
  failure: ScanFailure,
  source: SceneExtractionSource,
  text: string,
): SceneExtractionFailure {
  if (failure.kind === 'truncated') {
    return {
      ok: false,
      code: 'scene_json_truncated',
      reason:
        'Scene JSON object never closed: the reply ended with the object still open. This is ' +
        'what a token-limit cut looks like, so a smaller scene may succeed.',
      source,
    };
  }

  // No `{` and no `[` anywhere. Prose is the overwhelmingly likely cause, and naming it is more
  // useful than "no object found" — a model that answered in prose has answered in the wrong
  // modality, which a caller should not retry the same way.
  const trimmed = text.trim();
  return {
    ok: false,
    code: 'scene_payload_prose',
    reason:
      trimmed.length === 0
        ? 'Scene reply is empty: there is no JSON object in it'
        : `Scene reply contains no JSON object. Received ${trimmed.length} characters of text ` +
          'that never open one.',
    source,
  };
}

/**
 * Decide whether a parsed JSON value is a candidate scene payload.
 *
 * Only a plain object qualifies. Two rejections are worth stating explicitly because they are
 * the ones a model actually produces:
 *
 *   - **An array.** A model asked for one scene will sometimes reply with a list of candidate
 *     scenes, or with a content-part list where a scene was expected. Both are the model
 *     being indecisive rather than offering a choice, and picking an element for it would be
 *     a guess about which picture the caller wanted. The code records the length so an
 *     operator can see the shape without the payload being logged.
 *   - **A scalar.** `"scene"`, a number, `true` — a JSON object was found syntactically but
 *     the parse yielded a primitive, which means the balanced slice was a fragment like
 *     `{"a":1}` inside a larger non-object reply. Refused as prose rather than as a type
 *     error, because that is what it actually is.
 */
function classifyParsed(
  parsed: unknown,
  source: SceneExtractionSource,
  extractedLength: number,
): SceneExtraction {
  if (Array.isArray(parsed)) {
    // An array of scenes where one scene was asked for. Refused rather than guessed at: picking
    // an element would be a decision about which picture the caller wanted, made by a module
    // that has no basis for it.
    return {
      ok: false,
      code: 'scene_payload_array',
      reason:
        `Scene JSON parsed to an array of ${parsed.length} item(s); a scene must be a single ` +
        'object. A list of candidates is refused rather than guessed at.',
      source,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    // A scalar or `null`. Reachable only when the region was an array — `{"a":1}` always parses
    // to an object — so the accurate description is "an array where a scene was expected", not
    // "a payload of the wrong type".
    return {
      ok: false,
      code: 'scene_payload_array',
      reason:
        `Scene JSON parsed to ${describe(parsed)} where a scene object was expected. An array ` +
        'is not a scene, even when its elements are.',
      source,
    };
  }

  return {
    ok: true,
    candidate: parsed as Record<string, unknown>,
    source,
    extractedLength,
  };
}

// ─── Scene id ────────────────────────────────────────────────

/**
 * Whether a string is usable as a scene id.
 *
 * Re-exported behavior from `scene.ts` rather than duplicated: the bound and the rule are the
 * same, and two implementations of "is this id legal" would eventually disagree. This wrapper
 * exists so the compiler can *pre-check* an id without calling the validator, which keeps the
 * compiler's failures about the compiler's inputs.
 */
export function isUsableSceneId(sceneId: unknown): sceneId is string {
  return typeof sceneId === 'string' && sceneId.length > 0 && sceneId.length <= MAX_SCENE_ID_LENGTH;
}
