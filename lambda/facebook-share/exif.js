// exif.js — V4-FBSHARE-001. Pure, dependency-free, LOSSLESS JPEG metadata strip.
//
// Runs on the FB share path as privacy defence-in-depth (garden == home). The client
// imagePipeline already canvas-re-encodes resized photos to a bare EXIF-free JPEG, and 0/869 live
// rows carry DB GPS — but "already-small" / passthrough uploads retain their original bytes WITH
// EXIF, so we strip again server-side before any byte leaves for Facebook. FB also strips EXIF on
// upload; this is belt-and-suspenders, not the sole control.
//
// WHY byte-surgery and not sharp: re-encoding a JPEG re-compresses it (quality loss) and pulls in a
// heavy native dep + a libheif layer we do NOT need (Dave shoots OnePlus/Android JPEG; the corpus
// is 100% jpg). Dropping the APP1 segment is exact and reversible-free: EXIF *and* XMP both live in
// APP1, and that is where GPS/timestamps/device ids sit. Everything else (JFIF APP0, ICC APP2,
// quantization/Huffman tables, the entropy-coded scan) is preserved byte-for-byte.
//
// Never throws. A non-JPEG or a structurally weird file is returned UNCHANGED with isJpeg/flags set
// so the caller decides (the handler rejects non-JPEG with a clear error rather than posting it).

export function isJpeg(bytes) {
  return bytes && bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}

// Strip every APP1 (EXIF/XMP) segment. Returns { out, isJpeg, strippedApp1, strippedBytes }.
// Structure walked: SOI, then a run of marker segments, until SOS (0xDA) after which the
// entropy-coded image data + EOI are copied verbatim to the end.
export function stripJpegExif(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isJpeg(b)) return { out: b, isJpeg: false, strippedApp1: 0, strippedBytes: 0 };

  const parts = [];           // ordered Uint8Array views to keep
  let strippedApp1 = 0, strippedBytes = 0;
  const n = b.length;

  parts.push(b.subarray(0, 2)); // SOI
  let i = 2;
  while (i + 1 < n) {
    if (b[i] !== 0xFF) { parts.push(b.subarray(i)); break; }   // desync -> keep remainder verbatim
    let m = i + 1;
    while (m < n && b[m] === 0xFF) m++;                        // collapse fill bytes before the marker id
    if (m >= n) { parts.push(b.subarray(i)); break; }
    const marker = b[m];

    if (marker === 0xD9) { parts.push(b.subarray(i, m + 1)); break; }  // EOI
    if (marker === 0xDA) { parts.push(b.subarray(i)); break; }         // SOS -> scan + EOI to end, verbatim
    // Standalone markers with no length payload (RSTn / TEM) should not appear before SOS; keep and advance.
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { parts.push(b.subarray(i, m + 1)); i = m + 1; continue; }

    if (m + 2 >= n) { parts.push(b.subarray(i)); break; }              // truncated length -> bail verbatim
    const len = (b[m + 1] << 8) | b[m + 2];                            // length field INCLUDES its own 2 bytes
    const segEnd = m + 1 + len;
    if (len < 2 || segEnd > n) { parts.push(b.subarray(i)); break; }   // corrupt length -> bail verbatim

    if (marker === 0xE1) { strippedApp1++; strippedBytes += (segEnd - i); i = segEnd; continue; } // APP1 -> drop
    parts.push(b.subarray(i, segEnd));                                 // keep segment (incl leading FF/fill)
    i = segEnd;
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return { out, isJpeg: true, strippedApp1, strippedBytes };
}
