// src/lib/imageMetadataStrip.js
// V4-PHOTOEXIFSTRIP-001 — remove capture metadata from image bytes before they leave the device.
//
// WHY: Dave's garden IS his home, so a GPS tag is his home address. Measured on his own camera
// originals (2026-08-20, 22 files): every Pixel file carries EXIF GPS at 42.5087 / -72.6470 —
// the house. Those bytes reach S3 unmodified on five paths (imageDownscale returns the ORIGINAL
// File for anything under MIN_BYTES, for an undecodable codec, for a missing canvas, and for a
// re-encode that came out bigger; useUploadPhoto's DOWNSCALE_DEADLINE_MS adds a fifth), and the
// 913 photos backfilled before downscale shipped are camera originals by definition. The harvest
// post composer then hands those exact bytes to the Android share sheet. Dave's call, verbatim:
// "strip always".
//
// ALLOWLIST, NOT DENYLIST — this is the whole design, and the corpus is why. Dropping APP1
// (where EXIF and XMP live) is the obvious move and it is NOT ENOUGH:
//   - Samsung appends a raw trailer AFTER the image's EOI carrying `MCC_Data311` (the SIM's
//     mobile country code — US), `Image_UTC_Data<epoch_ms>`, and PhotoEditor_Re_Edit_Data with the
//     on-device path `/data/sec/photoeditor/0/storage/emulated/0/DCIM/Camera/20230211_014150.jpg`.
//     Present on 7 of 7 Samsung files. None of it is EXIF; none of it is in any APP segment.
//   - Pixel appends a whole second JPEG (the Ultra HDR gain map, 7KB-224KB) past the same EOI,
//     and carries APP11 JUMBF — the container format C2PA content credentials ride in.
//   - Trailers were present on 22 of 22 real files. This is the normal case, not an edge case.
// So we keep ONLY the segments a decoder needs to render the image and drop everything else,
// including markers no vendor has invented yet. A denylist is a list of leaks already known.
//
// LOSSLESS BY CONSTRUCTION. The quantization/Huffman tables, the frame header and the
// entropy-coded scan are copied byte-for-byte; nothing is decoded and nothing is re-encoded. The
// decoded pixels are therefore bit-identical, which is the point — a re-encode would cost quality
// AND reintroduce exactly the decode failures the bypass paths exist to avoid (HEIC that will not
// decode, a canvas that is not there, an OOM under memory pressure).
//
// ORIENTATION IS THE LANDMINE. Orientation lives in the EXIF we are dropping, and on the bypass
// paths the pixels are NOT pre-rotated (only the canvas path bakes rotation in, via
// imageOrientation:'from-image'). Naively dropping APP1 lands every portrait phone photo sideways.
// So the Orientation tag is read out of the EXIF before it is discarded and re-emitted as a
// minimal 36-byte APP1 carrying that one tag and nothing else. Values 2-8 only: 1 is the default,
// and omitting it says the same thing while keeping the output genuinely bare.
//
// CONTRACT — DELIBERATELY NOT "never blocks an upload", unlike imageDownscale/imagePipeline next
// to it. Those are optimizations and degrade to shipping the original; this is a privacy control
// and degrading to "ship the original" means shipping the house. stripImageFile returns the input
// unchanged ONLY when the bytes are a format with no strip implementation (HEIC/AVIF) or when
// nothing needed dropping. A FAILED READ THROWS — the caller surfaces it and the user retries,
// which costs one tap; the alternative is silently publishing a home address. A malformed JPEG
// still gets every segment we positively identified dropped (we bail to copying the remainder
// verbatim rather than abandoning the strip).
//
// TWO ENTRY POINTS, TWO POLICIES — BUG-HEICEXIFPASSTHRU-001. The clause above ("returns the input
// unchanged ... for a format with no strip implementation") is a hole a caller can be wrong about,
// and one was: harvestPostPhotos stated "a photo we cannot strip is not shared" while calling the
// LENIENT entry point, so a HEIC went to the Android share sheet with its GPS intact. Measured on
// a real macOS-encoded HEIC/AVIF carrying exifr-readable GPS: byte-identical passthrough on both
// the upload PUT and the share File. So the policy is now named at the call site rather than
// assumed:
//   stripImageFile        — LENIENT. Unstrippable container passes through, console.warn only.
//   stripImageFileStrict  — FAIL CLOSED. Unstrippable container throws UnstrippableFormatError.
// Neither is "the safe one" in the abstract: fail-closed on SHARE costs one photo missing from a
// post, fail-closed on UPLOAD costs the user their photo entirely. Pick per path, deliberately.
//
// Server-side lambda/facebook-share/exif.js is a separate, narrower denylist strip on the Graph
// upload path. It is defence-in-depth on a path this module does not reach; left alone on purpose.

const JPEG = 'jpeg';
const PNG = 'png';
const WEBP = 'webp';

// APPn segments worth keeping, by marker, gated on the identifier string that opens the payload.
// Each is decode- or render-affecting, and none carries capture metadata:
//   APP0 JFIF/JFXX — pixel density + aspect ratio.
//   APP2 ICC_PROFILE — colour management. Dropping it visibly shifts colour on the wide-gamut
//     (Display P3) photos both phones shoot. Note APP2 is ALSO the MPF marker, which indexes the
//     appended gain-map image — that one is dropped by not matching this identifier.
//   APP14 Adobe — the colour-transform declaration. Dropping it inverts a YCCK/CMYK JPEG.
const KEEP_APP = {
  0xE0: ['JFIF\0', 'JFXX\0'],
  0xE2: ['ICC_PROFILE\0'],
  0xEE: ['Adobe'],
};

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input ?? 0);
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function matchesId(b, at, id) {
  if (at + id.length > b.length) return false;
  for (let k = 0; k < id.length; k++) if (b[at + k] !== id.charCodeAt(k)) return false;
  return true;
}

export function isJpeg(b) {
  return b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
}

export function isPng(b) {
  return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
      && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;
}

export function isWebp(b) {
  return b.length >= 12 && matchesId(b, 0, 'RIFF') && matchesId(b, 8, 'WEBP');
}

// Read EXIF IFD0 tag 0x0112 (Orientation) out of an APP1 payload. Deliberately shallow: IFD0 only,
// no SubIFD and no GPS IFD recursion — the one tag we re-emit is the only one we need to find.
// Returns 1-8, or null for anything unparseable (an XMP APP1 lands here and yields null).
function readOrientation(b, payloadAt, payloadEnd) {
  if (!matchesId(b, payloadAt, 'Exif\0\0')) return null;
  const tiff = payloadAt + 6;
  if (tiff + 8 > payloadEnd) return null;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const be = b[tiff] === 0x4D && b[tiff + 1] === 0x4D;
  if (!le && !be) return null;
  const u16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
  const u32 = (p) => (le
    ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
    : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
  if (u16(tiff + 2) !== 42) return null;
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > payloadEnd || ifd0 < tiff) return null;
  const count = u16(ifd0);
  // 12 bytes per entry; a plausible IFD0 is well under this. Bound it so a corrupt count cannot
  // walk us off the end of the segment.
  if (count > 512) return null;
  for (let k = 0; k < count; k++) {
    const e = ifd0 + 2 + k * 12;
    if (e + 12 > payloadEnd) return null;
    if (u16(e) !== 0x0112) continue;
    if (u16(e + 2) !== 3) return null;              // must be SHORT
    const v = u16(e + 8);                            // a SHORT sits in the first 2 bytes of the value field
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

// A complete, minimal EXIF APP1 carrying Orientation and NOTHING else: 36 bytes, big-endian TIFF,
// one IFD0 entry, no next IFD. Emitted only for 2-8.
function buildOrientationApp1(orientation) {
  const seg = new Uint8Array([
    0xFF, 0xE1, 0x00, 0x22,                          // APP1, length 34 (includes these 2 length bytes)
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,              // "Exif\0\0"
    0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,  // MM, 42, IFD0 at offset 8
    0x00, 0x01,                                      // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,  // tag 0x0112, type SHORT, count 1
    0x00, 0x00, 0x00, 0x00,                          // value (filled below) + padding
    0x00, 0x00, 0x00, 0x00,                          // next IFD = 0
  ]);
  seg[29] = orientation & 0xFF;                      // big-endian SHORT: first 2 bytes of the value field
  return seg;
}

// From `p` (start of entropy-coded data), return the offset of the next REAL marker. FF bytes
// inside the scan are byte-stuffed as FF00 and restart markers are FFD0-FFD7 — treating either as
// a segment boundary is how a naive walker truncates the middle of an image.
function scanEntropy(b, p) {
  const n = b.length;
  let i = p;
  while (i + 1 < n) {
    if (b[i] !== 0xFF) { i++; continue; }
    let j = i + 1;
    while (j < n && b[j] === 0xFF) j++;              // fill bytes
    if (j >= n) return n;
    const m = b[j];
    if (m === 0x00) { i = j + 1; continue; }         // stuffed FF, part of the scan
    if (m >= 0xD0 && m <= 0xD7) { i = j + 1; continue; } // restart marker, part of the scan
    return i;
  }
  return n;
}

function keepMarker(b, marker, markerAt, segEnd) {
  if (marker >= 0xC0 && marker <= 0xCF) return true;         // SOFn, DHT (C4), DAC (CC)
  if (marker >= 0xDB && marker <= 0xDF) return true;         // DQT, DNL, DRI, DHP, EXP
  const ids = KEEP_APP[marker];
  if (!ids) return false;                                    // every other APPn, COM, reserved
  return ids.some((id) => markerAt + 3 + id.length <= segEnd && matchesId(b, markerAt + 3, id));
}

/**
 * Strip a JPEG down to its renderable segments. Never throws.
 * @returns {{out: Uint8Array, changed: boolean, format: string, droppedSegments: number,
 *            droppedBytes: number, truncatedTrailer: number, orientation: number|null,
 *            reason: string|null}}
 */
export function stripJpegBytes(input) {
  const b = toBytes(input);
  const n = b.length;
  if (!isJpeg(b)) {
    return { out: b, changed: false, format: null, droppedSegments: 0, droppedBytes: 0, truncatedTrailer: 0, orientation: null, reason: 'not-jpeg' };
  }

  const head = [];      // the synthesized orientation APP1, if any
  const parts = [b.subarray(0, 2)];
  let droppedSegments = 0, droppedBytes = 0, truncatedTrailer = 0, orientation = null, reason = null;
  let i = 2;

  while (i + 1 < n) {
    // Structurally past what we can parse. Copy the remainder verbatim rather than abandoning the
    // strip: whatever we already identified stays dropped, and no image data is lost.
    if (b[i] !== 0xFF) { parts.push(b.subarray(i)); reason = 'desync'; break; }
    let m = i + 1;
    while (m < n && b[m] === 0xFF) m++;
    if (m >= n) { parts.push(b.subarray(i)); reason = 'truncated-marker'; break; }
    const marker = b[m];

    if (marker === 0xD9) {                                    // EOI — everything past it is a trailer
      parts.push(b.subarray(i, m + 1));
      truncatedTrailer = n - (m + 1);
      break;
    }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { parts.push(b.subarray(i, m + 1)); i = m + 1; continue; }
    if (m + 2 >= n) { parts.push(b.subarray(i)); reason = 'truncated-length'; break; }

    const len = (b[m + 1] << 8) | b[m + 2];                   // length INCLUDES its own 2 bytes
    const segEnd = m + 1 + len;
    if (len < 2 || segEnd > n) { parts.push(b.subarray(i)); reason = 'bad-length'; break; }

    if (marker === 0xDA) {                                    // SOS: header, then the scan verbatim
      const next = scanEntropy(b, segEnd);
      parts.push(b.subarray(i, next));
      i = next;
      continue;
    }
    if (keepMarker(b, marker, m, segEnd)) {
      parts.push(b.subarray(i, segEnd));
    } else {
      if (marker === 0xE1 && orientation === null) orientation = readOrientation(b, m + 3, segEnd);
      droppedSegments++;
      droppedBytes += segEnd - i;
    }
    i = segEnd;
  }

  if (orientation !== null && orientation !== 1) head.push(buildOrientationApp1(orientation));
  const out = concat([parts[0], ...head, ...parts.slice(1)]);
  return {
    out,
    changed: out.length !== n,
    format: JPEG,
    droppedSegments,
    droppedBytes,
    truncatedTrailer,
    orientation,
    reason,
  };
}

// PNG chunks a renderer needs. tEXt/zTXt/iTXt hold arbitrary text (XMP with GPS rides in iTXt) and
// eXIf holds a literal EXIF block, GPS IFD and all — every one of them is dropped, along with any
// chunk type not named here. Chunks are copied whole including their CRC, so nothing is recomputed.
const KEEP_PNG = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP',
  'sBIT', 'bKGD', 'pHYs', 'hIST', 'sPLT', 'acTL', 'fcTL', 'fdAT',
]);

/** Strip a PNG to its renderable chunks. Never throws. */
export function stripPngBytes(input) {
  const b = toBytes(input);
  const n = b.length;
  const miss = (reason) => ({ out: b, changed: false, format: reason === 'not-png' ? null : PNG, droppedSegments: 0, droppedBytes: 0, truncatedTrailer: 0, orientation: null, reason });
  if (!isPng(b)) return miss('not-png');

  const parts = [b.subarray(0, 8)];
  let droppedSegments = 0, droppedBytes = 0, reason = null;
  let i = 8;
  while (i + 8 <= n) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const end = i + 12 + len;                                  // len + type(4) + data + crc(4)
    if (end > n) { parts.push(b.subarray(i)); reason = 'bad-length'; break; }
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (KEEP_PNG.has(type)) parts.push(b.subarray(i, end));
    else { droppedSegments++; droppedBytes += end - i; }
    i = end;
    if (type === 'IEND') { droppedBytes += n - i; break; }     // anything past IEND is a trailer
  }
  const out = concat(parts);
  return { out, changed: out.length !== n, format: PNG, droppedSegments, droppedBytes, truncatedTrailer: 0, orientation: null, reason };
}

// RIFF fourccs a WebP decoder needs. 'EXIF' and 'XMP ' are the two metadata chunks and both can
// carry GPS; anything unrecognized is dropped too.
const KEEP_WEBP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

/** Strip a WebP to its renderable chunks. Never throws. */
export function stripWebpBytes(input) {
  const b = toBytes(input);
  const n = b.length;
  if (!isWebp(b)) {
    return { out: b, changed: false, format: null, droppedSegments: 0, droppedBytes: 0, truncatedTrailer: 0, orientation: null, reason: 'not-webp' };
  }
  const parts = [];
  let droppedSegments = 0, droppedBytes = 0, reason = null;
  let i = 12;
  while (i + 8 <= n) {
    const size = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const end = i + 8 + size + (size & 1);                     // chunks are padded to even length
    if (end > n) { parts.push(b.subarray(i)); reason = 'bad-length'; break; }
    const type = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (type === 'VP8X') {
      // The flags byte advertises which metadata chunks follow. Leaving E/X set while dropping the
      // chunks makes the file self-contradictory, so clear them: bit3 EXIF, bit2 XMP.
      const seg = b.slice(i, end);
      if (seg.length > 8) seg[8] &= ~0x0C;
      parts.push(seg);
    } else if (KEEP_WEBP.has(type)) {
      parts.push(b.subarray(i, end));
    } else {
      droppedSegments++;
      droppedBytes += end - i;
    }
    i = end;
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  out.set(body, 12);
  const riffSize = out.length - 8;                             // RIFF size counts everything after it
  out[4] = riffSize & 0xFF; out[5] = (riffSize >> 8) & 0xFF;
  out[6] = (riffSize >> 16) & 0xFF; out[7] = (riffSize >> 24) & 0xFF;
  return { out, changed: out.length !== n, format: WEBP, droppedSegments, droppedBytes, truncatedTrailer: 0, orientation: null, reason };
}

/**
 * Strip by MAGIC BYTES, never by the declared MIME type — a content:// picker hands back junk
 * names and types, and a photo mislabelled image/png must not thereby skip the strip.
 * An unrecognized container (HEIC, AVIF) returns unchanged with format:null; the caller decides.
 */
export function stripImageBytes(input) {
  const b = toBytes(input);
  if (isJpeg(b)) return stripJpegBytes(b);
  if (isPng(b)) return stripPngBytes(b);
  if (isWebp(b)) return stripWebpBytes(b);
  return { out: b, changed: false, format: null, droppedSegments: 0, droppedBytes: 0, truncatedTrailer: 0, orientation: null, reason: 'unsupported-format' };
}

// jsdom's Blob has NEITHER arrayBuffer NOR stream (verified 2026-08-20 — the same reason
// useUploadPhoto's blobToBase64 carries a FileReader branch). Without this fallback every test in
// this area passes vacuously against a Blob that reads as empty.
function readBytes(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
    fr.readAsArrayBuffer(blob);
  });
}

/**
 * Thrown by stripImageFileStrict for a container this module has no walker for (HEIC, AVIF, or
 * anything whose magic bytes match nothing). `message` is written to be shown to a user as-is,
 * because useUploadPhoto surfaces err.message verbatim.
 */
export class UnstrippableFormatError extends Error {
  constructor(type) {
    super(`${type || 'This image format'} can't have its location data removed on this device, so it was not sent. Set the camera to JPEG and try again.`);
    this.name = 'UnstrippableFormatError';
    this.format = type || null;
    this.userFacing = true;
  }
}

function rewrap(fileOrBlob, r) {
  if (!r.changed) return fileOrBlob;
  const type = fileOrBlob.type || '';
  if (typeof File === 'function' && typeof fileOrBlob.name === 'string') {
    return new File([r.out], fileOrBlob.name, { type, lastModified: fileOrBlob.lastModified ?? Date.now() });
  }
  return new Blob([r.out], { type });
}

/**
 * Metadata-free bytes for a File or Blob, preserving name/type/lastModified. LENIENT.
 *
 * Returns the INPUT UNCHANGED when the format has no strip implementation or nothing needed
 * dropping. THROWS if the bytes cannot be read — see the contract note in the header: this is a
 * privacy control, so "could not strip" must not silently become "uploaded the original".
 *
 * The unstrippable-container case is the ONE hole left open here, and it is only safe on a path
 * that has consciously accepted it. If your caller's comment says the bytes are guaranteed clean,
 * you want stripImageFileStrict.
 */
export async function stripImageFile(fileOrBlob) {
  if (!fileOrBlob || typeof fileOrBlob.size !== 'number') return fileOrBlob;
  const bytes = await readBytes(fileOrBlob);
  const r = stripImageBytes(bytes);
  if (!r.changed) {
    if (r.format === null) {
      console.warn(`imageMetadataStrip: ${fileOrBlob.type || 'unknown format'} has no strip implementation — bytes uploaded as-is`);
    }
    return fileOrBlob;
  }
  return rewrap(fileOrBlob, r);
}

/**
 * Metadata-free bytes, FAIL CLOSED. Identical to stripImageFile except that a container with no
 * strip implementation throws UnstrippableFormatError instead of passing through.
 *
 * `format === null` is the predicate, NOT `!changed`: a JPEG that had nothing to drop also reports
 * changed:false, and rejecting it would fail every already-clean photo. format is set to null only
 * by the unsupported-container return in stripImageBytes and by the not-a-JPEG/PNG/WebP guards.
 *
 * A non-Blob input throws too. Where stripImageFile hands it back untouched, this one cannot say
 * the bytes are clean, and "cannot say" is the whole thing this variant refuses to be quiet about.
 */
export async function stripImageFileStrict(fileOrBlob) {
  if (!fileOrBlob || typeof fileOrBlob.size !== 'number') {
    throw new UnstrippableFormatError(fileOrBlob?.type);
  }
  const bytes = await readBytes(fileOrBlob);
  const r = stripImageBytes(bytes);
  if (r.format === null) throw new UnstrippableFormatError(fileOrBlob.type);
  return rewrap(fileOrBlob, r);
}

export const __testing__ = { readOrientation, buildOrientationApp1, scanEntropy, KEEP_APP, KEEP_PNG, KEEP_WEBP };
