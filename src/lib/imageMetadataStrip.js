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
// AND THEN HEIC/AVIF STOPPED BEING UNSTRIPPABLE — BUG-HEICREALSTRIP-001. The two policies above
// were a way to live with a container this module could not walk. Dave declined to choose between
// them ("I do want it to be stripped ... I think refusing a photo upload is a terrible idea"), so
// the ISOBMFF walker below exists and both HEIC and AVIF now strip on both layers. That deletes
// the dilemma rather than resolving it: upload is lenient, share is fail-closed, and neither
// setting can cost a phone photo any more because every format a phone shoots has a walker. The
// two entry points remain, and still differ, for the containers that genuinely have none — a raw
// DNG, a TIFF, a file whose magic bytes match nothing.
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

// ---------------------------------------------------------------------------
// ISOBMFF — HEIC / HEIF / AVIF. BUG-HEICREALSTRIP-001.
//
// WHY THE OBVIOUS IMPLEMENTATION CORRUPTS THE FILE. These are not flat marker streams like JPEG;
// they are MP4-style box trees, and the metadata is not stored where it is declared. `meta` holds
// only DECLARATIONS — `iinf` names each item (`Exif`, a `mime` item holding XMP, the coded image
// itself) and `iloc` gives each one an ABSOLUTE FILE OFFSET into the `mdat` that follows. Measured
// on the fixture: the Exif payload occupies 572..812 and the XMP 812..1173, while the actual HEVC
// image sits at 1173..1220 — AFTER both. Delete the 601 metadata bytes and every later byte slides
// down, but `iloc` still says the image starts at 1173, which is now 601 bytes past where it is.
// The file stops decoding. That is why "just drop the box" works for JPEG and destroys a HEIC.
//
// SO WE DO NOT MOVE ANYTHING. Two operations, both offset-preserving by construction:
//   1. ZERO the metadata payload in place. Same bytes, same positions, contents destroyed. This is
//      the operation that actually removes the GPS, and it cannot invalidate an offset because no
//      byte changes address.
//   2. REMOVE the now-dangling declarations from `iinf`/`iloc`/`iref`, then pad each shrunken box
//      back to its EXACT original size with a `free` box (ISO/IEC 14496-12 §8.1.2 — a free-space
//      box is legal inside any container and readers must ignore it). `meta` keeps its size, so
//      `mdat` does not move, so nothing downstream needs rewriting.
// The invariant that falls out is worth stating because it is what makes this safe to ship:
// OUTPUT LENGTH == INPUT LENGTH, AND EVERY BOX IS AT ITS ORIGINAL OFFSET. The primary item's bytes
// are bit-identical at a bit-identical address, so a file that decoded before decodes after.
//
// The alternative — compact the file and rewrite `iloc` offsets (plus `stco`/`co64` if a `moov`
// rode along, as it does in an iPhone Live Photo) — buys back a few KB in a multi-MB file and puts
// every absolute offset in the container, including ones in boxes this module has never heard of,
// at the mercy of the rewriter being exhaustively right. Not worth it here.
//
// DENYLIST HERE, DELIBERATELY, WHERE JPEG IS AN ALLOWLIST. In JPEG an unrecognized segment is
// inert, so dropping everything unfamiliar is free. In ISOBMFF an unrecognized ITEM may be load-
// bearing — the tiles a `grid` derived image is assembled from, an alpha or depth auxiliary map —
// and dropping one changes the picture. So we remove only what is positively identified as
// metadata (`Exif`, and `mime`/`xml ` items carrying XMP), which is where exifr finds a location.
//
// ORIENTATION IS NOT THE LANDMINE IT IS IN JPEG. HEIF rotation lives in the `irot`/`imir`
// properties inside `iprp`/`ipco`, not in the Exif item — the fixture carries an `irot` and we
// never touch `ipco`. No orientation tag needs re-emitting here.
//
// FAIL CLOSED ON ANYTHING UNEXPECTED. Every parse guard below returns format:null, which puts the
// file back on the unstrippable path (share refuses it; upload passes it through as it does today)
// rather than emitting bytes we cannot vouch for.
const HEIF = 'heif';
const AVIF = 'avif';

// ftyp brands that mean "still image" (HEIF family + AVIF). A plain `isom`/`mp42` video is also
// ISOBMFF and must NOT be claimed as strippable: it has no `meta` item structure to work with.
const ISOBMFF_IMAGE_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'mif2', 'msf1', 'miaf', 'avif', 'avis', 'avio',
]);

// Item types that carry capture metadata and nothing a renderer needs.
const XMP_CONTENT_TYPES = /rdf\+xml|xmp|^(application|text)\/xml$/i;

const str4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const be16 = (b, p) => (b[p] << 8) | b[p + 1];
const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const rdN = (b, p, n) => { let x = 0; for (let k = 0; k < n; k++) x = x * 256 + b[p + k]; return x; };
const putN = (b, p, n, v) => { let x = v; for (let k = n - 1; k >= 0; k--) { b[p + k] = x & 0xFF; x = Math.floor(x / 256); } };

export function isIsobmff(b) {
  return b.length >= 12 && matchesId(b, 4, 'ftyp');
}

// AVIF or HEIF from major_brand + compatible_brands; null for a container that is neither.
function isobmffFormat(b) {
  const declared = be32(b, 0);
  const end = Math.min(declared >= 8 ? declared : b.length, b.length);
  let found = null;
  for (let p = 8; p + 4 <= end; p += 4) {
    if (p === 12) continue;                                  // minor_version, not a brand
    const brand = str4(b, p);
    if (!ISOBMFF_IMAGE_BRANDS.has(brand)) continue;
    if (brand.startsWith('avi')) return AVIF;                // AVIF wins; it is the more specific claim
    found = HEIF;
  }
  return found;
}

// One level of the box tree. Returns null — never a partial list — for anything that does not tile
// the range exactly, so a mis-parse can never be mistaken for a short file.
function scanBoxes(b, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = be32(b, i);
    let hdr = 8;
    if (size === 1) {                                        // 64-bit largesize
      if (i + 16 > end) return null;
      const hi = be32(b, i + 8);
      if (hi > 0x1FFFFF) return null;                        // past Number's exact-integer range
      size = hi * 4294967296 + be32(b, i + 12);
      hdr = 16;
    } else if (size === 0) {
      size = end - i;                                        // "extends to the end of the container"
    }
    if (size < hdr || i + size > end) return null;
    out.push({ type: str4(b, i + 4), at: i, size, hdr });
    i += size;
  }
  return i === end ? out : null;
}

// iinf: FullBox, then entry_count (16-bit at version 0, 32-bit after), then that many `infe`.
// Only infe version >= 2 carries item_type; the legacy v0/v1 form has none, so its items can never
// be classified as metadata and are therefore never removed.
function parseIinf(b, box) {
  const version = b[box.at + box.hdr];
  const countSize = version === 0 ? 2 : 4;
  const countAt = box.at + box.hdr + 4;
  const end = box.at + box.size;
  if (countAt + countSize > end) return null;
  const count = rdN(b, countAt, countSize);
  const entries = [];
  let p = countAt + countSize;
  for (let k = 0; k < count; k++) {
    if (p + 12 > end) return null;
    const size = be32(b, p);
    if (size < 12 || p + size > end || str4(b, p + 4) !== 'infe') return null;
    const iv = b[p + 8];
    const entry = { at: p, size, itemId: null, itemType: null, contentType: null };
    let q = p + 12;
    if (iv >= 2) {
      const idSize = iv === 2 ? 2 : 4;
      if (q + idSize + 6 > p + size) return null;
      entry.itemId = rdN(b, q, idSize);
      q += idSize + 2;                                       // + item_protection_index
      entry.itemType = str4(b, q);
      q += 4;
      let e = q;
      while (e < p + size && b[e] !== 0) e++;                // item_name
      q = e + 1;
      if (entry.itemType === 'mime') {
        let c = q;
        while (c < p + size && b[c] !== 0) c++;
        entry.contentType = String.fromCharCode(...b.subarray(q, c));
      }
    } else {
      if (q + 2 > p + size) return null;
      entry.itemId = be16(b, q);
    }
    entries.push(entry);
    p += size;
  }
  return { version, countAt, countSize, count, entries, entriesEnd: p, box };
}

// iloc: the offset table. Field widths are themselves declared in the box, and every one of them
// varies in the wild, so nothing here may assume the fixture's 4/4/0/0.
function parseIloc(b, box) {
  const version = b[box.at + box.hdr];
  const end = box.at + box.size;
  let p = box.at + box.hdr + 4;
  if (p + 2 > end) return null;
  const offSize = b[p] >> 4, lenSize = b[p] & 0x0F, baseSize = b[p + 1] >> 4;
  const idxSize = (version === 1 || version === 2) ? (b[p + 1] & 0x0F) : 0;
  p += 2;
  const countSize = version < 2 ? 2 : 4;
  const countAt = p;
  if (countAt + countSize > end) return null;
  const count = rdN(b, countAt, countSize);
  p += countSize;
  const items = [];
  for (let k = 0; k < count; k++) {
    const at = p;
    const idSize = version < 2 ? 2 : 4;
    if (p + idSize + 2 > end) return null;
    const itemId = rdN(b, p, idSize);
    p += idSize;
    let cm = 0;
    if (version === 1 || version === 2) { cm = be16(b, p) & 0x0F; p += 2; }
    if (p + 2 + baseSize + 2 > end) return null;
    const dri = be16(b, p);
    p += 2;
    const base = rdN(b, p, baseSize);
    p += baseSize;
    const extentCount = be16(b, p);
    p += 2;
    const extents = [];
    for (let e = 0; e < extentCount; e++) {
      if (p + idxSize + offSize + lenSize > end) return null;
      p += idxSize;
      const off = rdN(b, p, offSize);
      p += offSize;
      const len = rdN(b, p, lenSize);
      p += lenSize;
      extents.push({ off, len });
    }
    items.push({ at, len: p - at, itemId, cm, dri, base, extents });
  }
  return { version, countAt, countSize, count, items, itemsEnd: p, box };
}

// iref: a FullBox holding one box per reference, each naming the item it is FROM. Removing an Exif
// item leaves its `cdsc` ("this describes item N") pointing at nothing, so those go too.
function parseIref(b, box) {
  const version = b[box.at + box.hdr];
  const idSize = version === 0 ? 2 : 4;
  const end = box.at + box.size;
  const refs = [];
  let p = box.at + box.hdr + 4;
  while (p + 8 <= end) {
    const size = be32(b, p);
    if (size < 8 + idSize + 2 || p + size > end) return null;
    refs.push({ at: p, size, type: str4(b, p + 4), fromId: rdN(b, p + 8, idSize) });
    p += size;
  }
  return p === end ? { version, refs, refsStart: box.at + box.hdr + 4, box } : null;
}

function readPitm(b, box) {
  const version = b[box.at + box.hdr];
  const at = box.at + box.hdr + 4;
  const size = version === 0 ? 2 : 4;
  return at + size <= box.at + box.size ? rdN(b, at, size) : null;
}

function isMetadataItem(e) {
  if (e.itemType === 'Exif') return true;
  if (e.itemType === 'xml ') return true;                    // XMP carried as an XMLBox item
  if (e.itemType === 'mime') return XMP_CONTENT_TYPES.test(e.contentType || '');
  return false;
}

/**
 * Rebuild `box` with some of its variable-length tail removed, padded back to its ORIGINAL byte
 * length by a trailing `free` box so that nothing after it moves.
 *
 * Returns null when the reclaimed space is 1-7 bytes — too small to hold a box header, so the size
 * could not be preserved. Callers treat that as "skip the structural pass entirely" rather than
 * emitting a file whose declarations and offsets disagree.
 */
function shrinkBoxInPlace(b, box, prefixEnd, keptRanges, countPatch) {
  const prefix = b.slice(box.at, prefixEnd);
  let bodyLen = 0;
  for (const [s, e] of keptRanges) bodyLen += e - s;
  const newSize = prefix.length + bodyLen;
  const freed = box.size - newSize;
  if (freed === 0) return { bytes: null, freed: 0 };
  if (freed < 8) return null;
  putN(prefix, 0, 4, newSize);
  if (countPatch) putN(prefix, countPatch.at - box.at, countPatch.size, countPatch.value);
  const out = new Uint8Array(box.size);
  out.set(prefix, 0);
  let o = prefix.length;
  for (const [s, e] of keptRanges) { out.set(b.subarray(s, e), o); o += e - s; }
  putN(out, o, 4, freed);
  out[o + 4] = 0x66; out[o + 5] = 0x72; out[o + 6] = 0x65; out[o + 7] = 0x65;   // 'free'
  return { bytes: out, freed };
}

function resolveExtent(item, extent, idatBox) {
  if (!(extent.len > 0)) return null;              // length 0 means "to end of file"; not supported
  if (item.dri !== 0) return null;                 // data lives in an external file, per `dref`
  if (item.cm === 0) {
    const start = item.base + extent.off;
    return { start, end: start + extent.len };
  }
  if (item.cm === 1 && idatBox) {
    const start = idatBox.at + idatBox.hdr + item.base + extent.off;
    return { start, end: start + extent.len, idat: true };
  }
  return null;                                     // cm 2 — offsets relative to another item
}

/**
 * Strip capture metadata from a HEIC/HEIF/AVIF. Never throws.
 *
 * The output is the same length as the input and every box keeps its offset — see the header note
 * above; that is the whole safety argument, not an incidental property.
 */
export function stripIsobmffBytes(input) {
  const b = toBytes(input);
  const n = b.length;
  const miss = (reason, format = null) => ({
    out: b, changed: false, format, droppedSegments: 0, droppedBytes: 0,
    truncatedTrailer: 0, orientation: null, reason,
  });
  if (!isIsobmff(b)) return miss('not-isobmff');
  const format = isobmffFormat(b);
  if (!format) return miss('isobmff-not-an-image');

  const top = scanBoxes(b, 0, n);
  if (!top) return miss('bad-boxes');
  const metaBox = top.find((x) => x.type === 'meta');
  if (!metaBox) return miss('no-meta');
  // `meta` is a FullBox: 4 bytes of version+flags before its children.
  const kids = scanBoxes(b, metaBox.at + metaBox.hdr + 4, metaBox.at + metaBox.size);
  if (!kids) return miss('bad-meta');
  const kid = (t) => kids.find((x) => x.type === t);
  const iinfBox = kid('iinf'), ilocBox = kid('iloc'), idatBox = kid('idat'), irefBox = kid('iref');
  if (!iinfBox || !ilocBox) return miss('no-iinf-or-iloc');

  const iinf = parseIinf(b, iinfBox);
  if (!iinf) return miss('bad-iinf');
  const iloc = parseIloc(b, ilocBox);
  if (!iloc) return miss('bad-iloc');
  const iref = irefBox ? parseIref(b, irefBox) : null;
  if (irefBox && !iref) return miss('bad-iref');

  const pitmBox = kid('pitm');
  const primary = pitmBox ? readPitm(b, pitmBox) : null;

  // The primary item is exempt no matter what it claims to be — a file whose pitm points at an
  // `Exif` item is malformed, and removing the thing the picture IS would be the worst outcome here.
  const doomed = new Set();
  for (const e of iinf.entries) {
    if (e.itemId !== null && e.itemId !== primary && isMetadataItem(e)) doomed.add(e.itemId);
  }
  if (doomed.size === 0) return miss('no-metadata-items', format);

  // Where item data is allowed to live. Zeroing a range outside these would overwrite box headers.
  const mdatRanges = top.filter((x) => x.type === 'mdat').map((x) => ({ start: x.at + x.hdr, end: x.at + x.size }));
  const idatRange = idatBox ? [{ start: idatBox.at + idatBox.hdr, end: idatBox.at + idatBox.size }] : [];

  // Every byte of every item we are KEEPING. Nothing may be zeroed that touches one of these — the
  // guard against a mis-parse pointing us at the image instead of the metadata.
  const keepRanges = [];
  for (const it of iloc.items) {
    if (doomed.has(it.itemId)) continue;
    for (const x of it.extents) {
      const r = resolveExtent(it, x, idatBox);
      if (!r) return miss('unresolvable-kept-extent');       // cannot prove non-overlap; refuse
      keepRanges.push(r);
    }
  }

  const zeroRanges = [];
  for (const it of iloc.items) {
    if (!doomed.has(it.itemId)) continue;
    for (const x of it.extents) {
      const r = resolveExtent(it, x, idatBox);
      if (!r) return miss('unsupported-item-location');
      const containers = r.idat ? idatRange : mdatRanges;
      if (!containers.some((c) => r.start >= c.start && r.end <= c.end)) return miss('extent-outside-mdat');
      if (keepRanges.some((k) => r.start < k.end && k.start < r.end)) return miss('extent-overlaps-kept-item');
      zeroRanges.push(r);
    }
  }
  if (zeroRanges.length === 0) return miss('declared-but-unlocated');

  // ---- structural pass: drop the declarations, keep every box's size ----
  // All-or-nothing across the three boxes. A half-applied pass would leave `iloc` naming items that
  // `iinf` no longer describes, which is a worse file than one with tidy declarations over zeros.
  const infeKept = iinf.entries.filter((e) => !doomed.has(e.itemId)).map((e) => [e.at, e.at + e.size]);
  const ilocKept = iloc.items.filter((it) => !doomed.has(it.itemId)).map((it) => [it.at, it.at + it.len]);
  const edits = [];
  let freedBytes = 0;
  let structural = true;

  const pushEdit = (r, box) => {
    if (r === null) { structural = false; return; }
    if (r.bytes) { edits.push({ at: box.at, bytes: r.bytes }); freedBytes += r.freed; }
  };
  pushEdit(shrinkBoxInPlace(b, iinfBox, iinf.countAt + iinf.countSize, infeKept,
    { at: iinf.countAt, size: iinf.countSize, value: infeKept.length }), iinfBox);
  pushEdit(shrinkBoxInPlace(b, ilocBox, iloc.countAt + iloc.countSize, ilocKept,
    { at: iloc.countAt, size: iloc.countSize, value: ilocKept.length }), ilocBox);
  if (iref) {
    const refKept = iref.refs.filter((r) => !doomed.has(r.fromId)).map((r) => [r.at, r.at + r.size]);
    pushEdit(shrinkBoxInPlace(b, irefBox, iref.refsStart, refKept, null), irefBox);
  }

  const out = b.slice();
  if (structural) for (const e of edits) out.set(e.bytes, e.at);
  else freedBytes = 0;
  // The operation that actually destroys the GPS. Runs whether or not the structural pass applied,
  // because it is the one that does not depend on being able to rewrite a box.
  let zeroedBytes = 0;
  for (const r of zeroRanges) { out.fill(0, r.start, r.end); zeroedBytes += r.end - r.start; }

  return {
    out,
    changed: zeroedBytes > 0 || freedBytes > 0,
    format,
    droppedSegments: doomed.size,
    droppedBytes: zeroedBytes + freedBytes,
    truncatedTrailer: 0,
    orientation: null,
    reason: structural ? null : 'declarations-kept',
  };
}

/**
 * Strip by MAGIC BYTES, never by the declared MIME type — a content:// picker hands back junk
 * names and types, and a photo mislabelled image/png must not thereby skip the strip.
 * An unrecognized container returns unchanged with format:null; the caller decides.
 */
export function stripImageBytes(input) {
  const b = toBytes(input);
  if (isJpeg(b)) return stripJpegBytes(b);
  if (isPng(b)) return stripPngBytes(b);
  if (isWebp(b)) return stripWebpBytes(b);
  if (isIsobmff(b)) return stripIsobmffBytes(b);
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
 * Thrown by stripImageFileStrict for a container this module has no walker for — a raw DNG, a
 * TIFF, anything whose magic bytes match nothing. HEIC/AVIF used to land here and no longer do.
 *
 * `message` is written to be shown to a user as-is. Nothing surfaces it today: the only strict
 * caller is the share path, which catches it and counts the photo failed. It stays user-legible
 * because the alternative is a message that has to be rewritten the first time something does.
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
