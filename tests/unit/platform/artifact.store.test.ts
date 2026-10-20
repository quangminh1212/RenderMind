import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateFetchUrl,
  toDataUri,
  stripDataUri,
  materializeImages,
  inlineAsBase64,
} from '../../../src/platform/artifact.store';
import { ProviderError } from '../../../src/engine/errors';
import type { GeneratedImage, ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Artifact store tests.
 *
 * Covers SSRF prevention (validateFetchUrl), data URI helpers, and the
 * materializeImages pipeline that converts URL images to base64 when
 * the caller asks for base64 delivery.
 */

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── validateFetchUrl ───────────────────────────────────────

describe('validateFetchUrl', () => {
  it('allows valid public HTTP URLs', () => {
    expect(() => validateFetchUrl('http://example.com/img.png', 'test')).not.toThrow();
  });

  it('allows valid public HTTPS URLs', () => {
    expect(() => validateFetchUrl('https://cdn.example.com/image.webp', 'test')).not.toThrow();
  });

  it('blocks file:// scheme', () => {
    expect(() => validateFetchUrl('file:///etc/passwd', 'test')).toThrow(ProviderError);
  });

  it('blocks ftp:// scheme', () => {
    expect(() => validateFetchUrl('ftp://example.com/img.png', 'test')).toThrow(ProviderError);
  });

  it('blocks non-http(s) scheme with artifact_fetch_blocked code', () => {
    try {
      validateFetchUrl('file:///etc/passwd', 'test');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).code).toBe('artifact_fetch_blocked');
    }
  });

  it('blocks 127.x.x.x loopback', () => {
    expect(() => validateFetchUrl('http://127.0.0.1/secret', 'test')).toThrow(ProviderError);
  });

  it('blocks 169.254.x.x link-local', () => {
    expect(() => validateFetchUrl('http://169.254.1.1/metadata', 'test')).toThrow(ProviderError);
  });

  it('blocks 10.x.x.x private range', () => {
    expect(() => validateFetchUrl('http://10.0.0.1/internal', 'test')).toThrow(ProviderError);
  });

  it('blocks 172.16.x.x private range', () => {
    expect(() => validateFetchUrl('http://172.16.0.1/internal', 'test')).toThrow(ProviderError);
  });

  it('blocks 172.31.x.x private range (upper bound)', () => {
    expect(() => validateFetchUrl('http://172.31.255.255/internal', 'test')).toThrow(ProviderError);
  });

  it('allows 172.15.x.x (just below private range)', () => {
    expect(() => validateFetchUrl('http://172.15.0.1/test', 'test')).not.toThrow();
  });

  it('blocks 192.168.x.x private range', () => {
    expect(() => validateFetchUrl('http://192.168.1.1/internal', 'test')).toThrow(ProviderError);
  });

  it('blocks 100.64.x.x carrier-grade NAT', () => {
    expect(() => validateFetchUrl('http://100.64.0.1/test', 'test')).toThrow(ProviderError);
  });

  it('blocks 100.127.x.x carrier-grade NAT (upper bound)', () => {
    expect(() => validateFetchUrl('http://100.127.255.255/test', 'test')).toThrow(ProviderError);
  });

  it('allows 100.63.x.x (just below carrier-grade NAT)', () => {
    expect(() => validateFetchUrl('http://100.63.0.1/test', 'test')).not.toThrow();
  });

  it('blocks 198.18.x.x benchmarking range', () => {
    expect(() => validateFetchUrl('http://198.18.0.1/test', 'test')).toThrow(ProviderError);
  });

  it('blocks 198.19.x.x benchmarking range', () => {
    expect(() => validateFetchUrl('http://198.19.255.255/test', 'test')).toThrow(ProviderError);
  });

  it('blocks cloud metadata endpoint 169.254.169.254', () => {
    expect(() => validateFetchUrl('http://169.254.169.254/latest/meta-data/', 'test')).toThrow(
      ProviderError,
    );
  });

  it('blocks metadata.google.internal', () => {
    expect(() =>
      validateFetchUrl('http://metadata.google.internal/computeMetadata/v1/', 'test'),
    ).toThrow(ProviderError);
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(() => validateFetchUrl('http://[::1]/secret', 'test')).toThrow(ProviderError);
  });

  it('blocks IPv6 link-local fe80::', () => {
    expect(() => validateFetchUrl('http://[fe80::1]/test', 'test')).toThrow(ProviderError);
  });

  it('blocks IPv4-mapped IPv6 loopback in dotted form', () => {
    expect(() => validateFetchUrl('http://[::ffff:127.0.0.1]/test', 'test')).toThrow(ProviderError);
  });

  it('blocks IPv4-mapped IPv6 loopback in hexadecimal form', () => {
    expect(() => validateFetchUrl('http://[::ffff:7f00:1]/test', 'test')).toThrow(ProviderError);
  });

  it('blocks IPv6 unique-local addresses', () => {
    expect(() => validateFetchUrl('http://[fd00::1]/test', 'test')).toThrow(ProviderError);
  });

  it('rejects invalid URL format', () => {
    expect(() => validateFetchUrl('not-a-url', 'test')).toThrow(ProviderError);
  });

  it('rejects invalid URL with artifact_fetch_failed code', () => {
    try {
      validateFetchUrl('not-a-url', 'test');
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as ProviderError).code).toBe('artifact_fetch_failed');
    }
  });
});

// ─── toDataUri ──────────────────────────────────────────────

describe('toDataUri', () => {
  it('builds a correct data URI', () => {
    expect(toDataUri('QUJD', 'image/png')).toBe('data:image/png;base64,QUJD');
  });

  it('handles jpeg mime type', () => {
    expect(toDataUri('abc', 'image/jpeg')).toBe('data:image/jpeg;base64,abc');
  });

  it('handles webp mime type', () => {
    expect(toDataUri('xyz', 'image/webp')).toBe('data:image/webp;base64,xyz');
  });
});

// ─── stripDataUri ───────────────────────────────────────────

describe('stripDataUri', () => {
  it('strips data URI prefix and returns base64 + mime', () => {
    const result = stripDataUri('data:image/png;base64,QUJD');
    expect(result.base64).toBe('QUJD');
    expect(result.mime).toBe('image/png');
  });

  it('passes through bare base64 strings', () => {
    const result = stripDataUri('QUJD');
    expect(result.base64).toBe('QUJD');
    expect(result.mime).toBeUndefined();
  });

  it('handles data URIs with various mime types', () => {
    const result = stripDataUri('data:image/jpeg;base64,abc123');
    expect(result.base64).toBe('abc123');
    expect(result.mime).toBe('image/jpeg');
  });

  it('handles base64 with special characters (multiline)', () => {
    const result = stripDataUri('data:image/png;base64,QUJD\nRGU=');
    expect(result.base64).toBe('QUJD\nRGU=');
    expect(result.mime).toBe('image/png');
  });
});

// ─── materializeImages ──────────────────────────────────────

describe('materializeImages', () => {
  function baseRequest(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
    return {
      prompt: 'test',
      count: 1,
      size: null,
      aspect: null,
      quality: null,
      output: { format: 'png', delivery: 'url' },
      ...over,
    };
  }

  it('passes through when delivery is url', async () => {
    const images: GeneratedImage[] = [{ url: 'https://example.com/img.png', mime: 'image/png' }];
    const result = await materializeImages(images, baseRequest(), 'test');
    expect(result).toEqual(images);
  });

  it('inlines URL images when delivery is base64', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-length') return '100';
          if (name === 'content-type') return 'image/png';
          return null;
        },
      },
      arrayBuffer: async () => new Uint8Array(Buffer.from('hello')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const images: GeneratedImage[] = [
      { url: 'https://cdn.example.com/img.png', mime: 'image/png' },
    ];
    const result = await materializeImages(
      images,
      baseRequest({ output: { format: 'png', delivery: 'base64' } }),
      'test',
    );

    expect(result).toHaveLength(1);
    expect(result[0].base64).toBe(Buffer.from('hello').toString('base64'));
    expect(result[0].url).toBe('https://cdn.example.com/img.png');
  });

  it('revalidates redirect targets before following them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: {
        get: (name: string) => (name === 'location' ? 'http://127.0.0.1/metadata' : null),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(inlineAsBase64('https://cdn.example.com/img.png', 'test')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'artifact_fetch_blocked',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops reading a streamed response once it exceeds the byte limit', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const read = vi.fn().mockResolvedValue({
      done: false,
      value: { byteLength: 25 * 1024 * 1024 + 1 } as Uint8Array,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read, cancel, releaseLock }) },
      }),
    );

    await expect(inlineAsBase64('https://cdn.example.com/img.png', 'test')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'artifact_too_large',
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('passes through existing base64 images for base64 delivery', async () => {
    const images: GeneratedImage[] = [{ base64: 'QUJD', mime: 'image/png' }];
    const result = await materializeImages(
      images,
      baseRequest({ output: { format: 'png', delivery: 'base64' } }),
      'test',
    );

    expect(result).toHaveLength(1);
    expect(result[0].base64).toBe('QUJD');
  });

  it('throws on missing payload (neither base64 nor url)', async () => {
    const images: GeneratedImage[] = [{ mime: 'image/png' }];

    await expect(
      materializeImages(
        images,
        baseRequest({ output: { format: 'png', delivery: 'base64' } }),
        'test',
      ),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'artifact_missing_payload',
    });
  });

  it('throws on oversized base64 payload', async () => {
    const oversizedBase64 = 'a'.repeat(40 * 1024 * 1024); // well over MAX_BASE64_CHARS
    const images: GeneratedImage[] = [{ base64: oversizedBase64, mime: 'image/png' }];

    await expect(
      materializeImages(
        images,
        baseRequest({ output: { format: 'png', delivery: 'base64' } }),
        'test',
      ),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'artifact_too_large',
    });
  });

  it('applies default mime from format when base64 image has no mime', async () => {
    const images: GeneratedImage[] = [{ base64: 'QUJD' }]; // no mime
    const result = await materializeImages(
      images,
      baseRequest({ output: { format: 'jpeg', delivery: 'base64' } }),
      'test',
    );

    expect(result[0].mime).toBe('image/jpeg');
  });
});
