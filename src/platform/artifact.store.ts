import type { GeneratedImage, ImageFormat, ImageGenerationRequest } from '../types/canonical.types';
import { ProviderError } from '../engine/errors';
import { isIP } from 'node:net';

/**
 * Image artifact handling.
 *
 * Why this exists: providers differ in how they hand back pixels. Stability and the
 * openclaw provider return base64; Replicate returns CDN URLs. An openclaw client asking
 * for `response_format: 'b64_json'` must still receive base64 even when the only provider
 * available is Replicate — and the previous implementation instead silently returned a
 * `{url}` for a `b64_json` request, breaking `Buffer.from(data[0].b64_json)` callers.
 *
 * So this inlines URLs when base64 is required, or reports an honest error when it
 * cannot, rather than violating the requested format.
 */

/** Guard against a provider pointing us at an enormous or hostile resource. */
const MAX_INLINE_BYTES = 25 * 1024 * 1024;

/** Fallback character bound used only when a malformed base64 length cannot be decoded. */
const MAX_BASE64_CHARS = Math.ceil(MAX_INLINE_BYTES / 3) * 4;
const MAX_REDIRECTS = 3;

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  // Included for completeness of the mapping. This store only ever normalizes raster
  // payloads: an SVG reaching here has already been validated by platform/svg and, unless
  // the caller explicitly asked for vector output, rasterized at the provider. A bare
  // vector entering this table would mean the rasterization step was skipped.
  svg: 'image/svg+xml',
};

type IPv4 = readonly [number, number, number, number];

function parseIpv4(hostname: string): IPv4 | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return undefined;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return undefined;
  return parts as unknown as IPv4;
}

/** Parse both dotted and hexadecimal IPv4-mapped IPv6 addresses. */
function parseMappedIpv4(hostname: string): IPv4 | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(hostname);
  if (dotted) return parseIpv4(dotted[1]);

  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!hexadecimal) return undefined;

  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return [Math.floor(high / 256), high % 256, Math.floor(low / 256), low % 256];
}

function parseIpv6Groups(hostname: string): number[] | undefined {
  if (isIP(hostname) !== 6) return undefined;

  const [leftText, rightText] = hostname.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const groups = hostname.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : [...left];

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return undefined;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

function blockedIpv4Reason(address: IPv4): string | undefined {
  const [a, b] = address;

  if (a === 127) return 'Blocked access to loopback address';
  if (a === 169 && b === 254) return 'Blocked access to link-local address';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'Blocked access to private network address';
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return 'Blocked access to carrier-grade NAT address';
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return 'Blocked access to benchmarking address';
  }
  return undefined;
}

function throwArtifactBlocked(provider: string, message: string): never {
  throw new ProviderError({
    provider,
    message,
    status: 502,
    code: 'artifact_fetch_blocked',
  });
}

function throwArtifactTooLarge(provider: string, bytes: number): never {
  throw new ProviderError({
    provider,
    message: `Generated image is too large to inline (${bytes} bytes)`,
    status: 502,
    code: 'artifact_too_large',
  });
}

/**
 * Validate a URL before fetching to prevent SSRF attacks.
 *
 * Blocks:
 * - Non-http(s) schemes (file://, ftp://, etc.)
 * - Loopback addresses (127.x, ::1)
 * - Link-local addresses (169.254.x, fe80::)
 * - Private/Documentation ranges (10.x, 172.16-31.x, 192.168.x, 100.64-127.x, 198.18-19.x)
 * - Cloud metadata endpoints (169.254.169.254, metadata.google.internal)
 *
 * Note: This validates the hostname string without DNS resolution. A domain that
 * resolves to a blocked address will bypass this check — this is a known limitation
 * documented in SECURITY.md.
 */
export function validateFetchUrl(url: string, provider: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError({
      provider,
      message: `Invalid image URL: ${url}`,
      status: 502,
      code: 'artifact_fetch_failed',
    });
  }

  // Only allow http and https schemes.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderError({
      provider,
      message: `Blocked non-http(s) URL scheme: ${parsed.protocol}`,
      status: 502,
      code: 'artifact_fetch_blocked',
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  const normalizedHostname = hostname.replace(/^\[/, '').replace(/\]$/, '');

  // Block cloud metadata endpoints (check before IP parsing since they are not IPs).
  if (hostname === 'metadata.google.internal' || hostname === '169.254.169.254') {
    throw new ProviderError({
      provider,
      message: 'Blocked access to cloud metadata endpoint',
      status: 502,
      code: 'artifact_fetch_blocked',
    });
  }

  // Parse IPv4 if the hostname looks like one.
  const ipv4 = parseIpv4(normalizedHostname) ?? parseMappedIpv4(normalizedHostname);
  const ipv4Reason = ipv4 ? blockedIpv4Reason(ipv4) : undefined;
  if (ipv4Reason) throwArtifactBlocked(provider, ipv4Reason);

  // Block IPv6 loopback, unspecified, link-local, ULA, and deprecated site-local
  // addresses. IPv4-mapped/compatible forms are checked against the IPv4 ranges above.
  const ipv6Groups = parseIpv6Groups(normalizedHostname);
  if (ipv6Groups) {
    const allZero = ipv6Groups.every((group) => group === 0);
    const loopback = ipv6Groups.slice(0, 7).every((group) => group === 0) && ipv6Groups[7] === 1;
    const mappedOrCompatible = ipv6Groups.slice(0, 5).every((group) => group === 0);
    if (allZero) throwArtifactBlocked(provider, 'Blocked access to unspecified IPv6 address');
    if (loopback) throwArtifactBlocked(provider, 'Blocked access to IPv6 loopback address');

    const first = ipv6Groups[0];
    if (first >= 0xfe80 && first <= 0xfebf) {
      throwArtifactBlocked(provider, 'Blocked access to IPv6 link-local address');
    }
    if (first >= 0xfc00 && first <= 0xfdff) {
      throwArtifactBlocked(provider, 'Blocked access to IPv6 unique-local address');
    }
    if (first >= 0xfec0 && first <= 0xfeff) {
      throwArtifactBlocked(provider, 'Blocked access to IPv6 site-local address');
    }

    if (mappedOrCompatible) {
      const mappedIpv4: IPv4 = [
        Math.floor(ipv6Groups[6] / 256),
        ipv6Groups[6] % 256,
        Math.floor(ipv6Groups[7] / 256),
        ipv6Groups[7] % 256,
      ];
      const mappedReason = blockedIpv4Reason(mappedIpv4);
      if (mappedReason) throwArtifactBlocked(provider, mappedReason);
    }
  }
}

async function readResponseBody(response: Response, provider: string): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_INLINE_BYTES) throwArtifactTooLarge(provider, buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_INLINE_BYTES) throwArtifactTooLarge(provider, totalBytes);
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The original read/size error is more useful than a secondary cancel error.
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError({
      provider,
      message: `Failed to read generated image: ${error instanceof Error ? error.message : String(error)}`,
      status: 502,
      code: 'artifact_fetch_failed',
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

/**
 * Fetch a remote image and return it as base64.
 *
 * @throws ProviderError when the image cannot be retrieved, so the engine reports a
 *         truthful failure instead of substituting a different response format.
 */
export async function inlineAsBase64(
  url: string,
  provider: string,
  timeoutMs = 30000,
): Promise<{ base64: string; mime: string }> {
  let currentUrl = url;
  let redirectCount = 0;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;

  for (;;) {
    // Validate every hop. Fetch's default redirect handling would otherwise allow a
    // public URL to redirect into a private or metadata address without revalidation.
    validateFetchUrl(currentUrl, provider);

    try {
      response = await fetch(currentUrl, { signal, redirect: 'manual' });
    } catch (error) {
      throw new ProviderError({
        provider,
        message: `Failed to fetch generated image from provider URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
        status: 502,
        code: 'artifact_fetch_failed',
        cause: error,
      });
    }

    if (response.status < 300 || response.status >= 400) break;

    if (redirectCount >= MAX_REDIRECTS) {
      throw new ProviderError({
        provider,
        message: `Provider image URL exceeded the ${MAX_REDIRECTS}-redirect limit`,
        status: 502,
        code: 'artifact_fetch_failed',
      });
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new ProviderError({
        provider,
        message: `Provider image URL returned redirect ${response.status} without a location`,
        status: 502,
        code: 'artifact_fetch_failed',
      });
    }

    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch (error) {
      throw new ProviderError({
        provider,
        message: `Provider image URL returned an invalid redirect location: ${location}`,
        status: 502,
        code: 'artifact_fetch_failed',
        cause: error,
      });
    }
    redirectCount += 1;
  }

  if (!response.ok) {
    throw new ProviderError({
      provider,
      message: `Provider image URL returned ${response.status}`,
      status: 502,
      code: 'artifact_fetch_failed',
    });
  }

  // Reject before buffering when the server advertises an oversized body.
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_INLINE_BYTES) {
    throw new ProviderError({
      provider,
      message: `Generated image is too large to inline (${declaredLength} bytes)`,
      status: 502,
      code: 'artifact_too_large',
    });
  }

  const buffer = await readResponseBody(response, provider);

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
  const mime = contentType?.startsWith('image/') ? contentType : 'image/png';

  return { base64: buffer.toString('base64'), mime };
}

/**
 * Ensure every image can be delivered in the format the caller asked for.
 *
 * - `delivery: 'base64'` — every image gains `base64`; URL-only images are inlined.
 * - `delivery: 'url'`    — every image gains `url`; base64-only providers keep their
 *                          base64 payload and the adapter surfaces it as a data URI.
 *
 * Images that cannot be converted raise rather than being silently dropped: a caller
 * who asked for three images must be told if only two could be produced.
 */
export async function materializeImages(
  images: GeneratedImage[],
  request: ImageGenerationRequest,
  provider: string,
): Promise<GeneratedImage[]> {
  if (request.output.delivery !== 'base64') return images;

  const materialized: GeneratedImage[] = [];

  for (const image of images) {
    // A validated SVG document is itself the payload.
    //
    // The store's whole job is to guarantee that a caller who asked for base64 receives
    // base64, and it enforces that by inlining URLs. A vector document is a third case it
    // did not previously have: there is no raster to inline, and the markup *is* the
    // artifact. Treating it as "missing payload" would fail a perfectly good delivery, so
    // the document is encoded here instead — which keeps the store's invariant intact,
    // because the caller still receives base64.
    if (image.mime === 'image/svg+xml' && image.svg) {
      materialized.push({
        ...image,
        base64: Buffer.from(image.svg, 'utf8').toString('base64'),
      });
      continue;
    }

    if (image.base64) {
      // Apply the byte limit to the decoded payload rather than only its encoded length.
      // Whitespace is ignored by base64 decoders, so remove it before estimating bytes.
      const normalizedBase64 = image.base64.replace(/\s+/g, '');
      const padding = normalizedBase64.endsWith('==') ? 2 : normalizedBase64.endsWith('=') ? 1 : 0;
      const decodedBytes =
        normalizedBase64.length % 4 === 1
          ? undefined
          : Math.max(0, Math.floor((normalizedBase64.length * 3) / 4) - padding);
      if (
        (decodedBytes !== undefined && decodedBytes > MAX_INLINE_BYTES) ||
        (decodedBytes === undefined && normalizedBase64.length > MAX_BASE64_CHARS)
      ) {
        throwArtifactTooLarge(provider, decodedBytes ?? normalizedBase64.length);
      }
      materialized.push({ ...image, mime: image.mime || MIME_BY_FORMAT[request.output.format] });
      continue;
    }

    if (image.url) {
      const inlined = await inlineAsBase64(image.url, provider);
      materialized.push({ ...image, base64: inlined.base64, mime: inlined.mime });
      continue;
    }

    // Neither payload present: this provider returned an empty result.
    // Throw rather than silently dropping, so the caller knows the image could not be
    // materialized — a caller who asked for N images must be told when fewer are delivered.
    throw new ProviderError({
      provider,
      message:
        'Provider returned an image with neither base64 nor url data. ' +
        'The image cannot be delivered in the requested format.',
      status: 502,
      code: 'artifact_missing_payload',
    });
  }

  return materialized;
}

/** Build a data URI for a base64 payload. */
export function toDataUri(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}

/** Strip a data-URI prefix if present, returning the raw base64 and its mime. */
export function stripDataUri(value: string): { base64: string; mime?: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(value);
  if (match) return { base64: match[2], mime: match[1] };
  return { base64: value };
}
