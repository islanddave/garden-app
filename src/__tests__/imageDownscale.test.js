// BUG-PHOTOBLANK-001 — downscaleImage contract tests.
// The load-bearing property is FAIL-SAFE: every failure path must hand back the ORIGINAL file
// so a resize problem degrades to today's behavior instead of losing a photo. jsdom has no
// canvas 2d context, so the "no canvas" fallback is exercised for free by the default env.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { downscaleImage, MAX_EDGE_PX, JPEG_QUALITY, MIN_BYTES } from '../lib/imageDownscale.js';

function fakeFile(name, type, size) {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('downscaleImage — fail-safe contract', () => {
  it('returns the original for a non-image file', async () => {
    const f = fakeFile('notes.pdf', 'application/pdf', 5_000_000);
    expect(await downscaleImage(f)).toBe(f);
  });

  it('returns the original for null/undefined input', async () => {
    expect(await downscaleImage(null)).toBe(null);
    expect(await downscaleImage(undefined)).toBe(undefined);
  });

  it('skips files already under the byte floor (re-encode would cost more than it saves)', async () => {
    const f = fakeFile('small.jpg', 'image/jpeg', MIN_BYTES - 1);
    expect(await downscaleImage(f)).toBe(f);
  });

  it('returns the original when createImageBitmap is unavailable', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const f = fakeFile('big.jpg', 'image/jpeg', 8_000_000);
    expect(await downscaleImage(f)).toBe(f);
  });

  it('returns the original when the codec cannot be decoded (HEIC on an unsupporting browser)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')));
    const f = fakeFile('IMG_1234.heic', 'image/heic', 9_000_000);
    expect(await downscaleImage(f)).toBe(f);
  });

  it('returns the original when decode yields zero dimensions', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 0, height: 0, close: vi.fn() }));
    const f = fakeFile('broken.jpg', 'image/jpeg', 3_000_000);
    expect(await downscaleImage(f)).toBe(f);
  });

  it('requests EXIF orientation from the image so portrait photos are not rotated', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('stop after the call'));
    vi.stubGlobal('createImageBitmap', spy);
    await downscaleImage(fakeFile('portrait.jpg', 'image/jpeg', 4_000_000));
    expect(spy).toHaveBeenCalledWith(expect.anything(), { imageOrientation: 'from-image' });
  });

  it('never throws, whatever createImageBitmap does', async () => {
    vi.stubGlobal('createImageBitmap', () => { throw new Error('boom'); });
    const f = fakeFile('x.jpg', 'image/jpeg', 4_000_000);
    await expect(downscaleImage(f)).resolves.toBe(f);
  });
});

describe('downscaleImage — re-encode path', () => {
  // Drive the full path with a stubbed bitmap + OffscreenCanvas so the resize math and the
  // "only adopt a SMALLER result" rule are covered without a real canvas.
  function stubPipeline({ width, height, outBytes, type = 'image/jpeg' }) {
    const drawImage = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close: vi.fn() }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { drawImage }; }
      // A REAL Blob — File recomputes size from content, so a {size} stub would read as 0.
      convertToBlob() { return Promise.resolve(new Blob([new Uint8Array(outBytes)], { type })); }
    });
    return { drawImage };
  }

  it('scales the long edge down to MAX_EDGE_PX and preserves aspect ratio', async () => {
    const { drawImage } = stubPipeline({ width: 4032, height: 3024, outBytes: 400_000 });
    const out = await downscaleImage(fakeFile('DSC.jpg', 'image/jpeg', 6_000_000));
    // 4032x3024 -> long edge 2048 => 2048x1536
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, MAX_EDGE_PX, 1536);
    expect(out.size).toBe(400_000);
    expect(out.name).toBe('DSC.jpg');
  });

  it('keeps the original when the re-encode came out no smaller', async () => {
    stubPipeline({ width: 3000, height: 2000, outBytes: 7_000_000 });
    const f = fakeFile('already-optimized.jpg', 'image/jpeg', 6_000_000);
    expect(await downscaleImage(f)).toBe(f);
  });

  it('normalizes an undersized-but-heavy image without upscaling it', async () => {
    const { drawImage } = stubPipeline({ width: 800, height: 600, outBytes: 100_000 });
    await downscaleImage(fakeFile('wide.jpg', 'image/jpeg', 4_000_000));
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
  });

  it('rewrites the extension when the codec is normalized to JPEG (HEIC -> .jpg)', async () => {
    stubPipeline({ width: 4032, height: 3024, outBytes: 500_000 });
    const out = await downscaleImage(fakeFile('IMG_9999.heic', 'image/heic', 9_000_000));
    expect(out.name).toBe('IMG_9999.jpg');
    expect(out.type).toBe('image/jpeg');
  });

  it('keeps PNG as PNG so transparency is not flattened onto black', async () => {
    stubPipeline({ width: 3000, height: 3000, outBytes: 900_000, type: 'image/png' });
    const out = await downscaleImage(fakeFile('chart.png', 'image/png', 5_000_000));
    expect(out.name).toBe('chart.png');
    expect(out.type).toBe('image/png');
  });

  it('exports sane defaults', () => {
    expect(MAX_EDGE_PX).toBe(2048);
    expect(JPEG_QUALITY).toBeGreaterThan(0.7);
    expect(JPEG_QUALITY).toBeLessThan(1);
  });
});
