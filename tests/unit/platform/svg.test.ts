import { describe, it, expect } from 'vitest';
import {
  MAX_RASTER_EDGE,
  MAX_RASTER_PIXELS,
  MAX_SVG_BYTES,
  SVG_MIME,
  RasterizeError,
  rasterizeSvgToPng,
  sniffImageMime,
  validateSvg,
} from '../../../src/platform/svg';

/**
 * SVG gate tests.
 *
 * This is the security boundary of the SVG fallback: model-authored markup is untrusted
 * input that a downstream client hands to a browser. Two failure classes are pinned here,
 * and they are different problems:
 *
 *   1. **Fake output** — the payload claims to be SVG and contains no picture, or is not
 *      SVG at all. Delivered, it renders as a broken image and reads as success.
 *   2. **Unsafe output** — the document parses and draws, but carries an active payload.
 *
 * Each refusal is asserted on its *code*, not just its truthiness, so a future change that
 * still rejects the payload but for the wrong reason fails here instead of passing.
 */

/** A minimal document that genuinely draws something. */
const VALID = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
  '<rect width="64" height="64" fill="#3366cc"/>',
  '<circle cx="32" cy="32" r="16" fill="#ffcc00"/>',
  '</svg>',
].join('');

/** Wrap markup in a document frame, for tests about one specific inner construct. */
function doc(inner: string, attrs = 'width="64" height="64"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
}

describe('validateSvg — acceptance', () => {
  it('accepts a well-formed drawing and reports its declared size', () => {
    const verdict = validateSvg(VALID);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.width).toBe(64);
    expect(verdict.height).toBe(64);
    expect(verdict.svg).toContain('<circle');
  });

  it('accepts an XML declaration and leading comments', () => {
    const verdict = validateSvg(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn -->\n${VALID}`);
    expect(verdict.ok).toBe(true);
  });

  it('accepts a UTF-8 BOM and leading whitespace', () => {
    // Written as an escape: a literal U+FEFF is invisible in source and the linter
    // refuses it, so the byte-order mark is spelled out.
    expect(validateSvg(`\uFEFF\n  ${VALID}`).ok).toBe(true);
  });

  it('accepts a Buffer as well as a string', () => {
    expect(validateSvg(Buffer.from(VALID, 'utf8')).ok).toBe(true);
  });

  it('derives the size from the viewBox when width/height are absent', () => {
    const verdict = validateSvg(
      doc('<path d="M0 0 L300 200" stroke="#000"/>', 'viewBox="0 0 300 200"'),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.width).toBe(300);
    expect(verdict.height).toBe(200);
  });

  it('accepts in-document fragment references, which is how real artwork composes', () => {
    const verdict = validateSvg(
      doc(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
          '<rect width="64" height="64" fill="url(#g)"/>',
      ),
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects a commented-out element rather than trusting the comment', () => {
    // A lenient client may still parse the commented block, so a document that only ever
    // mentions geometry inside a comment has drawn nothing.
    const verdict = validateSvg(doc('<!-- <rect width="64" height="64"/> -->'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_no_geometry');
  });
});

describe('validateSvg — fake output', () => {
  it('rejects a PNG payload that claims to be SVG', () => {
    // The model wrote image/svg+xml, then shipped bytes it recalled rather than composed.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('IHDR', 'latin1'),
    ]);
    const verdict = validateSvg(png);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_wrong_type');
    expect(verdict.reason).toMatch(/image\/png/);
  });

  it('rejects a JPEG payload that claims to be SVG', () => {
    const verdict = validateSvg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_wrong_type');
  });

  it('rejects a well-formed document with no geometry in it', () => {
    const verdict = validateSvg(doc('<title>A cat sitting on a fence</title>'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_no_geometry');
  });

  it('rejects an empty self-closing root', () => {
    const verdict = validateSvg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_no_geometry');
  });

  it('rejects prose', () => {
    const verdict = validateSvg('I cannot draw that, sorry.');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_malformed');
  });

  it('rejects the NO_IMAGE sentinel', () => {
    expect(validateSvg('NO_IMAGE').ok).toBe(false);
  });

  it('rejects an HTML document with a precise wrong-root reason', () => {
    const verdict = validateSvg('<html><body>here is a picture</body></html>');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_wrong_root');
    expect(verdict.reason).toMatch(/html/);
  });

  it('rejects a truncated document, which is what a token limit produces', () => {
    const verdict = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64"',
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_malformed');
    expect(verdict.reason).toMatch(/unclosed|well-formed/i);
  });

  it('rejects unbalanced nesting', () => {
    const verdict = validateSvg(doc('<g><rect width="64" height="64"/></g></svg>'));
    expect(verdict.ok).toBe(false);
  });

  it('rejects duplicate XML attributes before rasterization', () => {
    const verdict = validateSvg(doc('<line x1="0" y1="0" x2="64" y1="64" stroke="#000"/>'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_malformed');
    expect(verdict.reason).toMatch(/attribute.*unique|repeats/i);
  });

  it('rejects a root without the SVG namespace', () => {
    const verdict = validateSvg('<svg width="64" height="64"><rect width="64" height="64"/></svg>');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_missing_namespace');
  });

  it('rejects an empty payload', () => {
    expect(validateSvg('').ok).toBe(false);
  });
});

describe('validateSvg — unsafe output', () => {
  it('rejects a script element', () => {
    const verdict = validateSvg(doc('<script>alert(1)</script><rect width="64" height="64"/>'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_element');
  });

  it('rejects a script element regardless of namespace prefix', () => {
    const verdict = validateSvg(doc('<x:script>alert(1)</x:script><rect width="64" height="64"/>'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_element');
  });

  it('rejects a foreignObject', () => {
    const verdict = validateSvg(
      doc('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_element');
  });

  it('rejects a nested iframe', () => {
    const verdict = validateSvg(
      doc('<iframe src="https://example.com"/><rect width="8" height="8"/>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_element');
  });

  it.each(['onload', 'onclick', 'onerror', 'onmouseover'])(
    'rejects the %s event handler on any element',
    (handler) => {
      const verdict = validateSvg(doc(`<rect width="64" height="64" ${handler}="alert(1)"/>`));
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.code).toBe('svg_unsafe_attribute');
    },
  );

  it('rejects an event handler on the root element', () => {
    const verdict = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" onload="alert(1)"><rect width="8" height="8"/></svg>',
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_attribute');
  });

  it('rejects a DOCTYPE declaration', () => {
    const verdict = validateSvg(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
        '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
        doc('<rect width="64" height="64"/>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_doctype');
  });

  it('rejects the billion-laughs entity expansion', () => {
    const bomb =
      '<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>' +
      doc('<rect width="64" height="64" fill="&b;"/>');
    const verdict = validateSvg(bomb);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_doctype');
  });

  it('rejects an undeclared entity reference', () => {
    const verdict = validateSvg(doc('<rect width="64" height="64" fill="&xxe;"/>'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_doctype');
  });

  it('rejects an external http reference', () => {
    const verdict = validateSvg(
      doc('<image href="https://evil.example.com/x.png" width="8" height="8"/>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_reference');
  });

  it('rejects a javascript: reference', () => {
    const verdict = validateSvg(
      doc('<a href="javascript:alert(1)"><rect width="64" height="64"/></a>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_reference');
  });

  it('rejects a javascript: reference obfuscated with entities and mixed case', () => {
    const verdict = validateSvg(
      doc('<a href="&#x6A;ava&#x53;cript:alert(1)"><rect width="64" height="64"/></a>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_reference');
  });

  it('rejects an embedded data: raster, which would bypass the whole gate', () => {
    const verdict = validateSvg(
      doc('<image href="data:image/png;base64,AAAA" width="64" height="64"/>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_reference');
  });

  it('rejects an xlink:href that leaves the document', () => {
    const verdict = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8">' +
        '<use xlink:href="https://evil.example.com/x.svg#a"/></svg>',
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_reference');
  });

  it('rejects a url() in a style attribute that loads off-document', () => {
    const verdict = validateSvg(
      doc('<rect width="64" height="64" style="fill:url(https://evil.example.com/f.svg#g)"/>'),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_unsafe_reference');
  });

  it('does not mistake a stylesheet rule for an event handler', () => {
    // `only-of-type` is a legitimate CSS selector; the on-prefix rule must apply to
    // attributes, not to the contents of a <style> element.
    const verdict = validateSvg(
      doc('<style>rect:only-of-type{fill:#f00}</style><rect width="64" height="64"/>'),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('validateSvg — bounds', () => {
  it('rejects a payload over the byte limit', () => {
    const huge = doc(
      `<rect width="64" height="64" fill="#fff" data-pad="${'x'.repeat(MAX_SVG_BYTES)}"/>`,
    );
    const verdict = validateSvg(huge);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('svg_too_large');
  });

  it('rejects implausibly deep nesting', () => {
    const deep = doc('<g>'.repeat(600) + '<rect width="64" height="64"/>');
    const verdict = validateSvg(deep);
    expect(verdict.ok).toBe(false);
  });

  it('rejects binary content in the payload', () => {
    const verdict = validateSvg(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x3c, 0x73, 0x76, 0x67]));
    expect(verdict.ok).toBe(false);
  });
});

describe('sniffImageMime', () => {
  it('identifies a PNG', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
  });

  it('identifies a JPEG', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('identifies a GIF', () => {
    expect(sniffImageMime(Buffer.from('GIF89a', 'latin1'))).toBe('image/gif');
  });

  it('identifies an SVG from its markup', () => {
    expect(sniffImageMime(Buffer.from(VALID, 'utf8'))).toBe(SVG_MIME);
  });

  it('identifies an SVG behind an XML declaration', () => {
    expect(sniffImageMime(Buffer.from(`<?xml version="1.0"?>${VALID}`, 'utf8'))).toBe(SVG_MIME);
  });

  it('returns null for text that is neither', () => {
    expect(sniffImageMime(Buffer.from('hello there', 'utf8'))).toBeNull();
  });
});

describe('rasterizeSvgToPng', () => {
  it('produces a payload with real PNG magic bytes', () => {
    const { png, width, height } = rasterizeSvgToPng(VALID, { width: 128 });

    expect(png.byteLength).toBeGreaterThan(0);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
    // The IHDR chunk must follow the signature, or this is not a decodable PNG.
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect(width).toBe(128);
    expect(height).toBe(128);
  });

  it('preserves the document aspect ratio when fitting to width', () => {
    const wide = doc('<rect width="300" height="150"/>', 'viewBox="0 0 300 150"');
    const { width, height } = rasterizeSvgToPng(wide, { width: 300 });
    expect(width).toBe(300);
    expect(height).toBe(150);
  });

  it('derives a size from the document when none is requested', () => {
    const { width, height } = rasterizeSvgToPng(VALID);
    expect(width).toBe(64);
    expect(height).toBe(64);
  });

  it('produces a decodable 8-bit PNG colour type', () => {
    const { png } = rasterizeSvgToPng(VALID, { width: 32 });
    // IHDR: width(4) height(4) bitDepth(1) colourType(1)
    expect(png[24]).toBe(8);
    expect([0, 2, 4, 6]).toContain(png[25]);
  });

  it('throws a RasterizeError rather than returning an empty payload', () => {
    // A zero-sized viewport validates structurally — the document is well-formed and the
    // geometry is real — but the renderer cannot produce a canvas from it. Surfaced as a
    // throw so the provider reports a terminal failure instead of an empty image.
    const degenerate = doc('<rect width="0" height="0"/>', 'width="0" height="0"');
    expect(() => rasterizeSvgToPng(degenerate)).toThrow(RasterizeError);
  });

  it('keeps every raster inside the declared pixel budget', () => {
    // The document's own viewBox cannot be trusted as a size: a model can write an
    // enormous one. Fitting to an explicit width is what bounds the allocation.
    const oversized =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000">' +
      '<rect width="100000" height="100000" fill="#123456"/></svg>';
    const { png, width } = rasterizeSvgToPng(oversized, { width: 64 });
    expect(width).toBe(64);
    // 64x64 PNG lands in the low kilobytes; an unbounded render is orders of magnitude more.
    expect(png.byteLength).toBeLessThan(200_000);
  });

  it('bounds a document that declares an enormous size with no caller width', () => {
    // Regression: this document asks for a 100000x100000 canvas. Rendering it at its own
    // declared size tries to allocate roughly 40 GB from a single prompt, with no malformed
    // markup involved. The size must be clamped BEFORE the renderer is constructed, or the
    // clamp runs after the allocation it exists to prevent.
    const oversized =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000" ' +
      'viewBox="0 0 100000 100000"><rect width="100000" height="100000" fill="#123456"/></svg>';

    const { png, width, height } = rasterizeSvgToPng(oversized);

    expect(width).toBe(MAX_RASTER_EDGE);
    expect(height).toBe(MAX_RASTER_EDGE);
    expect(width * height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(png[0]).toBe(0x89);
  });

  it('clamps an explicit width beyond the edge budget', () => {
    const { width } = rasterizeSvgToPng(VALID, { width: 999_999 });
    expect(width).toBe(MAX_RASTER_EDGE);
  });

  it('bounds an extreme aspect ratio on the long edge', () => {
    const banner =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100">' +
      '<rect width="100000" height="100" fill="#123456"/></svg>';
    const { width } = rasterizeSvgToPng(banner);
    expect(width).toBeLessThanOrEqual(MAX_RASTER_EDGE);
  });
});
