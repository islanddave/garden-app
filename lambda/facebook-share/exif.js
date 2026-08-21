// exif.js — V4-FBSHARE-001, rewritten for BUG-FBSHAREDENYLIST-001. Pure, dependency-free, LOSSLESS
// JPEG metadata strip on the path that publishes a photo PUBLICLY, outside the household.
//
// This module is now a thin adapter over ./imageMetadataStrip.js — a byte-identical copy of the
// canonical src/lib/imageMetadataStrip.js that V4-PHOTOEXIFSTRIP-001 shipped on upload and on the
// client share sheet. It holds NO strip logic of its own, deliberately: the bug it fixes is that
// two strippers diverged, and a second implementation would diverge again.
//
// WHAT IT REPLACED, AND WHY THAT WAS NOT ENOUGH. The old version was a DENYLIST: drop APP1
// (EXIF/XMP), then at SOS copy the scan "+ EOI to the end" verbatim. Two holes, both measured on a
// phone-shaped 412-byte fixture in ./exif.trailer.test.js:
//   - Copying to the END means everything AFTER the primary EOI rides along. Samsung appends a raw
//     trailer there (MCC_Data311 = the SIM's mobile country code, Image_UTC_Data<epoch_ms>, and the
//     on-device DCIM path); Pixel appends a whole second JPEG (the Ultra HDR gain map). Trailers
//     were on 22 of 22 real originals sampled. None of it is EXIF, none of it is in any APP segment,
//     so naming markers can never reach it. 170 of those 412 bytes survived the old strip.
//   - Naming ONE marker leaks every other one: APP2 MPF (which indexes the appended gain map),
//     APP11 JUMBF (the C2PA container), APP13 Photoshop IRB (IPTC, which has its own GPS tags), and
//     COM. 322 of 412 bytes came out the far side.
// The replacement is an ALLOWLIST — keep only what a decoder needs (SOFn/DHT/DQT/DRI, the scan,
// JFIF/ICC/Adobe) — and TRUNCATE AT THE PRIMARY EOI, which is the only thing that removes a trailer
// no one has invented yet. Same fixture out the far side: 76 bytes, all seven needles gone.
//
// It is still LOSSLESS: nothing is decoded and nothing is re-encoded, so the pixels are bit-identical
// and no native dep (sharp/libheif) is pulled into a cold-start-sensitive Lambda.
//
// ORIENTATION IS ALSO FIXED HERE, incidentally but not accidentally. The old strip dropped APP1
// wholesale, and Orientation lives in APP1 — so a portrait phone photo went to the Facebook Page
// sideways. The canonical strip reads the tag out before discarding the segment and re-emits it as
// a minimal 36-byte APP1 carrying that one tag.
//
// Never throws. A non-JPEG is returned UNCHANGED (same reference) with isJpeg:false so the caller
// decides — index.js:119 rejects non-JPEG with a userFacing error before this is ever reached, so
// container formats (HEIC/AVIF, which a JPEG segment walker cannot strip) are not this file's
// problem on this path.
import { stripJpegBytes, isJpeg as isJpegBytes } from './imageMetadataStrip.js';

// Null-tolerant, unlike the canonical predicate: index.js feeds this straight from an S3 read.
export function isJpeg(bytes) {
  return !!bytes && typeof bytes.length === 'number' && isJpegBytes(bytes);
}

/**
 * Strip a JPEG to its renderable segments and truncate any post-EOI trailer.
 * @returns {{out: Uint8Array, isJpeg: boolean, droppedSegments: number, droppedBytes: number,
 *            truncatedTrailer: number, orientation: number|null, reason: string|null}}
 *
 * `droppedSegments` replaces the old `strippedApp1`: the strip no longer counts one named marker,
 * it counts everything that failed the allowlist. Callers used it as an anti-vacuity assertion
 * ("something was actually removed"), which the new name states more honestly.
 */
export function stripJpegExif(input) {
  const r = stripJpegBytes(input);
  return {
    out: r.out,
    isJpeg: r.format !== null,
    droppedSegments: r.droppedSegments,
    droppedBytes: r.droppedBytes,
    truncatedTrailer: r.truncatedTrailer,
    orientation: r.orientation,
    reason: r.reason,
  };
}
