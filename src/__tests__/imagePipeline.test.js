// V4-PHOTOBULK-001 Phase 1 — imagePipeline tests.
//
// EXIF cases run against REAL fixture bytes, not mocks — exifr does real binary parsing and a
// mocked parser would prove nothing about it. Fixtures (src/__tests__/fixtures/):
//   onepad-real-exif-nogps.jpg — REAL OnePlus 11 5G EXIF from Dave's corpus, GPS block present
//                                but every rational (0,0). This is the COMMON case (86% of the
//                                702) and the exact shape that produced a false "98% have GPS"
//                                reading during the V4-PHOTOEXIF-001 probe: the block exists,
//                                the fix does not. Its GPS is degenerate in the source bytes —
//                                no real coordinate was ever committed (garden-app is PUBLIC).
//   synthetic-gps.jpg          — fabricated EXIF, GPS at Greenwich (deliberately not Dave's
//                                garden), so the parse can be asserted to exact values.
//   no-exif.jpg                — no EXIF at all; must still upload.
//   large-3000px.jpg           — 3000px, over the 2560 bound; must downscale.
//
// jsdom has no createImageBitmap and no canvas encoder, so resize paths inject via __testing__.impl
// (same seam convention as useUploadPhoto.js). The EXIF + hash paths need no seam — they are real.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCaptureMeta, hashOriginal, resizeImage, prepareForUpload,
  MAX_EDGE, QUALITY, __testing__,
} from '../lib/imagePipeline.js';

// jsdom's Blob/File implement neither arrayBuffer() nor a usable stream, though every browser we
// target has had Blob.arrayBuffer since Chrome 76. This is an ENVIRONMENT gap, not production
// behavior, so patch the environment rather than bend imagePipeline around jsdom. Guarded, and
// local to this file per setup.ts's "keep shared setup minimal" note.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name, type = 'image/jpeg') => {
  const buf = readFileSync(join(HERE, 'fixtures', name));
  return new File([buf], name, { type });
};

describe('readCaptureMeta — real EXIF bytes', () => {
  it('extracts the real capture time from an actual OnePlus photo', async () => {
    const m = await readCaptureMeta(fixture('onepad-real-exif-nogps.jpg'));
    expect(m.takenAt).toBeInstanceOf(Date);
    // The genuine DateTimeOriginal carried by Dave's file.
    expect(m.takenAt.getFullYear()).toBe(2026);
    expect(m.takenAt.getMonth()).toBe(6);      // July (0-indexed)
    expect(m.takenAt.getDate()).toBe(8);
  });

  // THE regression guard for the mistake the probe actually made.
  it('returns NULL gps when the GPS block exists but carries no fix (the 86% case)', async () => {
    const m = await readCaptureMeta(fixture('onepad-real-exif-nogps.jpg'));
    expect(m.gpsLat).toBeNull();
    expect(m.gpsLon).toBeNull();
  });

  it('extracts real coordinates when a genuine fix IS present (the 14% case)', async () => {
    const m = await readCaptureMeta(fixture('synthetic-gps.jpg'));
    expect(m.gpsLat).toBeCloseTo(51.4778, 2);
    expect(m.gpsLon).toBeCloseTo(-0.0015, 2);   // W must be NEGATIVE — a sign error moves the
  });                                            // garden to the wrong hemisphere, silently

  // Regression guard: with exifr's default translateValues, Orientation comes back as the STRING
  // "Horizontal (normal)", so the numeric check silently yielded null on every photo. Caught only
  // by asserting the real value rather than the absence of a crash.
  it('returns Orientation as a NUMBER, not exifr\'s translated string', async () => {
    const m = await readCaptureMeta(fixture('onepad-real-exif-nogps.jpg'));
    expect(typeof m.orientation).toBe('number');
    expect(m.orientation).toBe(1);   // OnePlus rotates pixels physically; tag is always 1
  });

  // The OnePlus DOES write the zone, so taken_at need not rest on a browser-local guess.
  it('carries OffsetTimeOriginal through when the camera wrote one', async () => {
    const m = await readCaptureMeta(fixture('onepad-real-exif-nogps.jpg'));
    expect(m.tzOffset).toBe('-04:00');
  });

  it('returns all-null for a photo with no EXIF, and does not throw', async () => {
    const m = await readCaptureMeta(fixture('no-exif.jpg'));
    expect(m).toEqual({ takenAt: null, tzOffset: null, gpsLat: null, gpsLon: null, orientation: null });
  });

  it('never throws on garbage bytes — EXIF failure must not block an upload', async () => {
    const junk = new File([new Uint8Array([1, 2, 3, 4, 5])], 'x.jpg', { type: 'image/jpeg' });
    await expect(readCaptureMeta(junk)).resolves.toMatchObject({ takenAt: null });
  });

  it('reads only the header slice, not the whole file', async () => {
    // Proves the 128KB bound is real: a File whose slice() is instrumented.
    const f = fixture('large-3000px.jpg');
    let sliceArgs = null;
    const spy = new Proxy(f, {
      get(t, p) {
        if (p === 'slice') return (...a) => { sliceArgs = a; return t.slice(...a); };
        const v = t[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    await readCaptureMeta(spy);
    expect(sliceArgs).toEqual([0, 131072]);
  });
});

describe('hashOriginal', () => {
  it('is stable and sha256-shaped', async () => {
    const a = await hashOriginal(fixture('synthetic-gps.jpg'));
    const b = await hashOriginal(fixture('synthetic-gps.jpg'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('differs for different bytes', async () => {
    const a = await hashOriginal(fixture('synthetic-gps.jpg'));
    const b = await hashOriginal(fixture('no-exif.jpg'));
    expect(a).not.toBe(b);
  });
});

describe('resizeImage', () => {
  const orig = { ...__testing__.impl };
  afterEach(() => Object.assign(__testing__.impl, orig));

  // Minimal canvas/bitmap doubles — jsdom provides neither.
  const stubDecode = ({ width, height, outSize = 1000 }) => {
    let closed = false;
    __testing__.impl.createImageBitmap = async () => ({
      width, height, close: () => { closed = true; },
    });
    __testing__.impl.canvasFactory = (w, h) => ({
      width: w, height: h,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb) => cb(new Blob([new Uint8Array(outSize)], { type: 'image/jpeg' })),
    });
    return { wasClosed: () => closed };
  };

  it('downscales to the 2560 bound preserving aspect ratio', async () => {
    stubDecode({ width: 4096, height: 3072 });
    const r = await resizeImage(fixture('large-3000px.jpg'));
    expect(r.didResize).toBe(true);
    expect(Math.max(r.width, r.height)).toBe(MAX_EDGE);
    expect(r.width).toBe(2560);
    expect(r.height).toBe(1920);              // 3072 * (2560/4096)
  });

  it('handles a PORTRAIT photo (the corpus majority) without swapping the bound', async () => {
    stubDecode({ width: 3072, height: 4096 });
    const r = await resizeImage(fixture('large-3000px.jpg'));
    expect(r.height).toBe(2560);
    expect(r.width).toBe(1920);
  });

  // Rule 3 — the Android OOM mechanism.
  it('ALWAYS closes the ImageBitmap (native memory is not GC-visible)', async () => {
    const s = stubDecode({ width: 4096, height: 3072 });
    await resizeImage(fixture('large-3000px.jpg'));
    expect(s.wasClosed()).toBe(true);
  });

  it('closes the ImageBitmap even when toBlob fails', async () => {
    let closed = false;
    __testing__.impl.createImageBitmap = async () => ({ width: 4096, height: 3072, close: () => { closed = true; } });
    __testing__.impl.canvasFactory = (w, h) => ({
      width: w, height: h, getContext: () => ({ drawImage: () => {} }), toBlob: (cb) => cb(null),
    });
    const r = await resizeImage(fixture('large-3000px.jpg'));
    expect(r.didResize).toBe(false);
    expect(r.reason).toBe('toblob-null');
    expect(closed).toBe(true);
  });

  it('passes PNG through untouched (canvas would turn alpha black)', async () => {
    const png = new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' });
    const r = await resizeImage(png);
    expect(r.didResize).toBe(false);
    expect(r.reason).toBe('not-jpeg');
    expect(r.blob).toBe(png);
  });

  it('never re-encodes an already-small photo into a blurrier one', async () => {
    stubDecode({ width: 800, height: 600 });
    const r = await resizeImage(fixture('synthetic-gps.jpg'));
    expect(r.didResize).toBe(false);
    expect(r.reason).toBe('already-small');
  });

  it('keeps the original when the resize would GROW the file', async () => {
    const f = fixture('large-3000px.jpg');
    stubDecode({ width: 4096, height: 3072, outSize: f.size + 1 });
    const r = await resizeImage(f);
    expect(r.didResize).toBe(false);
    expect(r.reason).toBe('grew');
    expect(r.blob).toBe(f);
  });

  it('falls back to the original when decode throws (HEIC/corrupt) — never drops a photo', async () => {
    __testing__.impl.createImageBitmap = async () => { throw new Error('cannot decode'); };
    const f = fixture('large-3000px.jpg');
    const r = await resizeImage(f);
    expect(r.didResize).toBe(false);
    expect(r.reason).toBe('decode-failed');
    expect(r.blob).toBe(f);
  });
});

describe('prepareForUpload — ordering is the whole point', () => {
  const orig = { ...__testing__.impl };
  afterEach(() => Object.assign(__testing__.impl, orig));

  // Rule 1. If this regresses, every future taken_at is NULL and we re-ship the exact hole the
  // V4-PHOTOEXIF-001 backfill exists to fill.
  it('reads EXIF from the ORIGINAL, so taken_at survives a resize that strips it', async () => {
    // The resized blob deliberately carries NO EXIF — as a real canvas re-encode would not.
    __testing__.impl.createImageBitmap = async () => ({ width: 4096, height: 3072, close() {} });
    __testing__.impl.canvasFactory = (w, h) => ({
      width: w, height: h, getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb) => cb(new Blob([new Uint8Array(500)], { type: 'image/jpeg' })),
    });
    const out = await prepareForUpload(fixture('onepad-real-exif-nogps.jpg'));
    expect(out.didResize).toBe(true);
    expect(out.meta.taken_at).toBeTruthy();
    expect(out.meta.taken_at).toMatch(/^2026-07-08T/);   // the real capture date survived
  });

  // Rule 2. Hashing the resized blob makes the same photo hash differently after a Chrome update.
  it('hashes the ORIGINAL bytes, not the resized blob', async () => {
    const f = fixture('large-3000px.jpg');
    const originalHash = await hashOriginal(f);
    __testing__.impl.createImageBitmap = async () => ({ width: 4096, height: 3072, close() {} });
    __testing__.impl.canvasFactory = (w, h) => ({
      width: w, height: h, getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb) => cb(new Blob([new Uint8Array(64)], { type: 'image/jpeg' })),
    });
    const out = await prepareForUpload(f);
    expect(out.didResize).toBe(true);
    expect(out.meta.content_hash).toBe(originalHash);
    expect(out.meta.file_size_bytes).not.toBe(f.size);   // stored size IS the resized one
  });

  it('pins ext to jpg when it re-encoded, so the key cannot claim the source extension', async () => {
    __testing__.impl.createImageBitmap = async () => ({ width: 4096, height: 3072, close() {} });
    __testing__.impl.canvasFactory = (w, h) => ({
      width: w, height: h, getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb) => cb(new Blob([new Uint8Array(64)], { type: 'image/jpeg' })),
    });
    const out = await prepareForUpload(fixture('large-3000px.jpg'));
    expect(out.explicitExt).toBe('jpg');
    expect(out.blob.type).toBe('image/jpeg');
  });

  it('emits exactly the column shape POST /api/photos needs', async () => {
    const out = await prepareForUpload(fixture('no-exif.jpg'));
    expect(Object.keys(out.meta).sort()).toEqual([
      'content_hash', 'file_size_bytes', 'gps_lat', 'gps_lon',
      'mime_type', 'original_filename', 'taken_at',
    ]);
  });

  it('a no-EXIF photo still uploads, with null metadata', async () => {
    const out = await prepareForUpload(fixture('no-exif.jpg'));
    expect(out.meta.taken_at).toBeNull();
    expect(out.meta.gps_lat).toBeNull();
    expect(out.blob).toBeTruthy();
  });
});

describe('constants match the locked decision', () => {
  it('resizes to 2560 @ 0.85 (Dave 2026-07-16, overriding spec V100 1600)', () => {
    expect(MAX_EDGE).toBe(2560);
    expect(QUALITY).toBe(0.85);
  });
});
