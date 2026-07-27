// BUG-PHOTOBLANK-001 — downscaleImage contract tests.
// The load-bearing property is FAIL-SAFE: every failure path must hand back the ORIGINAL file
// so a resize problem degrades to today's behavior instead of losing a photo. jsdom has no
// canvas 2d context, so the "no canvas" fallback is exercised for free by the default env.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  downscaleImage, downscaleWithThumb,
  MAX_EDGE_PX, JPEG_QUALITY, MIN_BYTES, THUMB_EDGE_PX, THUMB_QUALITY,
} from '../lib/imageDownscale.js';

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

// Thumbs for NEW uploads. Only the 913 backfilled photos had thumbs; every upload after the
// backfill fell back to its full-size original because nothing generated one.
describe('downscaleWithThumb', () => {
  function stubPipeline({ width, height, outBytes, type = 'image/jpeg' }) {
    const drawImage = vi.fn();
    const close = vi.fn();
    const sizes = [];
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close }));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(w, h) { this.width = w; this.height = h; sizes.push([w, h]); }
      getContext() { return { drawImage }; }
      convertToBlob({ type: t } = {}) {
        return Promise.resolve(new Blob([new Uint8Array(outBytes)], { type: t || type }));
      }
    });
    return { drawImage, close, sizes };
  }

  it('fail-safe: returns the ORIGINAL file and a null thumb when it cannot decode', async () => {
    const f = fakeFile('x.jpg', 'image/jpeg', 4_000_000);
    const out = await downscaleWithThumb(f);            // jsdom: no createImageBitmap
    expect(out.file).toBe(f);
    expect(out.thumb).toBeNull();
  });

  it('fail-safe on a non-image and on nullish input', async () => {
    const t = fakeFile('notes.txt', 'text/plain', 4_000_000);
    expect(await downscaleWithThumb(t)).toEqual({ file: t, thumb: null });
    expect(await downscaleWithThumb(null)).toEqual({ file: null, thumb: null });
  });

  it('produces BOTH the 2048px upload file and an 800px thumb from ONE decode', async () => {
    const { sizes } = stubPipeline({ width: 4032, height: 3024, outBytes: 300_000 });
    const out = await downscaleWithThumb(fakeFile('DSC.jpg', 'image/jpeg', 6_000_000));
    // exactly one decode — a second would double peak native memory on mobile
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(out.file.name).toBe('DSC.jpg');
    expect(out.thumb).toBeInstanceOf(Blob);
    // 4032x3024 -> main 2048x1536, thumb 800x600
    expect(sizes).toEqual([[MAX_EDGE_PX, 1536], [THUMB_EDGE_PX, 600]]);
  });

  it('closes the ImageBitmap (native buffer the GC cannot see — the mobile OOM mechanism)', async () => {
    const { close } = stubPipeline({ width: 4032, height: 3024, outBytes: 300_000 });
    await downscaleWithThumb(fakeFile('DSC.jpg', 'image/jpeg', 6_000_000));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('thumb is JPEG even for a PNG source, since thumbs/<key> keeps the original extension', async () => {
    stubPipeline({ width: 3000, height: 3000, outBytes: 400_000, type: 'image/png' });
    const out = await downscaleWithThumb(fakeFile('chart.png', 'image/png', 5_000_000));
    expect(out.file.type).toBe('image/png');   // main keeps PNG (no flattened transparency)
    expect(out.thumb.type).toBe('image/jpeg'); // thumb always JPEG, matching the sips backfill
  });

  it('skips the thumb when the image is already no larger than the thumb edge', async () => {
    const { sizes } = stubPipeline({ width: 640, height: 480, outBytes: 90_000 });
    const out = await downscaleWithThumb(fakeFile('small.jpg', 'image/jpeg', 4_000_000));
    expect(out.thumb).toBeNull();
    expect(sizes).toEqual([[640, 480]]); // main render only
  });

  it('still makes a thumb for a big-but-light image that skips the main re-encode', async () => {
    // Under MIN_BYTES the full re-encode is not worth it, but a 3000px photo still owes a thumb.
    const f = fakeFile('light.jpg', 'image/jpeg', MIN_BYTES - 1);
    const { sizes } = stubPipeline({ width: 3000, height: 2000, outBytes: 40_000 });
    const out = await downscaleWithThumb(f);
    expect(out.file).toBe(f);                      // main untouched
    expect(out.thumb).toBeInstanceOf(Blob);        // thumb still produced
    expect(sizes).toEqual([[THUMB_EDGE_PX, 533]]); // only the thumb was rendered
  });

  it('thumb defaults match the sips backfill recipe (800px / q80)', () => {
    expect(THUMB_EDGE_PX).toBe(800);
    expect(THUMB_QUALITY).toBe(0.8);
  });
});
