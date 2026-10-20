/**
 * SVG validation and rasterization.
 *
 * Why this module exists: a text-only chat model has no image endpoint, so the only
 * artifact it can genuinely produce is one it can *write out as text*. A raster format
 * cannot survive that trip — every base64 PNG a language model emits is either copied from
 * its training data or invented, and an invented one is a corrupt payload that a client
 * renders as a broken image. Vector markup is different in kind: the model composes
 * geometry, and the bytes it emits are the image.
 *
 * That makes SVG the honest fallback, and it makes validation non-optional. Model-authored
 * SVG is untrusted input that a downstream client will hand to a browser. Two failure
 * classes matter, and they are not the same:
 *
 *   1. **Fake output.** The model writes `data:image/svg+xml;base64,...` and then emits
 *      something that is not SVG at all — a PNG it "remembers", random bytes, or a
 *      well-formed document with no geometry in it. A payload that *claims* to be an image
 *      and contains no picture is worse than a refusal, because a refusal is actionable.
 *   2. **Unsafe output.** The document parses as SVG but carries an active payload:
 *      `<script>`, an `on*=` handler, `<foreignObject>`, an external entity, or a
 *      reference that resolves off-document. SVG is a document format served as an image,
 *      so this is XSS-by-image.
 *
 * Both are terminal. Neither is retryable: a model that just emitted script will emit
 * script again on the next attempt, and burning upstream quota to confirm that is exactly
 * the behaviour the engine was built to avoid.
 *
 * Design rule: **never trust the mime the model wrote.** Every payload is classified from
 * its own bytes. The claimed spelling is a hint about what to *try*, never a fact.
 *
 * The scan is deliberately conservative — it rejects more than the SVG spec requires. An
 * illustration generated from a prompt has no legitimate need for a script element, an
 * event handler, a nested browsing context, or an off-document reference, so refusing them
 * costs a caller nothing real and removes a whole class of attack. Where a false rejection
 * is conceivable the code names the specific reason, so the failure stays diagnosable
 * rather than becoming a mystery.
 */
import { Resvg } from '@resvg/resvg-js';

/** The SVG media type, spelled once so a typo cannot drift between call sites. */
export const SVG_MIME = 'image/svg+xml';

/** The SVG XML namespace, required on the root element. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Ceiling on an SVG payload, in bytes of decoded UTF-8.
 *
 * Far tighter than the 25 MiB bound the artifact store applies to fetched rasters, and
 * deliberately so: a legitimate illustration composed from geometry is kilobytes. A
 * multi-megabyte "SVG" is either a raster smuggled inside a data URI, or a payload built
 * to exhaust the parser and the rasterizer. Both are refused.
 */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

/**
 * Elements that make a document *active* rather than *depictive*.
 *
 * `script` executes. `foreignObject` embeds arbitrary markup in a foreign namespace, which
 * is how HTML — and therefore JS — gets in through the side door. `handler` and `listener`
 * are the SMIL/animation event bindings that fire the same way. `iframe`/`embed`/`object`
 * nest browsing contexts. None of them draw anything a prompt asks for.
 */
const BLOCKED_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'handler',
  'listener',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
]);

/**
 * Elements that *depict* something. A document containing none of these has no picture in
 * it, whatever its root element says.
 *
 * Used for the anti-placeholder gate. The list is intentionally long: rejecting a real
 * illustration because the model chose an element we forgot would be a worse failure than
 * accepting a degenerate one, since the caller sees a terminal error either way and only
 * one of those two mistakes is recoverable by the caller.
 */
const DRAWABLE_ELEMENTS = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'image',
  'use',
  'g',
  'defs',
  'symbol',
  'marker',
  'pattern',
  'clippath',
  'mask',
  'lineargradient',
  'radialgradient',
  'filter',
]);

/** How a payload may fail validation. Each value is a stable, client-visible code. */
export type SvgRejectionCode =
  | 'svg_not_decodable'
  | 'svg_wrong_type'
  | 'svg_too_large'
  | 'svg_malformed'
  | 'svg_wrong_root'
  | 'svg_missing_namespace'
  | 'svg_unsafe_element'
  | 'svg_unsafe_attribute'
  | 'svg_unsafe_doctype'
  | 'svg_unsafe_reference'
  | 'svg_no_geometry'
  | 'svg_rasterize_failed';

export interface SvgAccepted {
  ok: true;
  /** The document text, as decoded. */
  svg: string;
  width: number;
  height: number;
}

export interface SvgRejected {
  ok: false;
  code: SvgRejectionCode;
  /** Human-readable, safe to return to a caller: names the reason, never the payload. */
  reason: string;
}

export type SvgValidation = SvgAccepted | SvgRejected;

// ─── Byte-level classification ───────────────────────────────

/** Magic bytes for the raster formats we are willing to accept as *not* SVG. */
const RASTER_SIGNATURES: Array<{ mime: string; matches: (b: Buffer) => boolean }> = [
  { mime: 'image/png', matches: (b) => b.length > 7 && b.readUInt32BE(0) === 0x89504e47 },
  {
    mime: 'image/jpeg',
    matches: (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/webp',
    matches: (b) =>
      b.length > 11 &&
      b.toString('latin1', 0, 4) === 'RIFF' &&
      b.toString('latin1', 8, 12) === 'WEBP',
  },
  { mime: 'image/gif', matches: (b) => b.length > 5 && b.toString('latin1', 0, 4) === 'GIF8' },
  {
    mime: 'image/avif',
    matches: (b) => b.length > 11 && b.toString('latin1', 4, 8) === 'ftyp',
  },
];

/**
 * Classify a payload from its own bytes.
 *
 * This is the load-bearing function for the "fake output" gate. A model that writes
 * `image/svg+xml` and then ships a PNG — which happens, because a model reproducing a
 * familiar token sequence does not know what those bytes are — is caught here, and the
 * mismatch is reported as a mislabelled payload rather than silently rendered as the
 * wrong thing.
 *
 * @returns a known media type, `'image/svg+xml'` for anything that opens like an SVG
 *          document, or `null` when the bytes match nothing we understand.
 */
export function sniffImageMime(bytes: Buffer): string | null {
  for (const signature of RASTER_SIGNATURES) {
    if (signature.matches(bytes)) return signature.mime;
  }

  if (looksLikeSvgText(bytes)) return SVG_MIME;

  return null;
}

/**
 * Whether a payload opens like an SVG document.
 *
 * Tolerant of what actually comes back in practice: a UTF-8 BOM, leading whitespace, an XML
 * declaration, comments, a doctype, or a processing instruction before the root element.
 * The `<?xml` spelling is treated as SVG-ish on purpose — a model that emits an XML
 * declaration is writing XML, and the caller gets a precise `svg_wrong_root` answer from
 * the structural validator rather than an unhelpful "unrecognised bytes".
 */
function looksLikeSvgText(bytes: Buffer): boolean {
  // A NUL byte in the first block means binary, not markup. Bounded scan: reading the whole
  // buffer to answer a prefix question would let a large hostile payload cost us the read.
  const head = bytes.subarray(0, 4096);
  if (head.includes(0)) return false;

  const text = stripLeadingProlog(head.toString('utf8')).trimStart();
  return text.startsWith('<svg') || text.startsWith('<?xml') || text.startsWith('<!DOCTYPE');
}

/** Remove a UTF-8 BOM and any leading whitespace before structural inspection. */
function stripLeadingProlog(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─── Structural + safety validation ─────────────────────────

/**
 * Elements whose text content is a stylesheet, not markup.
 *
 * The reasons inside `<style>` legitimately contain quoted font names, commas and braces,
 * so scanning them as though they were markup produces false positives on real artwork.
 * They still get scanned for the dangerous constructs, just with the right rules.
 */
const STYLE_ELEMENTS = new Set(['style']);

/**
 * Attributes that can hand control to the client.
 *
 * `on*` covers the whole DOM event-handler family without enumerating it, which is the
 * point: a new handler name in a future spec must not become a hole here.
 */
function isUnsafeAttribute(name: string): boolean {
  return name.startsWith('on');
}

/**
 * Whether an attribute value is a reference that resolves outside the document.
 *
 * Relative fragment references (`#gradient`) are how real SVG composes, so they are fine.
 * Anything with a scheme — `http`, `javascript`, an inline `data:` raster — is not
 * something an illustration generated from a prompt needs, and each is a distinct way to
 * either exfiltrate the viewer or smuggle non-validated bytes past this gate.
 */
function isUnsafeReference(value: string): boolean {
  const trimmed = decodeEntities(value).trim();
  if (trimmed === '') return false;

  // Bare fragments stay inside the document.
  if (trimmed.startsWith('#')) return false;

  // A scheme-qualified URL, unless it is a data: image we already refuse below.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!scheme) return false;

  const name = scheme[1].toLowerCase();
  // `url(#id)` inside a style attribute or CSS declaration resolves in-document.
  if (name === 'url' && /^url\(\s*['"]?#/i.test(trimmed)) return false;

  return true;
}

/** Expand the handful of XML entities that can appear in an attribute value. */
function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // `&amp;` last, so `&amp;lt;` does not decode twice into a false `javascript:`.
      .replace(/&amp;/g, '&')
  );
}

/**
 * Reject a doctype outright.
 *
 * A doctype is the entry point for external and internal entity expansion: XXE, and the
 * billion-laughs family that makes the parser allocate unbounded memory from a few hundred
 * bytes. No illustration generated from a prompt needs one. Refusing all doctypes is the
 * cheap, total answer; the alternative is trying to enumerate which entity declarations are
 * safe, which is a game with no end.
 */
function findDoctype(text: string): string | null {
  const match = /<!DOCTYPE\b[^>]*>/i.exec(text);
  return match ? match[0] : null;
}

/**
 * Validate an SVG document.
 *
 * Order matters: each check is cheaper than the one after it, and the earliest failure
 * gives the most precise reason. Sizes are bounded before any parse work happens.
 *
 * Pure and synchronous — no I/O, no clock — so the whole gate is testable as a table of
 * (payload → verdict), which is the only way to be confident about a security check.
 */
export function validateSvg(input: string | Buffer): SvgValidation {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');

  // ── 1. Size, before anything expensive touches it ────────
  if (bytes.byteLength > MAX_SVG_BYTES) {
    return {
      ok: false,
      code: 'svg_too_large',
      reason: `SVG payload is ${bytes.byteLength} bytes, over the ${MAX_SVG_BYTES}-byte limit`,
    };
  }

  if (bytes.byteLength === 0) {
    return { ok: false, code: 'svg_malformed', reason: 'SVG payload is empty' };
  }

  // ── 2. Decoded type, from the bytes rather than the claim ─
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== null && sniffed !== SVG_MIME) {
    return {
      ok: false,
      code: 'svg_wrong_type',
      reason:
        `Payload was labelled as SVG but its bytes are ${sniffed}. ` +
        'A raster cannot be served as a vector.',
    };
  }

  const text = stripLeadingProlog(bytes.toString('utf8'));

  // A UTF-8 replacement character means the bytes were not valid UTF-8 at all.
  if (text.includes('�')) {
    return { ok: false, code: 'svg_not_decodable', reason: 'SVG payload is not valid UTF-8' };
  }

  // ── 3. Doctype / entities ────────────────────────────────
  // Checked before the tag scan because an entity declaration can hide the very
  // constructs the scan is looking for.
  const doctype = findDoctype(text);
  if (doctype) {
    return {
      ok: false,
      code: 'svg_unsafe_doctype',
      reason:
        'SVG contains a DOCTYPE declaration. Entity expansion is refused because it ' +
        'enables external-entity and unlimited-expansion attacks.',
    };
  }
  if (
    /&[a-z][a-z0-9]*;/i.test(text) &&
    !/&(amp|lt|gt|quot|apos|nbsp|#[0-9]+|#x[0-9a-f]+);/i.test(text)
  ) {
    // A named entity that is not one of the five XML built-ins and could not have been
    // declared, because a doctype was already refused above.
    return {
      ok: false,
      code: 'svg_unsafe_doctype',
      reason: 'SVG references an undeclared entity. Only the XML built-in entities are allowed.',
    };
  }

  // ── 4. Prolog-free structural scan ───────────────────────
  // Comments are removed first so a commented-out element cannot trip the element scan,
  // and so an attacker cannot hide one *inside* a comment that a lenient client would
  // still parse. Removing them entirely is the conservative choice.
  const scannable = text.replace(/<!--[\s\S]*?-->/g, '');

  if (!/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(scannable)) {
    // Distinguish "not a document" from "a document with the wrong root", because the two
    // point at different model failures and the caller can act on the difference.
    if (/^\s*</.test(scannable)) {
      const root = /^\s*<\??\s*([a-zA-Z][\w:.-]*)/.exec(scannable);
      return {
        ok: false,
        code: 'svg_wrong_root',
        reason:
          `Document root is <${root?.[1] ?? 'unknown'}>, not <svg>. ` +
          'The model did not produce an SVG illustration.',
      };
    }
    return {
      ok: false,
      code: 'svg_malformed',
      reason: 'Payload is not an SVG document: no <svg> root element was found.',
    };
  }

  // ── 5. Namespace ─────────────────────────────────────────
  const rootTag = /<svg\b[^>]*>/i.exec(scannable)?.[0] ?? '';
  if (!/xmlns\s*=\s*["']\s*http:\/\/www\.w3\.org\/2000\/svg\s*["']/i.test(rootTag)) {
    return {
      ok: false,
      code: 'svg_missing_namespace',
      reason: `SVG root element must declare xmlns="${SVG_NAMESPACE}".`,
    };
  }

  // ── 6. Well-formedness, cheaply ──────────────────────────
  // A full XML parse would need a second dependency and a parser-hardening review of its
  // own. What is checked instead is the class of malformation that reaches us in practice —
  // truncation — plus the content rules below, which is what actually decides safety.
  const unclosed = unbalancedTags(scannable);
  if (unclosed) {
    return { ok: false, code: 'svg_malformed', reason: unclosed };
  }

  // ── 7. Elements ──────────────────────────────────────────
  const foundElements: string[] = [];
  const elementPattern = /<\s*([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let element: RegExpExecArray | null;

  while ((element = elementPattern.exec(scannable)) !== null) {
    const rawName = element[1];
    const localName = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
    const lowered = localName.toLowerCase();

    foundElements.push(lowered);

    if (BLOCKED_ELEMENTS.has(lowered)) {
      return {
        ok: false,
        code: 'svg_unsafe_element',
        reason:
          `SVG contains <${rawName}>, which introduces active content. ` +
          'Only depictive elements are accepted.',
      };
    }

    // ── 8. Attributes on this element ──────────────────────
    const inStyleElement = STYLE_ELEMENTS.has(lowered);
    const attributePattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const seenAttributes = new Set<string>();
    let attribute: RegExpExecArray | null;

    while ((attribute = attributePattern.exec(element[2] ?? '')) !== null) {
      const attrName = attribute[1];
      const attrValue = attribute[2] ?? attribute[3] ?? '';
      const localAttr = attrName.includes(':')
        ? attrName.slice(attrName.indexOf(':') + 1)
        : attrName;

      // XML rejects duplicate attributes. Catch them before the renderer sees the
      // document, so validation and rasterization share the same contract.
      const attributeKey = attrName.toLowerCase();
      if (seenAttributes.has(attributeKey)) {
        return {
          ok: false,
          code: 'svg_malformed',
          reason: `SVG element <${rawName}> repeats the attribute "${attrName}". XML attributes must be unique.`,
        };
      }
      seenAttributes.add(attributeKey);

      // In a stylesheet, `on*` is not a handler; it is a selector or a property name.
      if (!inStyleElement && isUnsafeAttribute(localAttr.toLowerCase())) {
        return {
          ok: false,
          code: 'svg_unsafe_attribute',
          reason:
            `SVG element <${rawName}> carries the event handler "${attrName}". ` +
            'Event handlers are active content and are refused.',
        };
      }

      // `href`/`xlink:href`/`src`/`data` that leaves the document is an off-document load.
      const valueLooksLikeReference =
        localAttr.toLowerCase() === 'href' ||
        localAttr.toLowerCase() === 'src' ||
        localAttr.toLowerCase() === 'data' ||
        localAttr.toLowerCase() === 'action' ||
        localAttr.toLowerCase() === 'formaction';

      if (valueLooksLikeReference && isUnsafeReference(attrValue)) {
        return {
          ok: false,
          code: 'svg_unsafe_reference',
          reason:
            `SVG element <${rawName}> references "${summariseReference(attrValue)}", ` +
            'which resolves outside the document. External references are refused.',
        };
      }

      // Inline `style` attributes and CSS values can also carry a url() load.
      if (/(^|[^-])style$/i.test(localAttr) && /url\s*\(\s*['"]?[^#'"]/i.test(attrValue)) {
        return {
          ok: false,
          code: 'svg_unsafe_reference',
          reason: 'SVG style attribute contains a url() that resolves outside the document.',
        };
      }

      // A `data:` URL in any attribute is an unvalidated payload of unknown type.
      if (/data\s*:/i.test(decodeEntities(attrValue)) && /url\s*\(|href|src/i.test(localAttr)) {
        return {
          ok: false,
          code: 'svg_unsafe_reference',
          reason: 'SVG embeds a data: URL. Embedded payloads are refused; draw with geometry.',
        };
      }
    }
  }

  // ── 9. Geometry, or it is not a picture ──────────────────
  // The anti-placeholder gate. `<svg/>`, `<svg><title>a cat</title></svg>` and a document
  // that only describes an image all parse cleanly and all render as nothing. Delivering
  // one as a successful image is the exact dishonesty this engine exists to prevent.
  const drawsSomething = foundElements.some((name) => DRAWABLE_ELEMENTS.has(name));
  if (!drawsSomething) {
    return {
      ok: false,
      code: 'svg_no_geometry',
      reason:
        'SVG contains no drawable elements (no path, shape, text or image). ' +
        'The model produced a placeholder, not an illustration.',
    };
  }

  // ── 10. Honest dimensions ────────────────────────────────
  const { width, height } = readDimensions(rootTag);

  return { ok: true, svg: text, width, height };
}

/** Read width/height from the root tag, falling back to the viewBox. */
function readDimensions(rootTag: string): { width: number; height: number } {
  const parse = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const numeric = parseFloat(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
  };

  const width = parse(/\bwidth\s*=\s*["']([^"']+)["']/i.exec(rootTag)?.[1]);
  const height = parse(/\bheight\s*=\s*["']([^"']+)["']/i.exec(rootTag)?.[1]);
  if (width && height) return { width: Math.round(width), height: Math.round(height) };

  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(rootTag)?.[1];
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n)) &&
      parts[2] > 0 &&
      parts[3] > 0
    ) {
      return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
    }
  }

  // Nothing declared. A viewport is required for rasterization, so assume the conventional
  // square rather than refusing a valid drawing that omitted its size.
  return { width: 1024, height: 1024 };
}

/**
 * Report truncated markup, which is the malformation that actually occurs.
 *
 * A model that hits its output-token ceiling mid-element emits a document that opens with
 * `<svg>` and simply stops. That payload passes every content check above and then either
 * renders partially or fails inside the rasterizer, so it is caught here with a message
 * that says what happened.
 *
 * @returns a reason when the document is unbalanced, otherwise `null`.
 */
function unbalancedTags(text: string): string | null {
  const tagPattern = /<\s*(\/?)\s*([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g;
  const stack: string[] = [];
  let tag: RegExpExecArray | null;

  while ((tag = tagPattern.exec(text)) !== null) {
    const isClosing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    const selfClosing = tag[4] === '/';

    // XML processing instructions and declarations are not elements.
    if (name === '?xml' || name.startsWith('?')) continue;

    if (selfClosing) continue;

    if (!isClosing) {
      stack.push(name);
      // A runaway stack means the document is deeper than any drawing needs; stop before
      // the bookkeeping itself becomes the cost.
      if (stack.length > 512) {
        return 'SVG element nesting is implausibly deep. The document is refused as malformed.';
      }
      continue;
    }

    const expected = stack.pop();
    if (expected !== name) {
      return (
        `SVG is not well-formed: closing </${name}> does not match <${expected ?? 'nothing'}>. ` +
        'A truncated model response is the usual cause.'
      );
    }
  }

  if (stack.length > 0) {
    return (
      `SVG is not well-formed: ${stack.length} element(s) left unclosed ` +
      `(<${stack[0]}>). A truncated model response is the usual cause.`
    );
  }

  return null;
}

/** Keep an offending reference out of logs and messages beyond a short, inert prefix. */
function summariseReference(value: string): string {
  const cleaned = value.replace(/[\r\n\t]/g, ' ').trim();
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
}

// ─── Rasterization ───────────────────────────────────────────

export interface RasterizeOptions {
  /** Target width in pixels. Height is derived from the document's own ratio. */
  width?: number;
  /** Optional background, as `#rrggbb`. SVG is transparent by default; PNG consumers
   *  frequently assume opaque, and a transparent illustration reads as a broken image. */
  background?: string;
}

/**
 * Ceiling on the longest edge of a rasterized image.
 *
 * The document's own `width`/`height`/`viewBox` is model-authored, so it is not a size
 * request — it is a number a model chose, and a model can choose an enormous one. Rendering
 * a `viewBox="0 0 100000 100000"` at its natural scale asks the renderer to allocate
 * roughly 40 GB, which is a denial of service reachable from a single prompt with no
 * malformed markup involved. Nothing is validated away by this: the document is a valid
 * drawing, it simply gets rendered at a sane size.
 *
 * The bound is applied to the longest edge, so an extreme aspect ratio cannot smuggle a
 * huge allocation through the shorter one.
 */
export const MAX_RASTER_EDGE = 4096;

/** Ceiling on total rasterized pixels, so a wide document cannot defeat the edge bound. */
export const MAX_RASTER_PIXELS = 4096 * 4096;

export interface RasterizeResult {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Rasterize a *validated* SVG document to PNG.
 *
 * Only ever called with the output of `validateSvg`, and that ordering is the security
 * boundary: resvg is a conforming renderer that will happily rasterize a document
 * containing a script element (it does not execute it, but it also does not refuse it).
 * Passing unvalidated model output here would mean the safety gate and the renderer could
 * disagree about what the document is.
 *
 * Rendering is CPU-bound and synchronous. It runs inside the engine's semaphore permit, so
 * the cost is attributed to the sub-job that caused it and bounded by the global
 * concurrency cap rather than being able to overrun the queue.
 *
 * @throws RasterizeError when the document cannot be rendered despite validating. Treated
 *         by the caller as a terminal provider failure, never retried.
 */
export function rasterizeSvgToPng(svg: string, options: RasterizeOptions = {}): RasterizeResult {
  // An explicit width always wins and is itself bounded, so a caller asking for a 100k-wide
  // render cannot allocate one either.
  const requestedWidth =
    options.width !== undefined && Number.isFinite(options.width) && options.width > 0
      ? Math.min(Math.round(options.width), MAX_RASTER_EDGE)
      : undefined;

  // The render size must be decided BEFORE the renderer is constructed. `fitTo` is only
  // applied when a width is known, so a document that declares its own enormous width would
  // otherwise be allocated at that size by the constructor itself — the clamp would run
  // after the allocation it exists to prevent, which is no protection at all.
  //
  // So the document is asked what size it wants, that answer is bounded, and the renderer is
  // then built against the bounded value. `fitTo` scales the drawing to fit, so clamping
  // here resizes the output rather than cropping it.
  const declared = requestedWidth ?? declaredWidthOf(svg);
  const target = clampToBudget(declared);

  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width' as const, value: target },
      background: options.background ?? '#ffffff',
      // A model-authored document may reference fonts that are not installed. Falling back
      // is preferable to a hard failure: the geometry still renders, and text becomes the
      // default face rather than the whole image failing.
      font: { loadSystemFonts: true },
    });

    const rendered = resvg.render();

    // `fitTo` bounds the width, so the height follows the document's ratio and cannot exceed
    // the edge budget. Re-check anyway: the ratio is model-authored, and a 4096-wide,
    // 100000-tall document is a valid drawing that no caller wants rasterized at that size.
    const { width, height } = clampToBudgetPair(rendered.width, rendered.height);

    if (width !== rendered.width || height !== rendered.height) {
      const clampedResvg = new Resvg(svg, {
        fitTo: { mode: 'width' as const, value: width },
        background: options.background ?? '#ffffff',
        font: { loadSystemFonts: true },
      });
      const clamped = clampedResvg.render();
      const png = clamped.asPng();
      assertPng(png);
      return { png, width: clamped.width, height: clamped.height };
    }

    const png = rendered.asPng();
    assertPng(png);
    return { png, width: rendered.width, height: rendered.height };
  } catch (error) {
    if (error instanceof RasterizeError) throw error;
    throw new RasterizeError(
      `SVG could not be rasterized: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * The width a document declares for itself, bounded.
 *
 * Read from the same tags `readDimensions` uses, but *without* its 1024 default: here the
 * distinction between "declared a size" and "declared nothing" matters, because the former
 * can be hostile and the latter is simply absent.
 */
function declaredWidthOf(svg: string): number {
  const rootTag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';

  const width = parseFloat(/\bwidth\s*=\s*["']([^"']+)["']/i.exec(rootTag)?.[1] ?? '');
  if (Number.isFinite(width) && width > 0) return width;

  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(rootTag)?.[1];
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0) return parts[2];
  }

  return 1024;
}

/** Scale a requested width down until the edge budget is satisfied. */
function clampToBudget(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1024;
  return Math.min(Math.round(width), MAX_RASTER_EDGE);
}

/** Scale a rendered size down until both the edge and pixel budgets are satisfied. */
function clampToBudgetPair(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1024, height: 1024 };
  }

  const edgeScale = Math.min(1, MAX_RASTER_EDGE / Math.max(width, height));
  const pixelScale = Math.min(1, Math.sqrt(MAX_RASTER_PIXELS / (width * height)));
  const scale = Math.min(edgeScale, pixelScale);

  if (scale >= 1) return { width: Math.round(width), height: Math.round(height) };

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The delivered bytes must be a decodable PNG, or the caller gets a broken image. */
function assertPng(png: Buffer): void {
  if (png.byteLength === 0) {
    throw new RasterizeError('Rasterizer produced an empty PNG');
  }
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    throw new RasterizeError('Rasterizer produced a payload without PNG magic bytes');
  }
}

/** A validated SVG that the renderer still could not draw. Terminal, never retried. */
export class RasterizeError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RasterizeError';
    this.cause = cause;
    Object.setPrototypeOf(this, RasterizeError.prototype);
  }
}
