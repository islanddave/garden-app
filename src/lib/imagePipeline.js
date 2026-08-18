// src/lib/imagePipeline.js
// V4-PHOTOBULK-001 Phase 1 — client-side capture-metadata + resize pipeline.
//
// Feeds the columns added by migrations/v4-photobulk-p1/0a-additive-ddl.sql
// (taken_at, gps_lat, gps_lon, content_hash, file_size_bytes, mime_type, original_filename).
//
// ORDER IS LOAD-BEARING. Three rules, each of which silently destroys data if broken:
//
//   1. READ EXIF BEFORE RESIZE. canvas.toBlob() emits a bare JPEG with NO EXIF, so a
//      resize-then-read pipeline writes taken_at/gps NULL on every row — re-shipping the exact
//      hole the V4-PHOTOEXIF-001 backfill exists to fill. 698 existing rows have taken_at NULL
//      for want of this step; do not make it 1400.
//   2. HASH THE ORIGINAL BYTES, never the resized blob. Canvas JPEG encoding is not bit-identical
//      across Chrome versions/hardware, so hashing post-resize makes the same photo hash
//      differently after a browser update -> the (created_by, content_hash) UNIQUE index never
//      fires -> silent duplicate rows, which is the one thing that index exists to prevent.
//   3. ImageBitmap.close() IS MANDATORY. It wraps a large native buffer behind a tiny JS object;
//      the GC sees something small and feels no pressure, so the native memory accumulates until
//      the Android renderer OOM-kills the tab. This is THE mobile crash mechanism here.
//
// Concurrency (deliberately two different numbers — conflating them is the OOM):
//   decode/resize/hash = 1 (serial). A 4096x3072 photo decodes to ~50MB RGBA; 3 at once is
//                            ~150MB of native memory. No throughput win — createImageBitmap
//                            already decodes on Chrome's worker pool.
//   upload             = 3 (see UploadQueueProvider). Blobs are ~900KB by then.
//
// Resize bound: 2560px longest edge @ 0.85 (Dave 2026-07-16, overriding spec V100's 1600).
// S3 holds the ONLY copy — the uploaded file is the permanent ceiling on every future
// derivative, re-crop and 2x zoom. 1600 bought ~5 extra points of bandwidth reduction (96% vs
// 91%) for 60% of the pixels, irreversibly. 2560 still meets the spec's own 90-95% headline.
//
// Non-JPEG passes through untouched: canvas->JPEG turns PNG alpha black, and the corpus is
// 702 jpg / 2 png. Nothing here ever throws — every failure degrades to "upload the original".

// The `lite` build, NOT the default full one and NOT `mini`. Verified empirically against the real
// fixtures rather than taken from the docs:
//   mini — parses GPS but returns DateTimeOriginal UNDEFINED. It would have silently left taken_at
//          NULL forever, re-shipping the exact hole V4-PHOTOEXIF-001 exists to fill. Do not use.
//   lite — DateTimeOriginal + Orientation + GPS + OffsetTimeOriginal all parse, incl. from a
//          128KB slice. 48K vs full's 76K.
//
// LOADED LAZILY (BUG-PHOTOTAKENATNULL-001). It was a static import while this module had no
// non-test caller, so it cost nothing. Wiring readCaptureMeta into useUploadPhoto put all 45,894
// bytes of it in the entry chunk (measured on a before/after `vite build`) — the same chunk
// V4-COLLECTIONSPLIT-001 had just finished shrinking, for a dependency needed only when a photo is
// actually uploaded. Same shape as critterFactsLoader.js and for the same reason its header gives:
// a plain import() whose failure branch is a VALUE, never a throw. A cold offline miss resolves
// null and lands in readCaptureMeta's existing catch, which already yields all-null metadata — so
// a missing chunk costs the capture time, never the photo.
// Idempotent and concurrency-safe: N simultaneous callers share one import() and one chunk fetch.
// A FAILED load clears the cache so a later upload (back on signal) can retry.
let exifrModule = null;
let exifrInflight = null;
function loadExifr() {
  if (exifrModule) return Promise.resolve(exifrModule);
  if (exifrInflight) return exifrInflight;
  exifrInflight = import('exifr/dist/lite.esm.mjs')
    .then((m) => { exifrModule = m.default ?? m; return exifrModule; })
    .catch(() => null)
    .finally(() => { exifrInflight = null; });
  return exifrInflight;
}

export const MAX_EDGE = 2560;
export const QUALITY = 0.85;
// EXIF's APP1 segment sits just after SOI (optionally behind APP0/JFIF) and is capped at 65,533
// bytes by its own 16-bit length field. 128KB covers SOI + APP0 + a maximal APP1 with margin, so
// we read ~128KB of a 10MB file instead of all of it. File.slice() is a lazy view; only the read
// materializes bytes.
export const HEADER_BYTES = 131072;

// Seams for jsdom, which has neither createImageBitmap nor canvas encoding.
// Mirrors the existing __testing__ convention in useUploadPhoto.js.
const impl = {
  createImageBitmap: (...a) => globalThis.createImageBitmap(...a),
  canvasFactory: (w, h) => {
    const c = document.createElement('canvas');   // never appended -> no layout
    c.width = w; c.height = h;
    return c;
  },
  subtle: () => globalThis.crypto?.subtle,
};

const isJpeg = (file) => /^image\/jpe?g$/i.test(file?.type || '');

// A GPS *block* present is meaningless — 63/64 of Dave's photos have one, but only 9/64 carry a
// real fix; the camera writes the container with location off, leaving null refs and NaN
// rationals. Validate the VALUES, never the block. (This exact distinction produced a wrong "98%
// GPS" reading during the V4-PHOTOEXIF-001 probe.)
function cleanCoord(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v === 0) return null;                        // 0/0/0 is "no fix", not the Gulf of Guinea
  return v;
}

/**
 * Capture metadata from the file's EXIF header. Reads ~128KB, not the whole file.
 * Never throws — a photo with no/garbage EXIF returns all-null and still uploads.
 * @returns {Promise<{takenAt: Date|null, tzOffset: string|null, gpsLat: number|null,
 *                    gpsLon: number|null, orientation: number|null}>}
 */
export async function readCaptureMeta(file, { headerBytes = HEADER_BYTES } = {}) {
  const empty = { takenAt: null, tzOffset: null, gpsLat: null, gpsLon: null, orientation: null };
  if (!file) return empty;
  try {
    const exifr = await loadExifr();
    if (!exifr) return empty;   // chunk unreachable (cold offline) -> same degraded result as no EXIF
    const head = file.slice(0, headerBytes);
    // No `pick`: it silently returns nothing on the lite build (verified). It is only an
    // optimization and we already read a bounded slice.
    // translateValues:false: with translation ON, Orientation comes back as the STRING
    // "Horizontal (normal)" rather than 1 — which silently defeated the numeric check below.
    const x = await exifr.parse(head, {
      tiff: true, exif: true, gps: true, ifd0: true, translateValues: false,
    });
    if (!x) return empty;   // no EXIF at all -> exifr returns undefined
    return {
      // DateTimeOriginal is zone-less ("2026:06:16 08:56:00"); exifr yields a browser-local Date.
      // That is right for Dave (one garden, one zone) but IS an assumption. Happily the OnePlus DOES
      // write OffsetTimeOriginal (EXIF 2.31) — verified "-04:00" on a real file — so it is carried
      // through here and a consumer can correct the zone rather than trust the browser's.
      takenAt: x.DateTimeOriginal instanceof Date && !isNaN(x.DateTimeOriginal) ? x.DateTimeOriginal : null,
      tzOffset: x.OffsetTimeOriginal ?? null,
      gpsLat: cleanCoord(x.latitude),
      gpsLon: cleanCoord(x.longitude),
      orientation: typeof x.Orientation === 'number' ? x.Orientation : null,
    };
  } catch {
    return empty;   // corrupt/absent EXIF must never block an upload
  }
}

/**
 * sha256 hex of the ORIGINAL bytes. See rule 2 above.
 * Returns null if WebCrypto is unavailable or the read fails — a null content_hash is a legal,
 * degraded outcome (the photo still uploads; the partial UNIQUE index simply skips it), NOT an
 * error worth blocking on. But it silently disables de-duplication, so say so rather than let it
 * pass unnoticed. crypto.subtle requires a secure context; prod is https, so this should not fire.
 */
export async function hashOriginal(file) {
  if (!file) return null;
  const subtle = impl.subtle();
  if (!subtle) {
    console.warn('imagePipeline: crypto.subtle unavailable (insecure context?) — content_hash null, de-dupe disabled');
    return null;
  }
  try {
    const buf = await file.arrayBuffer();          // the only place the full 10MB materializes
    // Hand digest() a TypedArray VIEW, not the raw ArrayBuffer. Both are legal per spec, but a
    // bare ArrayBuffer is matched by realm: a buffer produced in one realm (jsdom) is rejected by
    // a SubtleCrypto from another (node) with "2nd argument is not instance of ArrayBuffer".
    // Constructing the view here re-anchors it to this realm. Free in a browser, where there is
    // only one realm, and strictly more compatible everywhere.
    const digest = await subtle.digest('SHA-256', new Uint8Array(buf));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    console.warn('imagePipeline: hashing failed — content_hash null, de-dupe disabled:', err?.message ?? err);
    return null;
  }
}

/**
 * Downscale to MAX_EDGE longest edge at QUALITY. JPEG only.
 * NEVER throws: any failure returns the original blob with didResize:false + a reason.
 * @returns {Promise<{blob: Blob, width: number|null, height: number|null,
 *                    didResize: boolean, reason?: string}>}
 */
export async function resizeImage(file, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  const passthrough = (reason) => ({ blob: file, width: null, height: null, didResize: false, reason });
  if (!file) return passthrough('no-file');
  if (!isJpeg(file)) return passthrough('not-jpeg');   // PNG alpha would go black through canvas

  let bitmap = null;
  try {
    // Pass imageOrientation explicitly: the spec default flipped from 'none' to 'from-image' and
    // we don't guess which a given Chrome build does. Dave's corpus is Orientation=1 across the
    // board (the OnePlus rotates pixels physically), so this is defence, not a fix.
    bitmap = await impl.createImageBitmap(file, { imageOrientation: 'from-image' });

    // Size from the DECODED bitmap, never from EXIF ImageWidth/Length: once orientation is
    // applied the dimensions are swapped for 90/270 rotations, and trusting EXIF dims would
    // silently mis-crop exactly the rotated photos.
    const { width: bw, height: bh } = bitmap;
    const longest = Math.max(bw, bh);
    if (!longest) return passthrough('decode-empty');
    if (longest <= maxEdge) return passthrough('already-small');   // never re-encode into blurrier

    const scale = maxEdge / longest;
    const w = Math.round(bw * scale), h = Math.round(bh * scale);
    const canvas = impl.canvasFactory(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return passthrough('no-2d-context');
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise((res) => {
      if (canvas.toBlob) canvas.toBlob(res, 'image/jpeg', quality);
      else res(null);
    });
    if (!blob) return passthrough('toblob-null');        // Chrome returns null under memory pressure
    // A resize that GREW the file is a loss on every axis — keep the original.
    if (blob.size >= file.size) return passthrough('grew');
    return { blob, width: w, height: h, didResize: true };
  } catch {
    // HEIC/corrupt/OOM: Chrome cannot decode HEIC and createImageBitmap throws. Upload the
    // original — the server's sharp build has heif input and can still derive from it.
    return passthrough('decode-failed');
  } finally {
    // Rule 3. Native memory is not released by the GC on its own schedule.
    try { bitmap?.close?.(); } catch { /* close is best-effort */ }
  }
}

/**
 * Full per-photo prep. Serial by construction — call one at a time (see the concurrency note).
 * Returns the blob to upload plus the exact metadata shape POST /api/photos expects.
 */
export async function prepareForUpload(file) {
  // EXIF and hash BOTH read the original, before any resize touches it. Rules 1 and 2.
  const meta = await readCaptureMeta(file);
  const content_hash = await hashOriginal(file);
  const { blob, didResize, width, height, reason } = await resizeImage(file);

  // extFromFile() prefers file.name's extension, so a resized non-jpg would otherwise be stored
  // under the source extension with JPEG bytes. Pin the ext when we re-encoded.
  const explicitExt = didResize ? 'jpg' : null;
  const outBlob = didResize
    ? new File([blob], (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
    : file;

  return {
    blob: outBlob,
    explicitExt,
    didResize,
    resizeReason: reason ?? null,
    dimensions: didResize ? { width, height } : null,
    meta: {
      content_hash,
      file_size_bytes: outBlob.size,        // what we actually stored
      mime_type: outBlob.type || 'image/jpeg',
      original_filename: file.name || null, // low-trust: content:// pickers hand back junk names
      taken_at: meta.takenAt ? meta.takenAt.toISOString() : null,
      gps_lat: meta.gpsLat,
      gps_lon: meta.gpsLon,
    },
  };
}

export const __testing__ = { impl, cleanCoord, isJpeg };
