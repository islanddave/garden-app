// src/lib/imageDownscale.js
// BUG-PHOTOBLANK-001 — client-side downscale before upload.
//
// WHY: nothing in the app ever constrained image size. Uploads PUT the raw camera file to S3
// (a current phone shoots 3-12MB), and the Photos grid then re-downloads those originals —
// 120 per page, measured at 369MB for one load. That saturates a mobile uplink on upload
// ("Save" hangs) and never finishes decoding on display (empty placeholder boxes).
//
// FAIL-SAFE BY CONTRACT: this module NEVER blocks an upload. Every failure path — unsupported
// codec (HEIC on a browser that can't decode it), missing canvas (jsdom/unit tests), a decode
// throw, or a re-encode that came out BIGGER than the original — returns the ORIGINAL File
// untouched. A resize problem must degrade to today's behavior, never to a lost photo.
//
// EXIF ORIENTATION: createImageBitmap(..., { imageOrientation: 'from-image' }) applies the EXIF
// rotation while decoding. Drawing an <img> to a canvas instead would silently DROP orientation
// and land every portrait phone photo sideways — that is why this path is bitmap-only and falls
// back to the original file rather than to an <img> shim.

export const MAX_EDGE_PX = 2048;   // long edge; ~4x a phone screen, still crisp for full-view
export const JPEG_QUALITY = 0.85;  // visually lossless for foliage/soil texture at this scale
export const MIN_BYTES = 512 * 1024; // below this, re-encoding costs more than it saves

// BUG-PHOTOLAZY-001 / thumbs-for-new-uploads. Matches the macOS `sips -Z 800` + q80 recipe used to
// backfill the 913 existing thumbs, so a new upload's thumb is indistinguishable from a backfilled
// one (measured 11-23x smaller than the original: 170-257KB vs 1.9-6.2MB).
export const THUMB_EDGE_PX = 800;
export const THUMB_QUALITY = 0.8;

// Codecs canvas can re-encode. Anything else (notably image/heic) decodes only if the browser
// natively supports it; when it does, we normalize to JPEG.
const KEEP_TYPE = new Set(['image/png', 'image/webp']);

function outputTypeFor(inputType) {
  return KEEP_TYPE.has(inputType) ? inputType : 'image/jpeg';
}

function extFor(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

// Swap the extension so the S3 key + Content-Type stay consistent with the re-encoded bytes
// (buildPhotoKey derives ext from the file we hand back, so a HEIC->JPEG conversion must
// surface as .jpg or the object is stored under a lying extension).
function renameFor(name, mime) {
  const base = String(name ?? 'photo').replace(/\.[^./\\]*$/, '');
  return `${base}.${extFor(mime)}`;
}

async function toBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality }); // OffscreenCanvas
  }
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  // A jsdom canvas has no 2d context; getContext returns null and we bail to the original file.
  c.width = w; c.height = h;
  return c;
}

// Render an already-decoded bitmap down to `maxEdge` and encode it. Returns null when the
// environment has no usable canvas (jsdom) so every caller degrades instead of throwing.
async function renderScaled(bitmap, maxEdge, type, quality) {
  const { width, height } = bitmap;
  const longEdge = Math.max(width, height);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = makeCanvas(w, h);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(bitmap, 0, 0, w, h);
  return toBlob(canvas, type, quality);
}

/**
 * Decode ONCE, produce both the upload file and its 800px thumbnail.
 *
 * WHY ONE DECODE: a 4096x3072 photo decodes to ~50MB of native RGBA, and ImageBitmap hides that
 * behind a tiny JS object so the GC feels no pressure — this is THE mobile renderer-OOM mechanism
 * documented in imagePipeline.js. Decoding a second time just to make a thumb would double the
 * peak on the exact device class where uploads are already reported to hang. So both outputs come
 * off a single bitmap, which is closed in a finally.
 *
 * FAIL-SAFE, same contract as downscaleImage: on ANY problem this returns
 * { file: <the original File>, thumb: null }. A thumb is a nice-to-have — the read path presigns
 * thumbs/<key> and falls back to view_url when the object is missing — so a thumb failure must
 * never cost the upload.
 *
 * Returns { file, thumb } where thumb is a JPEG Blob or null.
 */
export async function downscaleWithThumb(file, opts = {}) {
  const {
    maxEdge = MAX_EDGE_PX,
    quality = JPEG_QUALITY,
    minBytes = MIN_BYTES,
    thumbEdge = THUMB_EDGE_PX,
    thumbQuality = THUMB_QUALITY,
  } = opts;

  const asIs = { file, thumb: null };
  try {
    if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) return asIs;
    if (typeof createImageBitmap !== 'function') return asIs;

    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return asIs; // undecodable codec (e.g. HEIC where unsupported) — upload the original
    }

    try {
      const { width, height } = bitmap;
      if (!width || !height) return asIs;

      // ---- main upload bytes ----
      // Below minBytes, re-encoding the FULL image costs more than it saves, so the original is
      // uploaded as-is. That says nothing about the thumb, which is still a large win — a 400KB
      // 3000px photo makes a ~50KB thumb — so the thumb is decided separately below.
      let outFile = file;
      const worthResizing = !(typeof file.size === 'number' && file.size < minBytes);
      if (worthResizing) {
        const type = outputTypeFor(file.type);
        const blob = await renderScaled(bitmap, maxEdge, type, quality);
        // Re-encoding can LOSE: an already-optimized small JPEG, or a flat PNG, can come out
        // bigger. Only adopt the result when it actually saves bytes.
        if (blob && blob.size && !(typeof file.size === 'number' && blob.size >= file.size)) {
          outFile = new File([blob], renameFor(file.name, type), {
            type,
            lastModified: file.lastModified ?? Date.now(),
          });
        }
      }

      // ---- thumbnail ----
      // Always JPEG regardless of source type: the read path presigns thumbs/<storage_path>, which
      // keeps the ORIGINAL extension, so the object's bytes must be readable as an image by
      // extension-agnostic consumers. JPEG matches the sips backfill exactly.
      // Skipped when the image is already <= thumbEdge — a thumb no smaller than the thing it
      // stands in for is pure waste.
      let thumb = null;
      if (Math.max(width, height) > thumbEdge) {
        const tb = await renderScaled(bitmap, thumbEdge, 'image/jpeg', thumbQuality);
        if (tb && tb.size) thumb = tb;
      }

      return { file: outFile, thumb };
    } finally {
      bitmap.close?.(); // MANDATORY — see imagePipeline.js rule 3 (native buffer, GC can't see it)
    }
  } catch {
    return asIs; // belt-and-braces: never let this path fail an upload
  }
}

/**
 * Downscale an image File so its long edge is <= maxEdge, re-encoding at `quality`.
 * Returns a NEW File on success, or the ORIGINAL file unchanged on any failure / non-benefit.
 *
 * Thin wrapper over downscaleWithThumb so there is ONE resize implementation. thumbEdge=Infinity
 * suppresses thumb work entirely (no image has a long edge > Infinity).
 */
export async function downscaleImage(file, opts = {}) {
  const { file: out } = await downscaleWithThumb(file, { ...opts, thumbEdge: Infinity });
  return out;
}

export default downscaleImage;
