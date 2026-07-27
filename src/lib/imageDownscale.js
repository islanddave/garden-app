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

/**
 * Downscale an image File so its long edge is <= maxEdge, re-encoding at `quality`.
 * Returns a NEW File on success, or the ORIGINAL file unchanged on any failure / non-benefit.
 */
export async function downscaleImage(file, opts = {}) {
  const {
    maxEdge = MAX_EDGE_PX,
    quality = JPEG_QUALITY,
    minBytes = MIN_BYTES,
  } = opts;

  try {
    if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) return file;
    if (typeof file.size === 'number' && file.size < minBytes) return file;
    if (typeof createImageBitmap !== 'function') return file;

    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return file; // undecodable codec (e.g. HEIC where unsupported) — upload the original
    }

    const { width, height } = bitmap;
    if (!width || !height) { bitmap.close?.(); return file; }

    const longEdge = Math.max(width, height);
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = makeCanvas(w, h);
    if (!canvas) { bitmap.close?.(); return file; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return file; }

    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const type = outputTypeFor(file.type);
    const blob = await toBlob(canvas, type, quality);
    if (!blob || !blob.size) return file;

    // Re-encoding can LOSE: an already-optimized small JPEG, or a flat PNG, can come out
    // bigger. Only adopt the result when it actually saves bytes.
    if (typeof file.size === 'number' && blob.size >= file.size) return file;

    return new File([blob], renameFor(file.name, type), {
      type,
      lastModified: file.lastModified ?? Date.now(),
    });
  } catch {
    return file; // belt-and-braces: never let this path fail an upload
  }
}

export default downscaleImage;
