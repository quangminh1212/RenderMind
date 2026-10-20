import { describe, it, expect } from 'vitest';
import {
  extractSceneCandidate,
  isUsableSceneId,
  MAX_SCENE_TEXT_LENGTH,
} from '../../../../src/platform/text-scene/extract';

/**
 * Scene extraction tests.
 *
 * Extraction is where untrusted model output first enters the pipeline, so the suite is written
 * as a **table of (input → verdict)** rather than as a set of examples. That is the only shape
 * that gives confidence about a parser over hostile input: the interesting cases are not the
 * happy path, they are the near-misses, and a near-miss is only convincing when it sits next to
 * the valid case it is one character away from.
 *
 * Three properties are asserted repeatedly, and each is the reason a specific implementation
 * choice was made rather than the obvious alternative:
 *
 *   1. **Never throws.** Asserted for a dozen hostile inputs including `null`, a number, a
 *      circular-free nested object, and a megabyte of prose. The contract is total, and a
 *      `try`/`catch` per case would hide the regression this is here to catch.
 *
 *   2. **Never echoes the payload.** Every reason string is checked against a marker string
 *      planted in the input. A reason reaches logs and sometimes an HTTP body; interpolating
 *      model output into it is how an injection payload gets a second life as a log line.
 *
 *   3. **Balanced, not first-to-last.** The scanner must find the object it started on, not a
 *      slice spanning from the first `{` in a sentence to the last `}` in the reply.
 */

/** A valid scene payload as a compact JSON string. */
const SCENE_JSON =
  '{"canvas":{"width":64,"height":64},"layers":[{"id":"sky","shapes":' +
  '[{"kind":"rect","x":0,"y":0,"width":64,"height":64,"fill":"#3366cc"}]}]}';

/** A marker planted inside hostile inputs, to prove it never reaches a reason string. */
const MARKER = 'IGNORE-ALL-PREVIOUS-INSTRUCTIONS';

/** Assert a failure result and hand back the (narrowed) value. */
function expectFailure(result: ReturnType<typeof extractSceneCandidate>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a failure');
  // The universal safety property, checked on every failure the suite produces.
  expect(result.reason).not.toContain(MARKER);
  return result;
}

describe('extractSceneCandidate — the bare JSON string', () => {
  it('accepts a JSON object on its own', () => {
    const result = extractSceneCandidate(SCENE_JSON);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('json_text');
    expect(result.candidate.canvas).toEqual({ width: 64, height: 64 });
  });

  it('accepts an object with surrounding whitespace', () => {
    const result = extractSceneCandidate(`\n\n  ${SCENE_JSON}  \n`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extractedLength).toBe(SCENE_JSON.length);
  });

  it('reports the extracted length as the object slice, not the whole reply', () => {
    const reply = `Here is the scene:\n${SCENE_JSON}\nDone.`;
    const result = extractSceneCandidate(reply);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extractedLength).toBe(SCENE_JSON.length);
  });
});

describe('extractSceneCandidate — fenced JSON', () => {
  it('accepts a ```json fence surrounded by prose', () => {
    const reply = `Sure, here is a scene.\n\n\`\`\`json\n${SCENE_JSON}\n\`\`\`\n\nEnjoy.`;
    const result = extractSceneCandidate(reply);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.layers).toHaveLength(1);
  });

  it('accepts a bare ``` fence with no language tag', () => {
    const result = extractSceneCandidate(`\`\`\`\n${SCENE_JSON}\n\`\`\``);
    expect(result.ok).toBe(true);
  });

  it('accepts a fence whose body is pretty-printed across lines', () => {
    const pretty = JSON.stringify(JSON.parse(SCENE_JSON), null, 2);
    const result = extractSceneCandidate('```json\n' + pretty + '\n```');
    expect(result.ok).toBe(true);
  });

  it('prefers the fenced object over prose braces that appear earlier', () => {
    // The decoration before the fence contains a brace pair. A first-to-last slice would span
    // from that `{x}` into the fenced object and fail to parse; balanced scanning does not.
    const reply = `I will use {"decorative":"noise"} as the envelope.\n\`\`\`json\n${SCENE_JSON}\n\`\`\``;
    const result = extractSceneCandidate(reply);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.canvas).toEqual({ width: 64, height: 64 });
  });

  it('accepts the first of two fenced blocks when both are scenes', () => {
    const reply =
      '```json\n' +
      SCENE_JSON +
      '\n```\n\nand an alternative:\n\n```json\n' +
      '{"canvas":{"width":1,"height":1},"layers":[{"id":"a","shapes":' +
      '[{"kind":"circle","cx":0,"cy":0,"r":1}]}]}\n```';
    const result = extractSceneCandidate(reply);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidate.canvas).toEqual({ width: 64, height: 64 });
  });
});

describe('extractSceneCandidate — chat content parts', () => {
  it('reads a single text part', () => {
    const result = extractSceneCandidate([{ type: 'text', text: SCENE_JSON }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('content_parts_text');
  });

  it('concatenates several text parts before scanning', () => {
    const result = extractSceneCandidate([
      { type: 'text', text: 'Here you go:\n```json\n' },
      { type: 'text', text: SCENE_JSON },
      { type: 'text', text: '\n```' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidate.layers).toHaveLength(1);
  });

  it('ignores image parts rather than scanning base64 for braces', () => {
    const result = extractSceneCandidate([
      { type: 'text', text: SCENE_JSON },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,e30=' } },
    ]);
    expect(result.ok).toBe(true);
  });

  it('accepts a text part with no explicit type, as some transports emit', () => {
    const result = extractSceneCandidate([{ text: SCENE_JSON }]);
    expect(result.ok).toBe(true);
  });

  it('refuses an image-only reply as prose rather than as a type error', () => {
    const failure = expectFailure(
      extractSceneCandidate([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      ]),
    );
    expect(failure.code).toBe('scene_payload_prose');
  });

  it('accepts a content-part array whose JSON object is the text', () => {
    // A transport that pre-parsed the model's JSON and put it in `text` still works, because the
    // part text is scanned as a string.
    const result = extractSceneCandidate([{ type: 'output_text', text: SCENE_JSON }]);
    expect(result.ok).toBe(true);
  });
});

describe('extractSceneCandidate — malformed JSON', () => {
  it('refuses a truncated object and says so with a distinct code', () => {
    const failure = expectFailure(extractSceneCandidate('```json\n{"canvas":{"width":64'));
    expect(failure.code).toBe('scene_json_truncated');
    expect(failure.reason).toMatch(/never closed/i);
  });

  it('refuses a trailing comma rather than repairing it', () => {
    // The design rule: a model that produced almost-JSON cannot produce JSON, so accepting it
    // would silently convert a bounded refusal into unbounded downstream ambiguity.
    const failure = expectFailure(extractSceneCandidate('{"canvas":{"width":64,"height":64},}'));
    expect(failure.code).toBe('scene_json_malformed');
  });

  it('refuses single-quoted keys rather than repairing them', () => {
    const failure = expectFailure(extractSceneCandidate("{'canvas':{}}"));
    expect(failure.code).toBe('scene_json_malformed');
  });

  it('refuses Python literals rather than repairing them', () => {
    const failure = expectFailure(
      extractSceneCandidate('{"canvas":{"width":64,"height":64},"seed":None}'),
    );
    expect(failure.code).toBe('scene_json_malformed');
  });

  it('reports a parse position without echoing the offending text', () => {
    const failure = expectFailure(extractSceneCandidate(`{"canvas": {"w": "${MARKER}"`));
    expect(failure.code).toBe('scene_json_truncated');
    expect(failure.reason).not.toContain(MARKER);
  });

  it('does not treat a brace inside a string as nesting', () => {
    // A layer named `Sky { Sea` must not confuse the depth counter, and the object must still
    // be found by its real closing brace.
    const reply =
      '{"canvas":{"width":8,"height":8},"layers":' +
      '[{"id":"sky","name":"Sky { Sea","shapes":[{"kind":"rect","x":0,"y":0,"width":8,"height":8}]}]}';
    const result = extractSceneCandidate(reply);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extractedLength).toBe(reply.length);
  });

  it('does not treat an escaped quote as ending a string', () => {
    const reply =
      '{"canvas":{"width":8,"height":8},"title":"a \\" quoted } brace",' +
      '"layers":[{"id":"a","shapes":[{"kind":"circle","cx":0,"cy":0,"r":1}]}]}';
    const result = extractSceneCandidate(reply);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extractedLength).toBe(reply.length);
  });
});

describe('extractSceneCandidate — wrong payload shapes', () => {
  it('refuses a bare array of scenes rather than picking one', () => {
    const failure = expectFailure(extractSceneCandidate(`[${SCENE_JSON},${SCENE_JSON}]`));
    expect(failure.code).toBe('scene_payload_array');
    expect(failure.reason).toMatch(/array of 2/i);
  });

  it('refuses an empty array', () => {
    const failure = expectFailure(extractSceneCandidate('[]'));
    expect(failure.code).toBe('scene_payload_array');
  });

  it('refuses an array of non-scene values the same way, without inspecting elements', () => {
    // The array is refused as an array. Whether its elements are scenes is irrelevant, and
    // checking would be the guess this branch exists to avoid.
    const failure = expectFailure(extractSceneCandidate('[1,2,3]'));
    expect(failure.code).toBe('scene_payload_array');
  });

  it('refuses a scalar region as an array, not as an unparseable payload', () => {
    // Reachable only when the region opened with `[`, e.g. `[1,2]` — a region opening with `{`
    // always parses to an object, so `not_object` is not a code any input can produce.
    const failure = expectFailure(extractSceneCandidate('Here: [1,2] and nothing else'));
    expect(failure.code).toBe('scene_payload_array');
  });

  it('refuses prose with no object at all, naming the length and not the text', () => {
    const failure = expectFailure(
      extractSceneCandidate(`I am sorry, I cannot draw that. ${MARKER}`),
    );
    expect(failure.code).toBe('scene_payload_prose');
    expect(failure.reason).not.toContain(MARKER);
    expect(failure.reason).toMatch(/no JSON object/i);
  });

  it('refuses an empty string', () => {
    const failure = expectFailure(extractSceneCandidate(''));
    expect(failure.code).toBe('scene_payload_prose');
    expect(failure.reason).toMatch(/empty/i);
  });

  it('refuses a whitespace-only reply', () => {
    const failure = expectFailure(extractSceneCandidate('   \n\t  '));
    expect(failure.code).toBe('scene_payload_prose');
  });
});

describe('extractSceneCandidate — non-text inputs and bounds', () => {
  it('refuses null, numbers, booleans and undefined without throwing', () => {
    for (const input of [null, undefined, 42, true, Symbol('x')]) {
      const failure = expectFailure(extractSceneCandidate(input));
      expect(failure.code).toBe('scene_text_not_string');
    }
  });

  it('refuses a Buffer rather than coercing it to text', () => {
    const failure = expectFailure(extractSceneCandidate(Buffer.from(SCENE_JSON, 'utf8')));
    expect(failure.code).toBe('scene_text_not_string');
  });

  it('refuses an oversized reply before parsing, naming the bound', () => {
    const failure = expectFailure(extractSceneCandidate('{'.repeat(MAX_SCENE_TEXT_LENGTH + 1)));
    expect(failure.code).toBe('scene_text_too_long');
    expect(failure.reason).toContain(String(MAX_SCENE_TEXT_LENGTH));
  });

  it('refuses oversized content-part text as too long', () => {
    const failure = expectFailure(
      extractSceneCandidate([{ type: 'text', text: 'x'.repeat(MAX_SCENE_TEXT_LENGTH + 1) }]),
    );
    expect(failure.code).toBe('scene_text_too_long');
  });

  it('never throws on any of a hostile corpus of inputs', () => {
    const corpus: unknown[] = [
      '',
      '   ',
      '{',
      '}',
      '{{{{',
      '}}}}',
      '{"a"',
      '{"a":}',
      '"unterminated',
      '\\',
      '```json',
      '```json\n',
      '```\n```',
      '[',
      '[]',
      '[{}]',
      '[{"type":"text"}]',
      [null],
      [[{ type: 'text', text: '{}' }]],
      { nested: { deeply: { object: true } } },
      new Date(0),
      () => '{}',
      NaN,
      Infinity,
    ];
    for (const input of corpus) {
      expect(() => extractSceneCandidate(input)).not.toThrow();
    }
  });

  it('is deterministic: the same hostile reply yields the same verdict twice', () => {
    const reply = `prose ${MARKER}\n\`\`\`json\n{"canvas":{"width":64,`;
    const first = extractSceneCandidate(reply);
    const second = extractSceneCandidate(reply);
    expect(second).toEqual(first);
  });

  it('never hands back a candidate for a malformed reply, so nothing unvalidated escapes', () => {
    for (const input of ['{"canvas":', 'no json here', '[1,2,3]', '```json\n{oops}\n```']) {
      const result = extractSceneCandidate(input);
      expect(result.ok).toBe(false);
    }
  });
});

describe('isUsableSceneId', () => {
  it('accepts a non-empty bounded string', () => {
    expect(isUsableSceneId('scene_abc123')).toBe(true);
  });

  it('refuses an empty string, a non-string, and an over-long id', () => {
    expect(isUsableSceneId('')).toBe(false);
    expect(isUsableSceneId('x'.repeat(129))).toBe(false);
    expect(isUsableSceneId(undefined)).toBe(false);
    expect(isUsableSceneId(12345)).toBe(false);
  });
});
